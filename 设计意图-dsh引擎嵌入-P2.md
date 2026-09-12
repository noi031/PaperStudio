# 设计意图：dsh 引擎嵌入与 AI 助手（P2）

## 目标
在 Electron 壳内以**子进程**方式嵌入 deepseek-harness（dsh），提供与 Kimi Code / Codex 同类的 AI 助手能力：
会话、流式回复、思考过程、工具调用（论文域 MCP）。UI 层（React）只消费归一化事件，不感知 dsh 协议细节。

## 模块划分与职责
| 模块 | 职责 | 关键接口 |
|---|---|---|
| `src/main/agentHost.ts` | dsh 子进程生命周期 + 自写 stdio 行分帧 JSON-RPC 客户端；把 dsh 通知归一化为 `AgentEvent` | `start(mcpEntry)` / `sendMessage(dshSessionId, text)` / `on(sessionId, listener)` / `close()` / `ready` |
| `src/main/agentService.ts` | 编排：会话/消息仓储 + AgentHost + 渲染进程三者的桥；事件累积、落库、转发 | `ensureStarted()` / `createSession(title, context)` / `sendMessage(sessionId, text)` / `listSessions` / `listMessages` / `deleteSession` / `dispose` |
| `src/main/agentRepo.ts` | `agent_sessions` / `agent_messages` 两张表的 CRUD | `createSession` / `getSession` / `listSessions` / `appendMessage` / `listMessages` / `renameSession` / `deleteSession` |
| `src/main/mcpServer.ts` | 论文域 MCP server（stdio）。`require.main === module` 时才连 stdio，作为子进程入口被 dsh 拉起 | 工具：`search_papers`（arXiv 真实现）、`echo` |

## AgentHost 协议映射（AgentEvent 归一化）
dsh JSON-RPC 通知 → AgentEvent：
- `session.status` → `{kind:'status', status:'running'|'idle'}`
- `session.event` 各类型：
  - `session/title` → `{kind:'title', title}`
  - `user/message` → `{kind:'user', text}`（content 里 type==='text' 的片段拼接）
  - `assistant/chunk`：`text-delta` → `{kind:'text-delta', text}`；`reasoning-delta` → `{kind:'reasoning-delta', text}`；`finish` → `{kind:'finish', reason}`
  - `tool/call` → `{kind:'tool-call', name, args}`
  - `tool/result` → `{kind:'tool-result', name, ok}`（无 error 视为 ok）
- 未知方法 / 缺字段事件：忽略。
- 事件按 `sessionId` 隔离分发；`id` 请求用 pending Map 关联 resolve/reject。

边界条件：
- 子进程退出时：reject 所有 pending，并向所有监听器广播 `{kind:'error'}`。
- stderr 保留最近 4000 字符尾部，用于退出报错。
- **`start()` 内部先 `close()`（清空全部监听器）——`on()` 必须在 `start()` 之后注册**（agentService 已遵守；这是使用顺序约束）。

## AgentService 编排规则
- `sendMessage`：查会话 → `ensureStarted()` → 用户消息落库并转发 UI → 注册 `host.on(session.dshSessionId)` → `host.sendMessage`；发送失败则退订、清理 stream、转发 error。
- 事件处理（`handleEvent`）：text/reasoning 增量累积到 `StreamState`，`finish` 时一次性落库完整文本并转发 `finish`；`status idle` 且已 finish 时清理 stream。
- 带上下文的会话（`createSession(title, context)`）：首条消息即上下文，自动发送给 dsh 作为会话起点。
- `deleteSession` 同步清理 `streams`。
- `dispose`（应用退出）：停引擎、清流。

## 与 UI 的契约
IPC 通道（见 `src/shared/types.ts` IpcContract）：`agent:health` / `agent:listSessions` / `agent:createSession` / `agent:deleteSession` / `agent:listMessages` / `agent:sendMessage`；推送 `agent:event`（payload 见 AgentService `emitToWindow`）。渲染层 `window.paper.onAgentEvent` 订阅，`assistantStore.handleAgentEvent` 消费。

## 单测对应（src/main/__tests__/agentHost.spec.ts）
- `session.status` → status 事件
- assistant/chunk 的 text/reasoning/finish 分派
- tool/call 与 tool/result（含失败分支 ok=false）
- session/title 与 user/message
- 未知方法与缺字段事件被忽略
- 事件按 sessionId 隔离

（db.spec.ts 覆盖 agent_sessions/agent_messages 表初始化与 settings 往返；agentRepo/agentService 的数据库/编排行为暂未单测。）

## 已知限制
- `/compact` / `/resume` 命令暂以「新开会话」替代，未接 dsh 压缩后端。
- `AgentHost.start` 在 settings 未配 LLM API Key 时抛错；UI 需在 Settings 页提示。
- 生产 MCP 部署最终走 streamable-http 挂主进程；P2 用 stdio 已验证路径（与 P0 spike 一致）。
