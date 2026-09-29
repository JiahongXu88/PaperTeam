/**
 * M10.1.1 Parser Registry 单测：扩展名 → 资产大类 / 语言 / 存储 kind / MIME。
 * Registry 是查表函数——这里锁的是「新增格式不改业务层」的表完整性。
 */

import { describe, expect, it } from "vitest";

import {
  assetKindOfFileName,
  CODE_EXTENSIONS,
  defaultMimeOfAssetKind,
  documentKindOfAssetKind,
  languageOfFileName,
} from "../../src/ingestion/parserRegistry.js";

describe("M10.1.1 parserRegistry", () => {
  it("扩展名 → 资产大类全覆盖（M10.1 既有 + M10.1.1 新增）", () => {
    const cases: Array<[string, string]> = [
      ["paper.pdf", "pdf"],
      ["results.csv", "csv"],
      ["results.xlsx", "xlsx"],
      ["notes.txt", "text"],
      ["README.md", "markdown"],
      ["paper.tex", "latex"],
      ["config.json", "json"],
      ["experiment.yaml", "yaml"],
      ["experiment.yml", "yaml"],
      ["analysis.ipynb", "notebook"],
      ["figure.png", "image"],
      ["figure.JPG", "image"], // 大小写不敏感
      ["photo.jpeg", "image"],
      ["train.py", "code"],
      ["helper.cpp", "code"],
      ["main.ts", "code"],
      ["main.rs", "code"],
      ["main.go", "code"],
      ["Main.java", "code"],
      ["run.sh", "code"],
      ["deploy.ps1", "code"],
      ["notes.docx", "other"], // 第一版明确不支持 Word
      ["archive.zip", "other"],
      ["references.bib", "other"],
      ["data", "other"],
    ];
    for (const [name, expected] of cases) {
      expect(assetKindOfFileName(name), name).toBe(expected);
    }
  });

  it("源码语言映射", () => {
    expect(languageOfFileName("train.py")).toBe("python");
    expect(languageOfFileName("helper.cpp")).toBe("cpp");
    expect(languageOfFileName("types.d.ts")).toBe("typescript");
    expect(languageOfFileName("app.jsx")).toBe("javascript");
    expect(languageOfFileName("notes.txt")).toBeUndefined();
    expect(languageOfFileName("config.json")).toBeUndefined();
  });

  it("资产大类 → 存储 kind（csv/xlsx 归 tabular；其余一一对应；other 边界）", () => {
    expect(documentKindOfAssetKind("pdf")).toBe("pdf");
    expect(documentKindOfAssetKind("csv")).toBe("tabular");
    expect(documentKindOfAssetKind("xlsx")).toBe("tabular");
    expect(documentKindOfAssetKind("notebook")).toBe("notebook");
    expect(documentKindOfAssetKind("image")).toBe("image");
    expect(documentKindOfAssetKind("other")).toBe("other");
  });

  it("缺省 MIME 表", () => {
    expect(defaultMimeOfAssetKind("pdf")).toBe("application/pdf");
    expect(defaultMimeOfAssetKind("markdown")).toBe("text/markdown");
    expect(defaultMimeOfAssetKind("notebook")).toBe("application/x-ipynb+json");
    expect(defaultMimeOfAssetKind("yaml")).toBe("application/yaml");
    // image 缺省 octet-stream：实际 mime 由 parser 内容签名覆写（png/jpeg）
    expect(defaultMimeOfAssetKind("image")).toBe("application/octet-stream");
  });

  it("CODE_EXTENSIONS 与语言映射一致（无孤儿扩展名）", () => {
    for (const extension of CODE_EXTENSIONS) {
      expect(languageOfFileName(`file${extension}`), extension).toBeDefined();
    }
  });
});
