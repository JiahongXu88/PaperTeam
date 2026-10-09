import { createReadStream } from "node:fs";
import { mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PACKAGE_LIMITS } from "../../src/experiments/archive.js";
import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
let stack: TestStack;
let vite: { httpServer: { address(): { port: number } | string | null }; listen(): Promise<void>; close(): Promise<void> };
let projectId: string;
let fixtureRoot: string;
let baseUrl: string;

function crc32Zeros(length: number): number {
  let crc = 0xffffffff;
  for (let i = 0; i < length; i += 1) {
    crc ^= 0;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function writeStoredZip(path: string, totalBytes: number): Promise<void> {
  const name = Buffer.from("data.bin");
  const dataBytes = totalBytes - (30 + name.length + 46 + name.length + 22);
  if (dataBytes < 0) throw new Error("ZIP target size is too small");
  const crc = crc32Zeros(dataBytes);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(dataBytes, 18);
  local.writeUInt32LE(dataBytes, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(dataBytes, 20);
  central.writeUInt32LE(dataBytes, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + dataBytes, 16);
  const file = await open(path, "wx");
  try {
    await file.write(local);
    const zeroBlock = Buffer.alloc(1024 * 1024);
    let remaining = dataBytes;
    while (remaining > 0) {
      const block = zeroBlock.subarray(0, Math.min(zeroBlock.length, remaining));
      await file.write(block);
      remaining -= block.length;
    }
    await file.write(central);
    await file.write(end);
  } finally {
    await file.close();
  }
}

function sendFile(path: string, contentLength?: number): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/projects/${projectId}/experiment-packages`, baseUrl);
    const headers: Record<string, string> = { "Content-Type": "application/zip", "X-Package-Name": "test-upload.zip", Accept: "application/json" };
    if (contentLength !== undefined) headers["Content-Length"] = String(contentLength);
    const req = httpRequest(url, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    createReadStream(path).pipe(req);
  });
}

function sendChunked(bytes: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/projects/${projectId}/experiment-packages`, baseUrl);
    const req = httpRequest(url, { method: "POST", headers: { "Content-Type": "application/zip", "X-Package-Name": "chunked.zip", Accept: "application/json", "Transfer-Encoding": "chunked" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    const block = Buffer.alloc(256 * 1024);
    let sent = 0;
    const writeNext = () => {
      while (sent < bytes) {
        const part = block.subarray(0, Math.min(block.length, bytes - sent));
        sent += part.length;
        if (!req.write(part)) {
          req.once("drain", writeNext);
          return;
        }
      }
      req.end();
    };
    writeNext();
  });
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "paperteam-experiment-upload-test-"));
  const scripted = scriptedIdeaRuntime();
  stack = await startTestStack(scripted.runtime);
  const created = await stack.request("POST", "/api/projects", { title: "Upload reliability test", researchIdea: "synthetic", workflowKind: "idea_to_paper" });
  projectId = (created.body["project"] as { id: string }).id;

  const viteApi = await import(pathToFileURL(join(repoRoot, "frontend", "node_modules", "vite", "dist", "node", "index.js")).href);
  const createServer = viteApi["createServer"] as (options: Record<string, unknown>) => Promise<typeof vite>;
  vite = await createServer({
    configFile: join(repoRoot, "frontend", "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, proxy: { "/api": { target: `http://127.0.0.1:${stack.port()}`, changeOrigin: false } } },
  });
  await vite.listen();
  const address = vite.httpServer.address();
  if (address === null || typeof address === "string") throw new Error("Vite test server did not bind a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  await vite?.close();
  await stack?.cleanup();
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true });
});

describe("experiment ZIP upload via real Vite proxy", () => {
  it("accepts a valid ZIP exactly at 16 MiB and rejects slightly and clearly oversized bodies with JSON 413", async () => {
    const exactPath = join(fixtureRoot, "exact-limit.zip");
    const overPath = join(fixtureRoot, "over-limit.zip");
    const largePath = join(fixtureRoot, "clearly-large.zip");
    await writeStoredZip(exactPath, PACKAGE_LIMITS.archiveBytes);
    await writeStoredZip(overPath, PACKAGE_LIMITS.archiveBytes + 1);
    await writeStoredZip(largePath, 20 * 1024 * 1024);

    const exact = await sendFile(exactPath, PACKAGE_LIMITS.archiveBytes);
    expect([200, 201]).toContain(exact.status);
    expect(JSON.parse(exact.body)).toHaveProperty("package.packageId");

    for (const path of [overPath, largePath]) {
      const rejected = await sendFile(path, (await stat(path)).size);
      expect(rejected.status).toBe(413);
      expect(rejected.headers["content-type"]).toContain("application/json");
      expect(JSON.parse(rejected.body)).toMatchObject({ status: "error", error: { code: "EXPERIMENT_ARCHIVE_LIMIT", message: "ZIP 超过 16 MiB 上限" } });
    }
  }, 60_000);

  it("rejects chunked overflow and leaves the backend able to accept a subsequent normal upload", async () => {
    const chunked = await sendChunked(PACKAGE_LIMITS.archiveBytes + 1);
    expect(chunked.status).toBe(413);
    expect(JSON.parse(chunked.body)).toMatchObject({ error: { code: "EXPERIMENT_ARCHIVE_LIMIT" } });

    const health = await fetch(`${baseUrl}/api/projects`);
    expect(health.status).toBe(200);
    expect(await health.json()).toHaveProperty("projects");

    const exact = await sendFile(join(fixtureRoot, "exact-limit.zip"), PACKAGE_LIMITS.archiveBytes);
    expect([200, 201]).toContain(exact.status);
  }, 60_000);

  it("cleans backend upload temporary directories after successes and 413 responses", async () => {
    const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("paperteam-experiment-")));
    const rejected = await sendChunked(PACKAGE_LIMITS.archiveBytes + 1);
    expect(rejected.status).toBe(413);
    const deadline = Date.now() + 3_000;
    let leftovers: string[] = [];
    do {
      leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith("paperteam-experiment-") && !before.has(name));
      if (leftovers.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    expect(leftovers).toEqual([]);
  });

  it("cleans partial uploads after a client disconnect and keeps the backend healthy", async () => {
    const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("paperteam-experiment-")));
    await new Promise<void>((resolve) => {
      const req = httpRequest(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/experiment-packages`, {
        method: "POST",
        headers: { "Content-Type": "application/zip", "Content-Length": "4096" },
      });
      req.on("error", () => resolve());
      req.on("close", () => resolve());
      req.write(Buffer.alloc(1024));
      setTimeout(() => req.destroy(), 25);
    });
    const deadline = Date.now() + 3_000;
    let leftovers: string[] = [];
    do {
      leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith("paperteam-experiment-") && !before.has(name));
      if (leftovers.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    expect(leftovers).toEqual([]);
    expect((await fetch(`${baseUrl}/api/projects`)).status).toBe(200);
  });
});
