#!/usr/bin/env python3
"""M12 Batch 3 — Smoke E：已有论文修订安全边界（受控 fixture + 真实部署 API）。

前置：projects volume 是 /data/paperteam/projects 的 bind mount（compose.override）。
在已有论文项目里手工放置最小手稿 fixture（作者老图），验证：
  E1 合法 replace（label 保持 / 正文不动）→ 200
  E2 跨章节 append → 403 FIGURE_SCOPE_VIOLATION
  E3 未登记 figure 插入 → 404
  E4 错误 caption（数值无支撑）replace → 422 FIGURE_CAPTION_UNSUPPORTED
"""

import base64
import json
import subprocess
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8080"
COMPOSE_DIR = "/home/ecs-user/PaperTeam"


def write_in_container(relative_path: str, content: str):
    """经 backend 容器写文件（volume 属主是容器内 paperteam 用户，宿主机不可直写）。
    exec 默认以 root 运行——写完 chown 回 paperteam，否则 backend 进程无权写该目录。"""
    encoded = base64.b64encode(content.encode("utf8")).decode("ascii")
    subprocess.run(
        ["docker", "compose", "exec", "-T", "backend", "sh", "-c",
         f"mkdir -p $(dirname /data/projects/{relative_path}) && base64 -d > /data/projects/{relative_path}"
         f" && chown paperteam:paperteam /data/projects/{relative_path} $(dirname /data/projects/{relative_path})"],
        input=encoded.encode("ascii"),
        cwd=COMPOSE_DIR,
        check=True,
        capture_output=True,
    )


def read_in_container(relative_path: str) -> str:
    result = subprocess.run(
        ["docker", "compose", "exec", "-T", "backend", "cat", f"/data/projects/{relative_path}"],
        cwd=COMPOSE_DIR,
        check=True,
        capture_output=True,
    )
    return result.stdout.decode("utf8")

MAIN_TEX = """\\documentclass[UTF8]{ctexart}
\\usepackage{graphicx}
\\begin{document}
\\input{sections/intro}
\\input{sections/results}
\\end{document}
"""

RESULTS_TEX = """\\section{实验}
\\begin{figure}[htbp]
  \\centering
  \\includegraphics[width=0.8\\textwidth]{figures/author-plot.pdf}
  \\caption{Author's original result plot.}
  \\label{fig:author-results}
\\end{figure}
结果如 \\ref{fig:author-results} 所示。
"""

INTRO_TEX = "\\section{引言}\n本文测试图表修订安全边界。\n"


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


def main():
    results = []

    def record(name, ok, detail):
        results.append((name, ok))
        print(f"{'PASS' if ok else 'FAIL'}  {name}：{detail}")

    status, payload = api("POST", "/api/projects", {
        "title": "M12B3 Smoke E 已有论文边界",
        "workflowKind": "existing_paper_improvement",
    })
    assert status == 201, payload
    project_id = payload["project"]["id"]

    # 受控 fixture 手稿（经容器写入 volume）
    write_in_container(f"{project_id}/manuscript/main.tex", MAIN_TEX)
    write_in_container(f"{project_id}/manuscript/sections/results.tex", RESULTS_TEX)
    write_in_container(f"{project_id}/manuscript/sections/intro.tex", INTRO_TEX)

    # 基线图（manual origin 消融数据，真实编译）
    columns = ["method", "hota"]
    rows = [["baseline", 62.1], ["ours", 64.2]]
    dataset_hash_payload = json.dumps({"columns": columns, "rows": rows}, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    import hashlib
    dataset_hash = hashlib.sha256(dataset_hash_payload.encode("utf8")).hexdigest()
    plot_spec = {
        "plotType": "bar",
        "caption": "ours 相对 baseline 的 HOTA 提升 2.1。",
        "data": {
            "origin": {"origin": "manual", "note": "Smoke E 受控 fixture（验收数据，非科研声称）"},
            "datasetHash": dataset_hash,
            "x": ["method"],
            "series": [{"name": "hota", "column": "hota"}],
            "inlineDataset": {"columns": columns, "rows": rows},
        },
        "axis": {"yLabel": "HOTA"},
    }
    status, payload = api("POST", f"/api/projects/{project_id}/figures/generate", {"kind": "plot", "spec": plot_spec})
    assert status == 200, payload
    fig_id = payload["figure"]["record"]["figId"]

    # E2 先测：跨章节（新增图表环境）在已有论文项目被拒
    status, payload = api("POST", f"/api/projects/{project_id}/figures/insert", {
        "figId": fig_id,
        "mode": "append",
        "file": "sections/results.tex",
        "caption": "ours 相对 baseline 的 HOTA 提升 2.1。",
    })
    record("E2-append-scope", status == 403 and payload["error"]["code"] == "FIGURE_SCOPE_VIOLATION",
           f"HTTP {status} code={payload['error']['code']}")

    # E1 合法 replace：label 保持
    status, payload = api("POST", f"/api/projects/{project_id}/figures/insert", {
        "figId": fig_id,
        "mode": "replace",
        "file": "sections/results.tex",
        "replaceLabel": "fig:author-results",
        "caption": "ours 相对 baseline 的 HOTA 提升 2.1。",
    })
    ok = status == 200 and payload["insertion"]["label"] == "fig:author-results" and payload["insertion"].get("previousPath") == "figures/author-plot.pdf"
    record("E1-replace", ok, f"HTTP {status} label={payload.get('insertion', {}).get('label')} previousPath={payload.get('insertion', {}).get('previousPath')}")

    # 验证盘上事实：label/正文 \ref 不动，资产路径已换
    content = read_in_container(f"{project_id}/manuscript/sections/results.tex")
    record("E1-on-disk",
           "\\label{fig:author-results}" in content
           and f"figs/generated/{fig_id}.pdf" in content
           and "author-plot.pdf" not in content
           and "结果如 \\ref{fig:author-results} 所示。" in content,
           "label 保持 / 引用句原样 / 资产已换")

    # E4 错误 caption（数值无支撑）→ 422
    status, payload = api("POST", f"/api/projects/{project_id}/figures/insert", {
        "figId": fig_id,
        "mode": "replace",
        "file": "sections/results.tex",
        "replaceLabel": "fig:author-results",
        "caption": "ours 相对 baseline 的 HOTA 提升 7.3。",
    })
    record("E4-bad-caption", status == 422 and payload["error"]["code"] == "FIGURE_CAPTION_UNSUPPORTED",
           f"HTTP {status} code={payload['error']['code']}")

    # E3 未登记 figure → 404
    status, payload = api("POST", f"/api/projects/{project_id}/figures/insert", {
        "figId": "fig-000000000000",
        "mode": "replace",
        "file": "sections/results.tex",
        "replaceLabel": "fig:author-results",
        "caption": "x",
    })
    record("E3-unregistered", status == 404 and payload["error"]["code"] == "FIGURE_NOT_FOUND",
           f"HTTP {status} code={payload['error']['code']}")

    failures = [name for name, ok in results if not ok]
    print("\n===== Smoke E 汇总 =====")
    print(f"通过 {sum(1 for _, ok in results if ok)} / {len(results)}；projectId={project_id}")
    if failures:
        print("失败项：" + "、".join(failures))
        sys.exit(1)


if __name__ == "__main__":
    main()
