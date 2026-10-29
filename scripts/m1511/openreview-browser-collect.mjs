#!/usr/bin/env node
/**
 * M15.11 — OpenReview in-browser collection runner.
 *
 * Drives the api2.openreview.net page inside a REAL Chrome (temp profile):
 * all API reads are same-origin `fetch` calls executed in the page, carrying
 * the session's challenge cookies automatically, paced politely. CDP is used
 * only to evaluate these fetches and read results — the browser itself is not
 * automated (no automation flags), and the human passes the Turnstile check
 * when required (the intended verification path).
 *
 * Usage: node openreview-browser-collect.mjs <jobfile.json>
 *   jobfile: { "steps": [ { "id": "...", "url": "/notes?...", "kind": "json" | "pdf" } ] }
 * Results: written to collect-out/<id>.json (json) or collect-out/<id>.pdf (pdf bytes)
 *          + collect-log.jsonl appended per step (status, ms, bytes).
 * A "challenge" step result is emitted when the fetch returns 403 — the runner
 * then pauses, opens the challenge page in the same tab, waits for the human
 * to clear it, and retries the step.
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir, rm, readFile, appendFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "collect-out");
const logPath = resolve(here, "collect-log.jsonl");
const profileDir = resolve(here, "or-chrome-profile");
const debugPort = 9333;
const PACING_MS = 1100; // polite inter-request delay (in-page)

const jobFile = process.argv[2];
if (!jobFile) {
  console.error("usage: node openreview-browser-collect.mjs <jobfile.json>");
  process.exit(1);
}
const job = JSON.parse(await readFile(jobFile, "utf8"));
await mkdir(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- CDP plumbing ----------
const seq = { n: 0 };
const pending = new Map();
let ws = null;
let activeSessionId = null;

function cdp(method, params = {}) {
  const id = ++seq.n;
  const msg = { id, method, params };
  if (activeSessionId && !params.__browserLevel) msg.sessionId = activeSessionId;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), 600_000);
    pending.set(id, { res, rej, timer });
    ws.send(JSON.stringify(msg));
  });
}

async function attach() {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i += 1) {
    try {
      ver = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    } catch {
      await sleep(500);
    }
  }
  if (!ver) throw new Error("cannot reach chrome debug port");
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.rej(new Error(msg.error.message));
      else p.res(msg.result);
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", (e) => rej(new Error("ws error")));
    setTimeout(() => rej(new Error("ws open timeout")), 10_000);
  });
  // find or create the api2 page target
  let { targetInfos } = await cdp("Target.getTargets", { __browserLevel: true });
  let page = targetInfos.find((t) => t.type === "page" && t.url.startsWith("https://api2.openreview.net/"));
  if (!page) {
    page = targetInfos.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  }
  const { sessionId } = await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true, __browserLevel: true });
  activeSessionId = sessionId;
  return sessionId;
}

async function evalInPage(expression, awaitPromise = true) {
  const r = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error("page eval exception: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  }
  return r.result?.value;
}

const FETCH_JSON = `(async (url) => {
  const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 25_000_000) };
})`;

const FETCH_PDF = `(async (url) => {
  const res = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { status: res.status, body: text.slice(0, 2000) };
  }
  const buf = await res.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return { status: 200, b64: btoa(binary), size: bytes.length };
})`;

async function navigate(url) {
  await cdp("Page.navigate", { url });
  await sleep(2_500);
}

async function waitForClearance(maxMs = 300_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const state = await evalInPage(
      `(async () => {
        try {
          const res = await fetch("https://api2.openreview.net/notes?content.venueid=${encodeURIComponent("ICLR.cc/2024/Conference")}&limit=1", { credentials: "include", headers: { Accept: "application/json" } });
          return { ok: res.ok, status: res.status };
        } catch (e) { return { ok: false, status: 0 }; }
      })()`,
    );
    if (state?.ok) return true;
    console.log(`[collect] not cleared yet (status=${state?.status}); open the Chrome window and complete the verification if shown`);
    await sleep(5_000);
  }
  return false;
}

// ---------- main ----------
const freshProfile = !existsSync(profileDir);
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "--window-size=760,860",
    "https://openreview.net/challenge?redirect=https%3A%2F%2Fapi2.openreview.net%2Fnotes%3Flimit%3D1",
  ],
  { stdio: "ignore" },
);
console.log(`[collect] Chrome pid=${chrome.pid} (profile persisted: ${!freshProfile})`);
if (freshProfile) {
  console.log("[collect] FIRST RUN: complete the 'Verify you are human' check in the Chrome window once.");
}

try {
  await attach();
  console.log("[collect] attached; waiting for clearance…");
  const cleared = await waitForClearance();
  if (!cleared) throw new Error("challenge not cleared within 5 minutes");
  await navigate("https://api2.openreview.net/notes?content.venueid=" + encodeURIComponent("ICLR.cc/2024/Conference") + "&limit=1");
  console.log("[collect] clearance OK — running steps");

  for (const step of job.steps) {
    if (step.skipIfOutput) {
      const out = resolve(outDir, `${step.id}.json`);
      if (existsSync(out)) {
        console.log(`[collect] ${step.id}: cached, skipping`);
        continue;
      }
    }
    const url = `https://api2.openreview.net${step.url}`;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      console.log();
      const t0 = Date.now();
      const expr =
        step.kind === "pdf"
          ? `${FETCH_PDF}(${JSON.stringify(url)})`
          : `${FETCH_JSON}(${JSON.stringify(url)})`;
      let r;
      try {
        r = await evalInPage(expr);
      } catch (e) {
        r = { status: 0, body: String(e.message) };
      }
      const ms = Date.now() - t0;
      if (r?.status === 200 || r?.status === 400) {
        if (step.kind === "pdf" && r.b64) {
          await writeFile(resolve(outDir, `${step.id}.pdf`), Buffer.from(r.b64, "base64"));
        } else if (step.kind === "pdf") {
          // non-200 pdf → save error json
          await writeFile(resolve(outDir, `${step.id}.err.json`), r.body ?? "");
        } else {
          await writeFile(resolve(outDir, `${step.id}.json`), r.body ?? "", "utf8");
        }
        await appendFile(
          logPath,
          JSON.stringify({ id: step.id, status: r.status, ms, bytes: r.size ?? (r.body?.length ?? 0), attempt }) + "\n",
          "utf8",
        );
        console.log(`[collect] ${step.id}: ${r.status} ${ms}ms${r.size ? ` ${r.size}B` : ""}`);
        break;
      }
      if ((r?.status === 403 || r?.status === 429 || r?.status === 0) && attempt <= 4) {
        console.log(`[collect] ${step.id}: status ${r.status} attempt ${attempt} — waiting for clearance (click check in Chrome if shown)…`);
        await navigate(`https://openreview.net/challenge?redirect=${encodeURIComponent("https://api2.openreview.net/notes?limit=1")}`);
        const ok = await waitForClearance();
        if (!ok) throw new Error("challenge not cleared during retry");
        continue;
      }
      await appendFile(logPath, JSON.stringify({ id: step.id, status: r?.status, ms, failed: true, body: (r?.body ?? "").slice(0, 300) }) + "\n", "utf8");
      console.log(`[collect] ${step.id}: FAILED status=${r?.status}`);
      break;
    }
    await sleep(PACING_MS);
  }
  console.log("[collect] done");
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(1_500);
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
