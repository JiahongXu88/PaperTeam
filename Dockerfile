# syntax=docker/dockerfile:1.7
# PaperTeam 单机 Linux / Docker 部署镜像（M5.5）。
#
# 多阶段构建；两个运行目标：
#   --target backend  Node 22 + Backend(dist) + Pi SDK + Python3/pymupdf + Git + XeLaTeX/bibtex + 中文字体
#   --target web      nginx：Frontend 静态资源 + /api /health /ready 反向代理到 backend（同源，无 CORS）
#
# 纪律：
#   * 不 COPY .env / auth.json / 任何密钥；模型 Key 只经运行时 environment / env_file / secret 注入
#   * 事实源是 volume（PROJECTS_ROOT / PAPERTEAM_RUNTIME_ROOT），容器可写层不保存任何用户数据
#   * TeX 只装 PaperTeam 模板与导入论文真实需要的包集（ctexart + amsmath/amssymb + natbib/biblatex + pgf），不装 texlive-full
#   * 非 root 运行；HEALTHCHECK 只探 /health（不调用模型）
#   * 受限网络（M5.5 真实验收：deb.debian.org / pypi.org 从构建主机几乎不可达）可用
#     --build-arg APT_MIRROR=http://mirrors.example.edu.cn --build-arg PIP_INDEX_URL=https://…/simple
#     指向镜像站；缺省仍是官方源，镜像内容不变（同一套 Debian / PyPI 包）

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- 1. Frontend 构建 ----------
FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- 2. Backend 构建（含 devDependencies 以运行 tsc） ----------
FROM ${NODE_IMAGE} AS backend-build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src
RUN npm run build \
 && npm prune --omit=dev

# ---------- 3. Backend 运行时 ----------
FROM ${NODE_IMAGE} AS backend
ENV NODE_ENV=production \
    PAPERTEAM_PORT=3000 \
    PROJECTS_ROOT=/data/projects \
    PAPERTEAM_RUNTIME_ROOT=/data/runtime \
    PAPERTEAM_PDF_PYTHON=/opt/paperteam-venv/bin/python \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DEBIAN_FRONTEND=noninteractive

# 运行依赖审计（以源码为准，见 docs/DEPLOYMENT.md §依赖审计）：
#   python3 + venv          PdfParser（backend/tools/parse_paper_pdf.py，pymupdf）
#   git                     Pi SDK / 用户导入的 LaTeX 项目可能含 git 元数据（可选，小）
#   texlive-xetex           xelatex + fontspec/xeCJK（ctexart 依赖）
#   texlive-latex-base      amsmath / amssymb / natbib
#   texlive-latex-recommended  xcolor / graphicx / hyperref 等导入论文常用包
#   texlive-lang-chinese    ctex 文档类 + Fandol 中文字体
#   texlive-pictures        pgf/tikz（导入论文；PaperTeam 自身模板不用）
#   texlive-bibtex-extra + biber   biblatex 参考文献（导入论文）
#   latexmk                 可选便捷工具（M9.5.1 起 LatexCompiler 用 xelatex+bibtex 显式编排，不再调用 latexmk）
#   fonts-noto-cjk          兜底中文字体（fontspec 按名引用时可用）
# APT_MIRROR：主机前缀（如 http://mirrors.ustc.edu.cn），替换 deb.debian.org 的 debian / debian-security；
# PIP_INDEX_URL：PyPI simple 索引。两者只在构建期生效，不进入最终镜像的运行环境
ARG APT_MIRROR=""
ARG PIP_INDEX_URL=""
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s#http://deb.debian.org/#${APT_MIRROR%/}/#g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      python3 python3-venv \
      git \
      texlive-xetex texlive-latex-base texlive-latex-recommended \
      texlive-lang-chinese texlive-pictures texlive-bibtex-extra biber latexmk \
      fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/paperteam-venv \
 && ${PIP_INDEX_URL:+env PIP_INDEX_URL="$PIP_INDEX_URL"} /opt/paperteam-venv/bin/pip install --no-cache-dir "pymupdf>=1.24,<2" \
 && /opt/paperteam-venv/bin/python -c "import pymupdf; print('pymupdf', pymupdf.__version__)" \
 && xelatex --version | head -n 1 \
 && bibtex --version | head -n 1

WORKDIR /app/backend
# 只带运行需要的内容：dist / 生产 node_modules / 审计 seed（Skill Registry）/ PDF 解析脚本
COPY --from=backend-build /app/backend/package.json ./package.json
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/dist ./dist
COPY backend/skills ./skills
COPY backend/tools ./tools

# 非 root：数据目录归 paperteam 用户；volume 首次挂载为空时由 entrypoint 修正属主
RUN groupadd --system paperteam && useradd --system --gid paperteam --create-home --home-dir /home/paperteam paperteam \
 && mkdir -p /data/projects /data/runtime /app/latex-cache \
 && chown -R paperteam:paperteam /data /app/latex-cache /home/paperteam
# TeX 用户级缓存（texmf-var）放到可写目录，避免 xelatex 在只读 $HOME 下报错
ENV HOME=/home/paperteam \
    TEXMFVAR=/app/latex-cache/texmf-var \
    TEXMFCONFIG=/app/latex-cache/texmf-config
COPY docker/backend-entrypoint.sh /usr/local/bin/paperteam-entrypoint
RUN chmod +x /usr/local/bin/paperteam-entrypoint
# 镜像以 root 启动只为让 entrypoint 修正 volume 属主，随后 setpriv 降权到 paperteam 再 exec node
EXPOSE 3000
# liveness：进程活着且 Runtime 可初始化（不调用模型）；readiness 用 /ready
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PAPERTEAM_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 使用 exec 形式：SIGTERM 直达 node（registerShutdown 协作式收敛，见 index.ts）
ENTRYPOINT ["paperteam-entrypoint"]
CMD ["node", "dist/index.js"]

# ---------- 4. Web（nginx：静态资源 + 同源反向代理） ----------
FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
