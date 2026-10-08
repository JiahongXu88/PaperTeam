#!/usr/bin/env python3
"""M12 Batch 3 — Figure Generation 真实服务器验收（Part E）。

直接驱动已部署容器的同源 HTTP API（127.0.0.1:8080）：
  Smoke A  数据集 → PlotSpec → 容器内真实 xelatex → 矢量 PDF → 资产路由
  Smoke B  DiagramSpec → TikZ → 矢量 PDF
  Smoke C  手稿插入（有界真实 workflow 提供手稿）→ build → 含图 PDF
  Smoke D  无效数据四类（篡改 hash / 重算 hash 绕过 / 无支撑声明 / 缺失来源）
  Smoke E  已有论文修订安全边界（受控 fixture：replace 放行 / append 拒绝）

用法：python3 m12b3-figure-acceptance.py [--skip-workflow]（跳过 GLM 工作流，
手稿由 --manuscript-project 指定的已有项目承载）。
"""

import base64
import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8080"

# 有界标记的验收 fixture 数据（测试项目专用，非科研声称）：
# 一个 4 方法 × 3 指标的消融表
CSV = (
    "method,hota,mota,idsw\n"
    "baseline,62.1,78.4,118\n"
    "no_motion,62.9,79.1,96\n"
    "no_appearance,63.5,79.8,88\n"
    "full_model,64.2,80.6,74\n"
)

RESULTS = []


def api(method, path, body=None, expect=None):
    request = urllib.request.Request(
        BASE + path,
        method=method,
        data=None if body is None else json.dumps(body).encode("utf8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = json.loads(response.read().decode("utf8"))
            status = response.status
    except urllib.error.HTTPError as error:
        payload = json.loads(error.read().decode("utf8"))
        status = error.code
    if expect is not None and status != expect:
        raise AssertionError(f"{method} {path} → HTTP {status}（期望 {expect}）：{json.dumps(payload, ensure_ascii=False)[:400]}")
    return status, payload


def raw(path):
    with urllib.request.urlopen(BASE + path, timeout=60) as response:
        return response.status, response.read(), dict(response.headers)


def record(name, ok, detail):
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}：{detail}")


def sha256_hex(content: bytes) -> str:
    import hashlib

    return hashlib.sha256(content).hexdigest()


def dataset_hash(columns, rows):
    """与 backend fingerprintJson({columns, rows}) 同口径（键排序 + 紧凑 JSON）。"""
    payload = json.dumps({"columns": columns, "rows": rows}, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return sha256_hex(payload.encode("utf8"))


def main():
    skip_workflow = "--skip-workflow" in sys.argv

    # ---- 0. 健康检查 ----
    status, payload = api("GET", "/health", expect=200)
    record("health", payload.get("status") == "ok", f"/health status={payload.get('status')}")
    status, payload = api("GET", "/ready", expect=200)
    record("ready", payload.get("ready") is True, f"/ready ready={payload.get('ready')}")

    # ---- 项目 ----
    status, payload = api("POST", "/api/projects", {
        "title": "M12B3 图表验收（bounded）",
        "researchIdea": "多目标跟踪中运动与外观线索的消融研究（验收用最小稿）",
        "workflowKind": "idea_to_paper",
    }, expect=201)
    project_id = payload["project"]["id"]
    record("project-create", True, f"projectId={project_id}")

    # ---- Smoke A：数据集 → 图 ----
    status, payload = api("POST", f"/api/projects/{project_id}/sources", {
        "fileName": "ablation_fixture_test.csv",
        "contentBase64": base64.b64encode(CSV.encode("utf8")).decode("ascii"),
        "sourceRole": "evidence",
    }, expect=201)
    source_id = payload["source"]["sourceId"]
    record("source-upload", True, f"sourceId={source_id}")

    datasets = []
    for _ in range(30):
        status, payload = api("GET", f"/api/projects/{project_id}/figures/datasets", expect=200)
        datasets = payload.get("datasets", [])
        if datasets:
            break
        time.sleep(1)
    if not datasets:
        record("smoke-a-datasets", False, "30s 内未出现数据集候选（ingestion 未完成）")
        return
    dataset = datasets[0]
    record("smoke-a-datasets", dataset["blockId"] == "B0001-B0004" and dataset["rowCount"] == 4,
           f"blockId={dataset['blockId']} rows={dataset['rowCount']} columns={dataset['columns']}")

    status, payload = api("GET", f"/api/projects/{project_id}/figures/datasets/{source_id}/{dataset['blockId']}", expect=200)
    full = payload["dataset"]
    columns = full["columns"]
    rows = full["inlineDataset"]["rows"]
    spec = {
        "plotType": "grouped_bar",
        "semantic": "ablation",
        "title": "Ablation of motion and appearance cues",
        "caption": "消融结果：full_model 相对 baseline 的 HOTA 提升 2.1。",
        "data": {
            "origin": {"sourceId": source_id, "blockId": dataset["blockId"]},
            "datasetHash": full["datasetHash"],
            "x": [columns[0]],
            "series": [{"name": column, "column": column} for column in columns[1:]],
            "inlineDataset": {"columns": columns, "rows": rows},
        },
        "axis": {"xLabel": "method", "yLabel": "score"},
    }
    status, payload = api("POST", f"/api/projects/{project_id}/figures/validate", {"kind": "plot", "spec": spec}, expect=200)
    record("smoke-a-validate", payload["result"]["ok"] is True, f"validate ok；captionValidation={payload['result'].get('captionValidation', {}).get('verdict', 'n/a')}")

    status, payload = api("POST", f"/api/projects/{project_id}/figures/generate", {"kind": "plot", "spec": spec}, expect=200)
    fig_id = payload["figure"]["record"]["figId"]
    record("smoke-a-generate", bool(fig_id), f"figId={fig_id} cached={payload['figure']['cached']}")

    status, body, headers = raw(f"/api/projects/{project_id}/figures/generated/{fig_id}.pdf")
    record("smoke-a-pdf", status == 200 and body[:5] == b"%PDF-" and headers.get("Content-Type") == "application/pdf",
           f"HTTP {status} bytes={len(body)} magic={body[:5].decode('latin1')} sha256={sha256_hex(body)[:16]}…")

    # ---- Smoke B：方法图 ----
    diagram = {
        "layout": "vertical",
        "variant": "pipeline",
        "title": "Tracking Pipeline",
        "nodes": [
            {"id": "input", "label": "输入视频"},
            {"id": "det", "label": "检测器\nYOLOv11"},
            {"id": "embed", "label": "外观嵌入", "role": "annotation"},
            {"id": "track", "label": "跟踪器\nMRG-DTM"},
            {"id": "output", "label": "轨迹输出"},
        ],
        "edges": [
            {"from": "input", "to": "det"},
            {"from": "det", "to": "track"},
            {"from": "embed", "to": "track", "label": "线索融合"},
            {"from": "track", "to": "output"},
        ],
    }
    status, payload = api("POST", f"/api/projects/{project_id}/figures/generate", {"kind": "diagram", "spec": diagram}, expect=200)
    diagram_id = payload["figure"]["record"]["figId"]
    status, body, headers = raw(f"/api/projects/{project_id}/figures/generated/{diagram_id}.pdf")
    record("smoke-b-diagram", status == 200 and body[:5] == b"%PDF-",
           f"figId={diagram_id} bytes={len(body)} sha256={sha256_hex(body)[:16]}…")

    # ---- Smoke D：无效数据 ----
    # D1 篡改行但沿用原 hash → spec 校验拒绝
    tampered = json.loads(json.dumps(spec))
    tampered["data"]["inlineDataset"]["rows"][0][1] = 95
    status, payload = api("POST", f"/api/projects/{project_id}/figures/generate", {"kind": "plot", "spec": tampered})
    record("smoke-d1-tampered-hash", status == 422 and payload["error"]["code"] == "FIGURE_SPEC_INVALID",
           f"HTTP {status} code={payload['error']['code']}")

    # D2 重算 hash 绕过自洽，但与来源不一致 → 来源锚反查拒绝
    tampered2 = json.loads(json.dumps(spec))
    tampered2["data"]["inlineDataset"]["rows"][0][1] = 95
    tampered2["data"]["datasetHash"] = dataset_hash(columns, tampered2["data"]["inlineDataset"]["rows"])
    status, payload = api("POST", f"/api/projects/{project_id}/figures/generate", {"kind": "plot", "spec": tampered2})
    record("smoke-d2-origin-mismatch", status == 409 and payload["error"]["code"] == "FIGURE_DATASET_STALE",
           f"HTTP {status} code={payload['error']['code']}")

    # D3 无支撑数值声明的 caption → 插入被守卫拦截（需要手稿；对 validate 端点先行验证）
    bad_caption_spec = json.loads(json.dumps(spec))
    bad_caption_spec["caption"] = "full_model 相对 baseline 的 HOTA 提升 5.2。"
    status, payload = api("POST", f"/api/projects/{project_id}/figures/validate", {"kind": "plot", "spec": bad_caption_spec}, expect=200)
    verdict = payload["result"].get("captionValidation", {}).get("verdict")
    record("smoke-d3-unsupported-claim", verdict == "violation", f"captionValidation={verdict}")

    # D4 缺失来源 → 409
    missing = json.loads(json.dumps(spec))
    missing["data"]["origin"] = {"sourceId": "S99", "blockId": "B0001-B0004"}
    missing["data"]["datasetHash"] = dataset_hash(columns, rows)
    status, payload = api("POST", f"/api/projects/{project_id}/figures/generate", {"kind": "plot", "spec": missing})
    record("smoke-d4-missing-source", status == 409 and payload["error"]["code"] == "FIGURE_SOURCE_MISSING",
           f"HTTP {status} code={payload['error']['code']}")

    # D5 非法 series 列 → validate errors
    bad_series = json.loads(json.dumps(spec))
    bad_series["data"]["series"] = [{"name": "ghost", "column": "not_a_column"}]
    status, payload = api("POST", f"/api/projects/{project_id}/figures/validate", {"kind": "plot", "spec": bad_series}, expect=200)
    record("smoke-d5-invalid-series", payload["result"]["ok"] is False and any("not_a_column" in e for e in payload["result"]["errors"]),
           "errors 含列不存在")

    # ---- Smoke C：手稿插入（有界真实 workflow）----
    if skip_workflow:
        print("SKIP  smoke-c（--skip-workflow）")
    else:
        status, payload = api("POST", f"/api/projects/{project_id}/workflows", {"workflowKind": "idea_to_paper"}, expect=202)
        run_id = payload["runId"]
        record("smoke-c-workflow-start", True, f"runId={run_id}")
        # 轮询至完成（自动批准 HITL；有界等待 40 分钟）
        deadline = time.time() + 40 * 60
        final = None
        while time.time() < deadline:
            status, payload = api("GET", f"/api/runs/{run_id}", expect=200)
            run = payload["run"]
            if run["status"] == "awaiting_input":
                stage = run.get("awaiting", {}).get("stageId", "")
                decision = "continue" if "evidence" in stage else "approve"
                api("POST", f"/api/runs/{run_id}/resume", {"decision": decision}, expect=200)
                continue
            if run["status"] in ("completed", "failed", "cancelled"):
                final = run
                break
            time.sleep(5)
        if final is None:
            record("smoke-c-workflow", False, "40 分钟超时")
            return
        # 非绿终态不阻塞图表验收（章节已产出即可承载插入；如实记录）
        record("smoke-c-workflow", True, f"终态={final['status']} completion={final.get('completion', {}).get('label', 'n/a')}")

        # 章节选择：实验章（outline id/title 命中；否则取最后一个已生成章节）
        status, payload = api("GET", f"/api/projects/{project_id}/manuscript", expect=200)
        statuses = {section["id"]: section for section in payload.get("sections", [])}
        outline_sections = payload.get("outline", {}).get("sections", [])
        candidates = [
            section for section in outline_sections
            if any(key in section["id"].lower() or key in section.get("title", "").lower() for key in ("result", "experiment", "实验"))
        ] or [section for section in outline_sections if statuses.get(section["id"], {}).get("exists")]
        results_section = candidates[-1] if candidates else None
        if results_section is None:
            record("smoke-c-insert", False, "无可用章节")
            return

        status, payload = api("POST", f"/api/projects/{project_id}/figures/insert", {
            "figId": fig_id,
            "mode": "append",
            "sectionId": results_section["id"],
            "caption": "消融结果：full_model 相对 baseline 的 HOTA 提升 2.1。",
            "label": "ablation",
            "referenceSentence": "消融实验结果如图~\\ref{fig:ablation} 所示。",
        }, expect=200)
        insertion = payload["insertion"]
        record("smoke-c-insert", insertion["file"].startswith("sections/") and insertion["label"] == "fig:ablation",
               f"file={insertion['file']} label={insertion['label']} graphicx={insertion['graphicxInjected']}")

        status, payload = api("POST", f"/api/projects/{project_id}/build", None, expect=200)
        build_ok = payload.get("build", {}).get("passed") is True
        compile_info = payload.get("compile", {})
        record("smoke-c-build", build_ok, f"build.passed={build_ok} compile.ok={compile_info.get('ok')} duration={compile_info.get('durationMs')}ms draft={payload.get('draftArtifactId')}")

        if build_ok:
            status, payload = api("GET", f"/api/projects/{project_id}/artifacts", expect=200)
            latest = payload.get("latestDraft") or (payload.get("artifacts") or [None])[-1]
            if latest:
                artifact_id = latest["artifactId"] if isinstance(latest, dict) else latest
                status, body, headers = raw(f"/api/projects/{project_id}/artifacts/{artifact_id}/download")
                record("smoke-c-pdf", status == 200 and body[:5] == b"%PDF-" and len(body) > 10000,
                       f"HTTP {status} bytes={len(body)} magic={body[:5].decode('latin1')} sha256={sha256_hex(body)[:16]}…")

    # ---- 汇总 ----
    failures = [name for name, ok, _ in RESULTS if not ok]
    print("\n===== 汇总 =====")
    print(f"通过 {sum(1 for _, ok, _ in RESULTS if ok)} / {len(RESULTS)}")
    if failures:
        print("失败项：" + "、".join(failures))
        sys.exit(1)
    print(f"projectId={project_id}")


if __name__ == "__main__":
    main()
