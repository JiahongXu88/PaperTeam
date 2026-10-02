/**
 * M11.1.1 Survey Matrix artifact 持久化测试：
 * round-trip / 确定性序列化 / 容错读取 / 损坏与版本 fail-closed。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { BusinessError } from "../../src/errors.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SurveyMatrixArtifactStore } from "../../src/survey/surveyArtifacts.js";
import {
  DEFAULT_SURVEY_TAXONOMY,
  matrixEntryId,
  type SurveyMatrixArtifact,
  type SurveyMatrixEntry,
} from "../../src/survey/matrixTypes.js";

function sampleEntry(sourceId: string, overrides: Partial<SurveyMatrixEntry> = {}): SurveyMatrixEntry {
  return {
    entryId: matrixEntryId(sourceId),
    sourceId,
    interpretationDepth: "fulltext",
    methodFamily: "tracking_association",
    mainIdea: "低分检测框参与二次关联。",
    anchors: [{ field: "mainIdea", chunkIds: [`${sourceId}:sec1:0001:0123456789`] }],
    status: "draft",
    updatedAt: "2026-10-02T08:00:00.000Z",
    ...overrides,
  };
}

function sampleArtifact(): SurveyMatrixArtifact {
  return {
    schemaVersion: 1,
    updatedAt: "2026-10-02T08:00:00.000Z",
    taxonomy: DEFAULT_SURVEY_TAXONOMY,
    entries: [sampleEntry("S002"), sampleEntry("S001"), sampleEntry("S003")],
  };
}

async function newStore(): Promise<{
  store: SurveyMatrixArtifactStore;
  projects: ProjectStore;
  projectId: string;
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-survey-artifact-"));
  const projects = new ProjectStore({ root });
  const project = await projects.create("artifact 测试");
  return {
    store: new SurveyMatrixArtifactStore(projects),
    projects,
    projectId: project.id,
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("SurveyMatrixArtifactStore", () => {
  it("未构建 → read 返回 null（与「损坏」区分）", async () => {
    const fixture = await newStore();
    try {
      expect(await fixture.store.read(fixture.projectId)).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("write → read round-trip：条目按 sourceId 排序，字段完整", async () => {
    const fixture = await newStore();
    try {
      await fixture.store.write(fixture.projectId, sampleArtifact());
      const read = await fixture.store.read(fixture.projectId);
      expect(read).not.toBeNull();
      expect(read!.entries.map((entry) => entry.sourceId)).toEqual(["S001", "S002", "S003"]);
      expect(read!.entries[0]!.entryId).toBe("M-S001");
      expect(read!.entries[0]!.anchors[0]!.chunkIds[0]).toBe("S001:sec1:0001:0123456789");
      expect(read!.taxonomy.families.length).toBeGreaterThan(0);
      expect(read!.schemaVersion).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("确定性序列化：同内容两次写产生字节相同的文件", async () => {
    const fixture = await newStore();
    try {
      const path = join(fixture.projects.researchDir(fixture.projectId), "survey.json");
      await fixture.store.write(fixture.projectId, sampleArtifact());
      const first = await readFile(path, "utf8");
      await fixture.store.write(fixture.projectId, sampleArtifact());
      const second = await readFile(path, "utf8");
      expect(second).toBe(first);
      // 条目输入顺序不同 → 落盘仍同序（排序确定性）
      const reordered: SurveyMatrixArtifact = {
        ...sampleArtifact(),
        entries: [...sampleArtifact().entries].reverse(),
      };
      await fixture.store.write(fixture.projectId, reordered);
      const third = await readFile(path, "utf8");
      expect(third).toBe(first);
    } finally {
      await fixture.cleanup();
    }
  });

  it("损坏 JSON → SURVEY_MATRIX_CORRUPTED（不静默当空矩阵）", async () => {
    const fixture = await newStore();
    try {
      const path = join(fixture.projects.researchDir(fixture.projectId), "survey.json");
      await writeFile(path, "{ not json", "utf8");
      await expect(fixture.store.read(fixture.projectId)).rejects.toMatchObject({
        code: "SURVEY_MATRIX_CORRUPTED",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("缺少 entries / 非对象内容 → SURVEY_MATRIX_CORRUPTED", async () => {
    const fixture = await newStore();
    try {
      const path = join(fixture.projects.researchDir(fixture.projectId), "survey.json");
      await writeFile(path, JSON.stringify({ schemaVersion: 1, taxonomy: DEFAULT_SURVEY_TAXONOMY }), "utf8");
      await expect(fixture.store.read(fixture.projectId)).rejects.toBeInstanceOf(BusinessError);
      await expect(fixture.store.read(fixture.projectId)).rejects.toMatchObject({
        code: "SURVEY_MATRIX_CORRUPTED",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("未来 schemaVersion → 拒绝解读（不降级猜测）", async () => {
    const fixture = await newStore();
    try {
      const path = join(fixture.projects.researchDir(fixture.projectId), "survey.json");
      await writeFile(
        path,
        JSON.stringify({ ...sampleArtifact(), schemaVersion: 99 }),
        "utf8",
      );
      await expect(fixture.store.read(fixture.projectId)).rejects.toMatchObject({
        code: "SURVEY_MATRIX_CORRUPTED",
        detail: expect.stringContaining("schemaVersion"),
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("tolerant read：形状不完整的历史条目被剔除，其余条目保留", async () => {
    const fixture = await newStore();
    try {
      const path = join(fixture.projects.researchDir(fixture.projectId), "survey.json");
      const artifact = sampleArtifact();
      const tolerant = {
        ...artifact,
        entries: [
          ...artifact.entries,
          { sourceId: "S009" }, // 缺 entryId / interpretationDepth / anchors
          "garbage-string",
          null,
        ],
      };
      await writeFile(path, JSON.stringify(tolerant), "utf8");
      const read = await fixture.store.read(fixture.projectId);
      // read 忠实保留文件内顺序（排序是 write 的职责）；坏行被剔除
      expect(read!.entries.map((entry) => entry.sourceId)).toEqual(["S002", "S001", "S003"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("taxonomy 缺失 / 为空 → 拒绝（矩阵不能没有受控词表）", async () => {
    const fixture = await newStore();
    try {
      const path = join(fixture.projects.researchDir(fixture.projectId), "survey.json");
      const artifact = sampleArtifact();
      await writeFile(path, JSON.stringify({ ...artifact, taxonomy: { families: [] } }), "utf8");
      await expect(fixture.store.read(fixture.projectId)).rejects.toMatchObject({
        code: "SURVEY_MATRIX_CORRUPTED",
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
