# PaperTeam 双运行时：Windows 本地 + Linux 服务器（M12.2.5）

> **同一套代码、同一套项目数据格式；不同机器各自独立的模型配置与 credentials。**
> 代码同步，credentials **永不**同步。

PaperTeam 是单用户自托管工具，没有（也不需要）多租户。两种一等运行模式：

```text
Mode A — Windows Local                        Mode B — Linux Server

Windows PC                                    Ubuntu 24.04 / Docker
→ 本地 backend（bind 127.0.0.1）              → 服务器 backend（0.0.0.0，仅私网/隧道可达）
→ 本地浏览器                                   → 远程浏览器（SSH 隧道 / Tailscale）
→ 公司 / 私有模型 Provider                     → Z.AI / 个人 / 海外公网 Provider
→ MiKTeX（自动装包）                           → TeX Live + Fandol 中文字体
→ 本地 docling（pip 安装）                     → backend-docling 镜像 / 原生 docling
→ 数据在 D:\PaperTeamData（示例）              → 数据在 /var/lib/paperteam 或 /data volume
```

两个模式**没有**代码分支、没有 Windows/Linux 双仓库：`process.platform` 分支
只出现在两处 TeX spawn 的 shell 门控（`backend/test/deploy/deployment.test.ts`
有守卫测试持续强制源码无 OS 硬编码路径 / 无 cmd·powershell 调用）。

## 1. 各自适合什么

### Windows 本地（Mode A）适合

- **公司内部 / VPN 内网才能访问的 Provider**：公司 Claude API、内部模型网关、
  公司代理服务——凭据不允许离开公司设备；
- 私有数据不出本机的实验（未发表手稿、保密项目）；
- 日常开发与快速迭代（`npm run dev` 一键起前后端）。

### Linux 服务器（Mode B）适合

- **长时间运行的重任务**：整篇论文多轮修订、批量全文解析（docling）、
  Target Publication Search、LaTeX 编译——笔记本合盖不影响；
- 7×24 可达：随时随地浏览器继续同一个项目；
- 接入海外公网 Provider（无公司网络限制时的个人 Key）。

详细部署手册：[linux-server.md](linux-server.md)；Windows 本地入门：
[../getting-started.md](../getting-started.md)。

## 2. credentials 边界（公司环境隔离，最重要的一节）

机器本地的一切配置都挂在 `PAPERTEAM_RUNTIME_ROOT` 下（默认 `~/.paperteam`）：

```text
<runtimeRoot>/settings/model.json             非敏感模型偏好（默认模型 + per-Agent）
<runtimeRoot>/settings/custom-providers.json  自定义 Provider 网关描述（不含 Key）
<runtimeRoot>/runtime/pi/agent/auth.json      API Key（Settings → 模型设置 保存位置）
```

因此**两台机器天然拥有完全独立的模型配置与 credentials**——互不可见、互不
覆盖（`backend/test/settings/runtimeIsolation.test.ts` 以两个独立 data root
fixture 锁定该契约，含 auth.json 不随项目数据迁移的断言）。

### 正确用法

```text
✅ 公司 Windows PC → 本地 PaperTeam → 公司 Provider
✅ 个人 Linux 服务器 → 服务器 PaperTeam → Z.AI / 个人 Key
❌ 公司 API Key 配到个人服务器
❌ 公司模型配置提交进 Git / 写进 Docker image / .env 提交 / README / 日志
❌ 同步项目数据时把 auth.json 一起带走
```

### 纪律清单

1. `.env` 已 gitignore（`.env.example` 只有占位）；Docker 镜像不 COPY 任何
   密钥（`.dockerignore` 显式排除 `.env` / `auth.json` / `models.json`，
   `deployment.test.ts` 持续断言）。
2. API Key 只经三种受支持通道进入：`.env` / 环境变量（`PAPERTEAM_PI_API_KEY`）、
   Settings → 模型设置（落本机 runtimeRoot 的 auth.json）、挂载的本地配置。
   **不存在**（也不做）任何跨机 credentials 同步机制。
3. 诊断输出（`npm run doctor` / `/api/runtime/status`）只报「已配置/未配置」
   与来源，绝不回显 Key。

## 3. 数据根（Data Root）

PaperTeam 的数据根是**两个**目录（这是既有事实源，不是新设计）：

| 环境变量 | 默认 | 内容 |
| --- | --- | --- |
| `PROJECTS_ROOT`（无前缀） | `./projects`（cwd 相对） | 全部项目工作区 |
| `PAPERTEAM_RUNTIME_ROOT` | `~/.paperteam` | 模型设置 / auth / skills |

推荐布局（目录本身随意，两个变量指对即可）：

```text
Windows   D:\PaperTeamData\projects     +  D:\PaperTeamData\runtime
Linux     /var/lib/paperteam/projects   +  /var/lib/paperteam/runtime
Docker    volume /data/projects         +  volume /data/runtime（+ /data/hf-cache）
```

项目目录结构两平台字节兼容（路径分隔统一 `path.join`；仓库内容入口一律
CRLF→LF 归一；skills hash 已做行尾归一以保证 Windows autocrlf checkout 与
Linux hash 相等）。Windows checkout（autocrlf=true）与 Linux 服务器对同一
项目数据语义一致。

## 4. 项目迁移（Windows → Linux）

把一个项目搬到服务器 = 复制 `PROJECTS_ROOT` 下对应的 `p-<id>` 目录：

```powershell
# Windows（打包单个项目；-tl 保 tar 语义）
tar -czf D:\export\p-xxxx.tgz -C D:\PaperTeamData\projects p-xxxxxxxxxxxx
scp D:\export\p-xxxx.tgz user@server:/tmp/
```

```bash
# Linux 服务器
mkdir -p /var/lib/paperteam/projects
tar -xzf /tmp/p-xxxx.tgz -C /var/lib/paperteam/projects
# Docker 模式：tar -xzf /tmp/p-xxxx.tgz -C $(docker volume inspect ... Mountpoint)
```

迁移保留：project.json 元数据、Sources（含上传的原始 PDF）、Evidence、
manuscript、generated figures、target benchmark/profile/readiness、workflow
runs——全部是项目目录内的平台无关 JSON / PDF / TeX / PNG。

**不迁移**（默认就不在项目目录里，按此纪律执行即可）：

- `auth.json` / custom-providers（机器本地 credentials——目标机器上重新配置）；
- `~/.paperteam` 下其余机器本地状态（skills 安装记录、缓存）；
- 临时 / 缓存目录（`tmp/`、HF 模型缓存——目标机器首次使用时重建）。

迁移后首次打开：Settings → 模型设置 配好服务器侧 Key；`GET /api/projects`
应立即看到迁移进来的项目。

## 5. 模型运行时（两平台同构）

模型配置解析优先级两平台一致：

```text
环境变量 PAPERTEAM_PI_MODEL / PAPERTEAM_PI_API_KEY
  > Settings UI 保存（model.json / auth.json，挂在各自 runtimeRoot）
  > Pi 标准环境变量（ANTHROPIC_API_KEY 等）
```

- 前端 Settings → 模型设置 在两个模式下用法完全相同（写各自 runtimeRoot）；
- vision 模型选择（TargetPanel 的分位带 / readiness 视觉验收链）与普通模型
  选择共用同一 Model Settings 面；
- 切换机器不需要「迁移配置」——在新机器上按需配置即可，公司机配置不动。
- Docker 模式的模型 Key：`.env`（env_file 注入容器）或启动后在 Settings 页保存
  （落 `paperteam-runtime` volume 的 auth.json，容器重建仍在）。

## 6. TeX / 字体的平台差异（由 PaperTeam 抹平）

| | Windows（MiKTeX） | Linux（TeX Live） |
| --- | --- | --- |
| 后端调用 | 同一 `xelatex`+`bibtex` 编排（Windows 下 shell 门控解析 .cmd 包装，POSIX 直 exec） | 同上，无 shell |
| 缺包 | MiKTeX 首次编译自动安装 | 不自动装：`apt install texlive-*`（清单见 linux-server.md §5；Docker 镜像内置） |
| 中文字体 | 系统字体（中易宋体系） | Fandol（texlive-lang-chinese）+ fonts-noto-cjk |
| 手稿模板 | `ctexart`（自动选平台字体） | 同左 |
| 图表 CJK | codegen 检测到中文自动加 ctex 导言 | 同左 |

字体类编译失败会得到结构化 `kind=font` 诊断 + 双平台安装建议，而不是裸的
"xelatex failed"。

## 7. 并发与资源档位

全部配置驱动（不按 OS 写死）；本地保守值即默认值：

| 配置 | 本地保守（默认） | 服务器推荐 |
| --- | --- | --- |
| `PAPERTEAM_PI_MAX_CONCURRENT_RUNS` | 4 | 4（重负载可 8） |
| `PAPERTEAM_PI_MAX_QUEUED_RUNS` | 32 | 32 |
| `PAPERTEAM_DOCLING_CONCURRENCY` | 1 | 1~2 |
| `PAPERTEAM_REVIEW_CONCURRENCY` / `SUMMARY` | 3 | 3~4 |
| 图表编译 | 单图单编译（无并行批路径） | 同左 |

## 8. 常见问题

- **同一项目能在两台机器同时打开吗？** 数据格式兼容，但 PaperTeam 没有多机
  同步机制——一个项目同一时间只在一台机器上活跃编辑（手工迁移/复制来回搬）。
- **公司 VPN 断了服务器还能跑吗？** 能——服务器用的是它自己 runtimeRoot 下的
  配置，与公司网络无关；反过来公司机离线时公司 Provider 不可达是预期行为。
- **想把两个环境的模型偏好对齐？** 手工对齐（两边 Settings 配一样的公开
  Provider）可以；任何形式的自动同步都不做。
