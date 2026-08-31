/**
 * AgentRuntime 接口的权威定义位于 ./types.ts。
 * 本文件按 docs/ARCHITECTURE.md §2.1 的命名单独导出，
 * 供业务层 `import type { AgentRuntime } from "../runtime/AgentRuntime.js"` 使用。
 */
export type {
  AgentRuntime,
  AgentEvent,
  AgentTask,
  AgentTaskStatus,
  RunAgentInput,
  RuntimeHealth,
  RuntimeHealthStatus,
  RuntimeProvider,
} from "./types.js";
export { RuntimeCapabilityError } from "./types.js";
