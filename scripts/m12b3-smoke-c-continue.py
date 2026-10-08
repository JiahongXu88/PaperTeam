#!/usr/bin/env python3
"""M12 Batch 3 — Smoke C 续接：从 awaiting_input 的 run 恢复（409 错误消息里
解析该节点允许的 decision 并取首个），完成后执行图表插入 + 真实构建。"""

import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8080"
PROJECT_ID = sys.argv[1]
RUN_ID = sys.argv[2]
FIG_ID = sys.argv[3]

PREFERRED = {"hitl.revision_overflow": "accept_draft", "hitl.evidence_supply": "continue"}


def api(method, path, body=None):
    request = urllib.request.Request(
        BASE + path,
        method=method,
        data=None if body is None else json.dumps(body).encode("utf8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return response.status, json.loads(response.read().decode("utf8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf8"))


def resume_with_allowed(run):
    """按节点偏好或 409 消息解析允许的 decision。"""
    stage = (run.get("awaiting") or {}).get("stageId", "")
    decision = PREFERRED.get(stage, "approve")
    status, payload = api("POST", f"/api/runs/{RUN_ID}/resume", {"decision": decision})
    if status == 409:
        message = payload.get("error", {}).get("message", "")
        match = re.search(r"只能是 ([^（]+)（", message)
        if match:
            allowed = [option.strip() for option in match.group(1).split("/") if option.strip()]
            if allowed:
                status, payload = api("POST", f"/api/runs/{RUN_ID}/resume", {"decision": allowed[0]})
                print(f"resume({stage}) → {allowed[0]}：HTTP {status}")
                return status
        raise AssertionError(f"无法解析允许的 decision：{message}")
    print(f"resume({stage}) → {decision}：HTTP {status}")
    return status


def main():
    deadline = time.time() + 30 * 60
    final = None
    while time.time() < deadline:
        status, payload = api("GET", f"/api/runs/{RUN_ID}")
        run = payload["run"]
        if run["status"] == "awaiting_input":
            resume_with_allowed(run)
            continue
        if run["status"] in ("completed", "failed", "cancelled"):
            final = run
            break
        time.sleep(5)
    if final is None:
        print("FAIL 超时")
        sys.exit(1)
    print(f"工作流终态={final['status']} completion={(final.get('completion') or {}).get('label', 'n/a')}")

    # 章节选择
    status, payload = api("GET", f"/api/projects/{PROJECT_ID}/manuscript")
    statuses = {section["id"]: section for section in payload.get("sections", [])}
    outline_sections = payload.get("outline", {}).get("sections", [])
    candidates = [
        section for section in outline_sections
        if any(key in section["id"].lower() or key in section.get("title", "").lower() for key in ("result", "experiment", "实验"))
    ] or [section for section in outline_sections if statuses.get(section["id"], {}).get("exists")]
    target = candidates[-1] if candidates else None
    if target is None:
        print("FAIL 无可用章节")
        sys.exit(1)
    print(f"插入目标章节：{target['id']}（{target.get('title', '')}）")

    status, payload = api("POST", f"/api/projects/{PROJECT_ID}/figures/insert", {
        "figId": FIG_ID,
        "mode": "append",
        "sectionId": target["id"],
        "caption": "消融结果：full_model 相对 baseline 的 HOTA 提升 2.1。",
        "label": "ablation",
        "referenceSentence": "消融实验结果如图~\\ref{fig:ablation} 所示。",
    })
    print(f"insert → HTTP {status}")
    if status != 200:
        print(json.dumps(payload, ensure_ascii=False)[:500])
        sys.exit(1)
    insertion = payload["insertion"]
    print(f"file={insertion['file']} label={insertion['label']} graphicx={insertion['graphicxInjected']}")

    status, payload = api("POST", f"/api/projects/{PROJECT_ID}/build", {})
    build_ok = payload.get("build", {}).get("passed") is True
    compile_info = payload.get("compile", {})
    print(f"build → passed={build_ok} compile.ok={compile_info.get('ok')} duration={compile_info.get('durationMs')}ms draft={payload.get('draftArtifactId')}")
    if not build_ok:
        status, log_payload = api("GET", f"/api/projects/{PROJECT_ID}/build/log")
        print("compile.log 尾部：", log_payload.get("log", "")[-1200:])
        sys.exit(1)

    status, payload = api("GET", f"/api/projects/{PROJECT_ID}/artifacts")
    latest = payload.get("latestDraft")
    artifact_id = latest["artifactId"] if isinstance(latest, dict) else latest
    with urllib.request.urlopen(f"{BASE}/api/projects/{PROJECT_ID}/artifacts/{artifact_id}/download", timeout=120) as response:
        body = response.read()
    sha = hashlib.sha256(body).hexdigest()
    print(f"DRAFT_PDF bytes={len(body)} magic={body[:5].decode('latin1')} sha256={sha[:20]}…")
    print("SMOKE_C_COMPLETE")


if __name__ == "__main__":
    main()
