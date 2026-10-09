import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client.js";
import { EXPERIMENT_ARCHIVE_MAX_BYTES, uploadExperimentPackage } from "../src/api/experimentPackages.js";
import { formatApiError } from "../src/utils/errors.js";

afterEach(() => vi.unstubAllGlobals());

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("experiment package upload size and response errors", () => {
  it.each([
    ["1 MiB", 1024 * 1024, true],
    ["exactly 16 MiB", EXPERIMENT_ARCHIVE_MAX_BYTES, true],
    ["16 MiB plus one byte", EXPERIMENT_ARCHIVE_MAX_BYTES + 1, false],
    ["20 MiB", 20 * 1024 * 1024, false],
    ["100 MiB", 100 * 1024 * 1024, false],
  ])("%s size boundary", async (_label, size, allowed) => {
    const fetchMock = vi.fn().mockResolvedValue(response(413, { error: { code: "EXPERIMENT_ARCHIVE_LIMIT", message: "ZIP 超过 16 MiB 上限" } }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["PK\x03\x04"], "boundary.zip", { type: "application/zip" });
    Object.defineProperty(file, "size", { value: size });
    await expect(uploadExperimentPackage("p-test", file)).rejects.toMatchObject({ code: "EXPERIMENT_ARCHIVE_LIMIT" });
    expect(fetchMock).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it("maps HTTP 413 to the specific file size guidance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(413, { status: "error", error: { code: "EXPERIMENT_ARCHIVE_LIMIT", message: "ZIP 超过 16 MiB 上限" } })));
    const file = new File(["x"], "slightly-large.zip", { type: "application/zip" });
    Object.defineProperty(file, "size", { value: EXPERIMENT_ARCHIVE_MAX_BYTES });
    await expect(uploadExperimentPackage("p-test", file)).rejects.toMatchObject({
      status: 413,
      code: "EXPERIMENT_ARCHIVE_LIMIT",
      message: expect.stringContaining("slightly-large.zip"),
    });
  });

  it.each([400, 401, 404, 500])("preserves HTTP %i business error classification", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status, { error: { code: `HTTP_${status}`, message: `业务错误 ${status}` } })));
    const file = new File(["PK\x03\x04"], "normal.zip", { type: "application/zip" });
    await expect(uploadExperimentPackage("p-test", file)).rejects.toMatchObject({ status, code: `HTTP_${status}`, message: `业务错误 ${status}` });
  });

  it("keeps network errors distinct and does not show ECONNABORTED details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("write ECONNABORTED")));
    const file = new File(["PK\x03\x04"], "normal.zip", { type: "application/zip" });
    const error = await uploadExperimentPackage("p-test", file).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("NETWORK_ERROR");
    expect(formatApiError(error)).toContain("无法连接 PaperTeam 后端服务");
    expect(formatApiError(error)).not.toContain("ECONNABORTED");
  });

  it("reports malformed and incomplete JSON responses as response errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    const file = new File(["PK\x03\x04"], "normal.zip", { type: "application/zip" });
    await expect(uploadExperimentPackage("p-test", file)).rejects.toMatchObject({ status: 500, code: "INVALID_RESPONSE" });
  });
});
