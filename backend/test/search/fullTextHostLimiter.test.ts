/**
 * M13.8：按主机的全文下载节流（arXiv 串行 + 最小间隔），防止并发下载在代理出口被节流后
 * 一瞬间触发共享熔断。全部离线：fake ProviderHttpClient.fetchBytes 记录在途数。
 */

import { describe, expect, it } from "vitest";

import { HostDownloadLimiter, downloadPdf } from "../../src/search/fullText.js";
import type { ProviderHttpClient } from "../../src/search/providerHttp.js";

const PDF = Buffer.from("%PDF-1.4 fake");

function fakeHttp(record: { inflight: number; maxInflight: number; starts: number[] }, delayMs = 20) {
  return {
    fetchBytes: async () => {
      record.inflight += 1;
      record.maxInflight = Math.max(record.maxInflight, record.inflight);
      record.starts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      record.inflight -= 1;
      return { bytes: PDF, contentType: "application/pdf" };
    },
  } as unknown as ProviderHttpClient;
}

describe("HostDownloadLimiter / downloadPdf 节流", () => {
  it("arxiv.org：同时只放 1 路，起始间隔 ≥ minIntervalMs；export.arxiv.org 共用同一队列", async () => {
    const record = { inflight: 0, maxInflight: 0, starts: [] as number[] };
    const limiter = new HostDownloadLimiter([{ hosts: ["arxiv.org", "export.arxiv.org"], policy: { maxConcurrent: 1, minIntervalMs: 30 } }]);
    const http = fakeHttp(record);
    await Promise.all([
      downloadPdf("https://arxiv.org/pdf/0001.00001", { http, limiter }),
      downloadPdf("https://arxiv.org/pdf/0001.00002", { http, limiter }),
      downloadPdf("https://export.arxiv.org/pdf/0001.00003", { http, limiter }),
      downloadPdf("https://arxiv.org/pdf/0001.00004", { http, limiter }),
    ]);
    expect(record.maxInflight).toBe(1);
    const sorted = [...record.starts].sort((a, b) => a - b);
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index]! - sorted[index - 1]!).toBeGreaterThanOrEqual(25);
    }
    expect(limiter.inflight("arxiv.org")).toBe(0);
  });

  it("无策略主机不受限（并发照常）；取消等待中的下载如实报取消", async () => {
    const record = { inflight: 0, maxInflight: 0, starts: [] as number[] };
    const limiter = new HostDownloadLimiter([{ hosts: ["arxiv.org"], policy: { maxConcurrent: 1, minIntervalMs: 1_000 } }]);
    const http = fakeHttp(record, 30);
    await Promise.all([
      downloadPdf("https://journals.example.org/a.pdf", { http, limiter }),
      downloadPdf("https://journals.example.org/b.pdf", { http, limiter }),
      downloadPdf("https://other.example.net/c.pdf", { http, limiter }),
    ]);
    expect(record.maxInflight).toBe(3);

    const slow = fakeHttp({ inflight: 0, maxInflight: 0, starts: [] }, 200);
    const first = downloadPdf("https://arxiv.org/pdf/1", { http: slow, limiter });
    const controller = new AbortController();
    const second = downloadPdf("https://arxiv.org/pdf/2", { http: slow, limiter, signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: "FULLTEXT_DOWNLOAD_FAILED", message: expect.stringContaining("取消") });
    await first;
    expect(limiter.inflight("arxiv.org")).toBe(0);
  });

  it("下载抛错也释放许可（后续下载不会永久排队）", async () => {
    const limiter = new HostDownloadLimiter([{ hosts: ["arxiv.org"], policy: { maxConcurrent: 1, minIntervalMs: 0 } }]);
    const failing = { fetchBytes: async () => { throw new Error("boom"); } } as unknown as ProviderHttpClient;
    await expect(downloadPdf("https://arxiv.org/pdf/1", { http: failing, limiter })).rejects.toMatchObject({ code: "FULLTEXT_DOWNLOAD_FAILED" });
    const record = { inflight: 0, maxInflight: 0, starts: [] as number[] };
    await downloadPdf("https://arxiv.org/pdf/2", { http: fakeHttp(record, 1), limiter });
    expect(record.starts).toHaveLength(1);
  });
});
