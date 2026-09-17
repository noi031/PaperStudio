# dsh → EchoCap 替换接入与验证

本文记录把 PaperStudio 的 **deepseek-harness（dsh）后端整体替换为 Echo 平台能力网关
（ECHO_CAP）** 的改造范围、能力契约、语义差异与验证结论。

## 1. 替换范围

改造前后的出站调用只有四类，全部收敛到主进程的两个模块：

| 原链路 | 新链路 | 承载文件 |
| --- | --- | --- |
| `spawn dsh 子进程` + stdio 行分帧 JSON-RPC（`initialize` / `session/prompt` / `session.event`） | `sub_agent.send` + `sub_agent.query`（Unix Socket RPC） | `src/main/agentHost.ts` |
| 直接 `new OpenAI()`（方向建议、写作、演示） | `model.call` | `src/main/llm.ts` |
| 直接 `new OpenAI()` + `stream: true`（论文总结） | `model.call` | `src/main/summaryService.ts` |
| 直接 `new OpenAI()`（agentic 检索规划与相关度评估） | `model.call` | `src/main/agenticSearch.ts` |

新增 **`src/main/echoCap.ts`**：ECHO_CAP 的唯一出口。负责

- 端点解析：`ECHO_CAP_SOCKET` → `capabilities.properties`（`socket_path` / `http_host` /
  `base_path` / `auth_key_env` / `auth_key`）；
- 鉴权：`Authorization: Bearer <ECHO_CAP_AUTH_KEY>`；
- 信封校验：`{ ok, request_id, result }`，`ok=false` 时抛 `EchoCapError(code, message)`；
- 能力封装：`subAgentSend` / `subAgentQuery` / `modelCall`。

**上层零改动**：`AgentService`、`ipc.ts`、`src/host/server.ts`、渲染进程只依赖
`AgentHost` 的 `ready / start / on / sendMessage / cancel / close` 与 `AgentEvent` 形状。

## 2. 能力契约（实测确认）

```
POST /v1/capabilities/rpc/sub_agent.send     params={context_path, input:{text}, wait_ms?}
  → result={turn_request_id, context_path, seq, status, done, query_params}

POST /v1/capabilities/rpc/sub_agent.query    params={context_path, seq?, section_types?, include_running?}
  → result={messages:[{seq, status, stop_reason, error, usermsg,
                       sections:[{sub_seq, type:content|reasoning|tool, completed,
                                  content, reasoning, toolname, tool_execution_state}]}]}

POST /v1/capabilities/rpc/model.call         params={input:{text}, async, model_profile, context_mode, instructions?}
  → result={output:{model_call_request_id}}                （async=true）

POST /v1/capabilities/rpc/model.call.await   params={model_call_request_id, timeout_ms}
  → result={status, done, output:{text, reasoning}, meta.progress_chars}
```

## 3. 事件映射

| EchoCap 观测 | AgentEvent | 说明 |
| --- | --- | --- |
| 回合被接受 | `status: running` | `sendMessage` 立即返回，不阻塞 UI |
| `content` section 增长 | `text-delta` | 按 `sub_seq` 游标取「本次相对上次」的增量 |
| `reasoning` section 增长 | `reasoning-delta` | 同上，与正文分段互不串扰 |
| 首见 `tool` section | `tool-call` | `toolname` |
| `tool.completed` | `tool-result` | `tool_execution_state` 含 fail/error 判定为失败 |
| `message.status` 终态 | `assistant-message` → `finish` → `status: idle` | 落库仍只走 `assistant-message`（与 dsh 版一致，避免跨 step 重复落库） |
| 轮询/RPC 失败 | `error` + `status: idle` | 与 dsh 子进程退出时的收尾一致 |

## 4. 语义差异与取舍

1. **会话标识**：原 `dshSessionId` 现作为 sub-agent 的 `context_path`
   （`AgentHost.contextPathFor()` → `/sub-agent/paperstudio/<id>`）。`agent_sessions.dsh_session_id`
   列名保留以避免旧库迁移。
2. **不再注入论文域 MCP 工具**：dsh 通过 `--patch` 挂载 `dsh-mcp-client`（本地论文库工具）。
   EchoCap 侧的代理由平台托管，使用平台自带工具集；`AgentService.setMcpEntry()` 与
   `agentHost.start(mcpEntry)` 参数保留但被忽略。`src/main/mcpServer.ts` 保留未接线。
3. **无增量正文**：平台 `model.call` 只在完成时返回正文（`progress_chars` 仅字符数），
   因此总结/写作的 `delta` 事件由「完成后一次性 emit 全文」产生，落库内容与 Markdown
   产出不变；`sub_agent` 侧仍是逐段增量。
4. **回合级取消**：平台未提供 sub-agent 回合取消 RPC，`cancel()` 只停止本地轮询与事件转发；
   `AgentService.stop()` 随后轮换 `context_path`，下一条消息走全新会话（行为与 dsh 版相同）。
5. **无会话标题生成**：dsh 的 `session/title` 不再存在，会话名沿用创建时的标题。
6. **配置项**：应用不再持有任何 LLM 凭证。设置页的「LLM 端点」「LLM API Key」标记为
   **已废弃**（仅保留字段以兼容旧库）；健康检查由「是否配置 Key」改为「EchoCap 是否可达」。
7. **依赖**：移除 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-sdk-client` 与 `postinstall`
   （`scripts/fix-dsh-dupes.mjs` 随之删除），`openai` 依赖不再被引用。
8. **日志**：`storage/logs/dsh-engine.log` → `storage/logs/agent-host.log`。

## 5. 安全边界

- CAP 凭证只在主进程 `echoCap.ts` 内读取，用于 `--unix-socket` 出站请求；
  不写入代码/文档/日志/构建产物，不经 IPC 下发渲染进程。
- 浏览器侧不接触 `ECHO_CAP_*`；渲染进程一切 AI 调用都经 `agent:*` IPC 由主进程转调。
- 克隆用的 PAT 仅用于一次性 `git clone`，未写入 `.git/config` 或任何工作树文件。

## 6. 验证结论

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc --noEmit` | 通过（exit 0） |
| 单元测试 | `npx vitest run` | 全用例通过 |
| 服务端构建 | `npm run build:host` | 通过（`dist-host/`） |
| 渲染层构建 | `npm run build` | 通过（`web/`） |
| 端到端（真实平台） | `node scripts/verify-echocap.mjs` | 12/12 通过：`model.call` 直连、`AgentHost` 对话往返（running→delta→assistant-message→finish→idle）、渲染产物无凭证 |

### 未验证项

- **Web 页面交互**：需在浏览器打开 `http://127.0.0.1:18080`（`npm run dev:server`）复核「AI 助手页对话收发」。
- 论文域 MCP 工具已不注入，其原先依赖 dsh 的能力未经运行时复核。
- 总结/写作/演示/方向建议的真实模型输出质量（仅验证了链路与 `model.call` 往返）。

## 7. 回滚

改造集中在 4 个源文件 + 1 个新增文件 + 1 个测试文件；`git stash`/`git checkout` 即可回到
dsh 版本（旧实现的协议说明仍保留在 `docs/dsh-接入验证.md`）。
