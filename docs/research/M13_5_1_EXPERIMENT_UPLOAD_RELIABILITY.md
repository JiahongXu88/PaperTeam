# M13.5.1 Experiment Upload Reliability

## Scope

修复实验 ZIP 上传超过压缩包字节上限时的前后端错误处理。Backend 的压缩 ZIP 上限仍为 16 MiB（16,777,216 bytes）；本次没有修改单文件 20 MiB、解压总量 64 MiB、文件数 200、目录深度 8、压缩比 100 等安全限制。

## 复现与根因

使用独立临时 Project Root / Runtime Root，分别启动真实 Backend HTTP server 与项目 `frontend/vite.config.ts` 配置的 Vite Proxy，并用原始 HTTP 客户端发送超过限制的请求体。初始实现可在 Backend 直连路径映射为 HTTP 413，但经 Vite 上传时稳定复现 `write ECONNABORTED`，Vite 无法把业务响应转给客户端。复现确认超限请求是触发条件。

原因是原始流式路由在读请求体之前根据 `Content-Length` 抛出 413；未知长度请求则在流式计数超过限制时提前退出。此时 Vite 的上游请求仍在写 ZIP 内容，Backend 已经返回响应并结束/关闭处理路径，代理侧写入未完成的请求体时触发 `ECONNABORTED`，前端 fetch 因此把业务拒绝误判为网络不可达。受控迭代还验证：仅先发 413 并同时有限排空仍会触发代理写入错误；在常见大小范围内先有限排空请求体，再返回 413，可稳定让 Vite 转发 JSON 错误。

## 修复

- 前端 API 和上传面板共用 `EXPERIMENT_ARCHIVE_MAX_BYTES`。大于上限时在调用 fetch 之前拒绝，消息包含精确到 0.01 MiB 的文件大小及原始文件名；等于上限允许进入后端安全校验。
- HTTP 413 和 `EXPERIMENT_ARCHIVE_LIMIT` 映射为具体大小错误。真正的 fetch 异常保留 `NETWORK_ERROR` 类别，用户界面不展示底层 `ECONNABORTED`。无法解析的 JSON 仍映射为 `INVALID_RESPONSE`。
- Backend 超限响应只在实验 ZIP 上传路由局部处理。`Content-Length` 明确超限时立即开始有界读取并拒绝；Chunked 请求在实收字节越限后停止写临时 ZIP，关闭并删除临时文件，再排空有限尾部后返回 413。
- 拒绝路径最多排空 32 MiB 尾部，最长等待 5 秒；超出字节预算时暂停读取，响应结束后关闭该请求连接。若客户端中断、请求停滞或超过这些边界，不能保证代理收到完整 JSON 413，但不会无限排空、将请求体装入内存或影响其他路由。正常上传同时受 120 秒空闲超时和 120 秒绝对时限约束。
- 上传中途断开时，临时文件和临时目录仍通过 `finally` 清理；被客户端主动中断的请求不会误写成未处理后端错误日志。

## 验证

- Backend 定向 HTTP / Vite Proxy 测试：使用真实 Vite Proxy；合法、有效 ZIP 恰好 16 MiB 成功；16 MiB + 1 byte 与 20 MiB 请求均收到 HTTP 413 JSON，错误码 `EXPERIMENT_ARCHIVE_LIMIT`，文案“ZIP 超过 16 MiB 上限”。Chunked 越限后 Backend 仍接受后续正常上传与 API 请求。
- Backend HTTP 测试也覆盖 Chunked 越限、客户端上传中断、临时目录清理和后端健康状态。所有大型 ZIP 在测试临时目录中按需生成，测试结束后移除。
- Frontend 定向测试覆盖 1 MiB、恰好 16 MiB、16 MiB + 1 byte、20 MiB、100 MiB；所有超限拒绝均断言 fetch 未调用；另覆盖 HTTP 413、400、401、404、500、无效 JSON、真正网络异常、中文提示及选取新合法文件后重试。
- Playwright 浏览器 E2E（隔离 Backend/Vite，临时 runner，不新增仓库依赖）：选择 16 MiB + 1 byte 文件后出现中文大小错误，文件名可见、没有发 POST、按钮未进入 Loading；再选择合法 ZIP，收到 HTTP 201 且成功提示出现。
- Backend / Frontend 定向测试：代理 HTTP 4 项通过；前端 API + 面板 16 项通过。两端 typecheck、build 通过；`git diff --check` 通过（Git 提示若干文件将按配置转为 CRLF）。
- GitHub CI 与 Linux Integration 结果将在提交后补录。

## 尚存限制

对于声明远大于上限、恶意持续发送、慢速停滞或主动断开的客户端，资源预算/时限耗尽后会关闭该连接；此时代理可能无法接收到完整 413 JSON。普通略超限实验包（本地受控验证的 16 MiB + 1 byte 和 20 MiB ZIP）经 Vite Proxy 已验证可以收到 413。HTTP Content-Length 按协议定义请求体边界；超出已声明长度的额外字节属于后续/非法 HTTP 消息，应用层不能将其作为同一 ZIP 流的一部分判定。
