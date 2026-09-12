# dsh 接入验证（P0 spike 结论）

> 日期：2026-09-09。验证对象：DeepSeek 官方 agent harness（`dsh`）作为 PaperStudio 的 AI 引擎。
> 结论先行：**架构可行**（sdk JSON-RPC + MCP 桥接 + 自定义 LLM 端点全部跑通），但**真实模型输出还有 401 鉴权问题未解决**（见 §6）。

## 1. 安装方式（用户决策：npm，不用 GitHub 源码）

- 包：`@deepseek-ai/dsh`，版本 **0.1.2-rc.1**（npm latest；GitHub 源码 = 同一项目 monorepo，dev-preview 有破坏性变更风险）。
- 安装：`npm install @deepseek-ai/dsh`（约 522 个依赖包）。
- 本机 npm registry 可达、GitHub 不可达（需 VPN）；已装 `PaperStudio/node_modules/@deepseek-ai/dsh`。
- 启动二进制：`node node_modules/@deepseek-ai/dsh/lib/bin.js <args>`（Windows 下别用 `node_modules/.bin/dsh` 或 shell:true）。
- 环境：`DSH_HOME` 默认 `~/.dsh`；profile 首次使用自动初始化（`~/.dsh/profiles/<name>`）。

## 2. SDK 嵌入协议（`dsh --profile sdk`）— 已验证

- **传输**：stdio 按行分帧 JSON-RPC 2.0（每行一条消息）。
- **client→server 请求**：
  - `initialize {cwd, provider, model, reasoningEffort?, maxTokens?}` → `{serverInfo:{name:"deepseek-harness-sdk-runtime",version}}`
  - `session/prompt {sessionId, contentBlocks:[{type:"text",text}]}` → `{messageId}`（持久入队回执）
  - `shutdown {}` → `{}`
- **server→client 通知**：`session.event`（会话日志事件流）、`session.status`(running/idle)、`subagent.started`、`subagent.finished`。
- **事件流实测序列**：`permission/preset` → `sandbox/mode` → `approval/policy(ask)` → `agent/inbox/spliced`(用户消息注入) → `session.status running` → `turn/start` → `step/start` → `user/message`×N(含 runtime context + skill catalog) → `session/title` → `request/header` → `request/context` → `assistant/chunk`(流式，含 `{type:"usage"}` 和 `{type:"finish",reason:{kind:"error"|...}}`) → `step/end` → `turn/end` → `session.status idle`。
- **错误码**：`-32601` 未知方法、`-32603` 处理器失败（如 "SDK server is not initialized"）。
- **注意**：initialize 响应到达前不能发 session/prompt（会被 -32603 拒绝）；会话 id 未知则懒创建。
- **TypeScript 客户端**：`@deepseek-ai/dsh-sdk-client`（0.0.1-rc.1，npm 有）。
- **探针**：`.spike/probe-sdk.mjs`（无需 key，验证传输与握手，通过）。

## 3. LLM 端点配置 — ✅ 已打通（用 dsh 默认路由）

- **结论**：直接用 dsh **默认路由 `deepseek-official`** + `deepseek-v4-flash` + 环境变量 `DEEPSEEK_API_KEY`，**无需任何 patch**。
- **关键发现（重要）**：`EchoAgent/data/.env` 实际配置已是 DeepSeek 官方 API——`AI_PRIMARY_API_URL=https://api.deepseek.com`、`AI_PRIMARY_MODEL=deepseek-v4-flash`、key 为 DeepSeek 格式（sk- 开头 35 字符）。**AGENTS.md 中「火山方舟 Ark」的描述已过时**。拿 DeepSeek key 打火山方舟端点会 401 `"The API key format is incorrect"`（已实测确认）。
- 自定义 OpenAI 兼容端点能力（`llm-pi-ai` 插件：`api`/`baseURL`/`models`/`apiKeyEnv`）仍保留，留给未来切其他端点（Settings 页可配）。配置位置：`$DSH_HOME/settings.yaml` 的 `llm-pi-ai:` 段（热加载），或 `--patch` 覆盖 dsh-base 已有行 `llm-pi-ai` 的 config。
- 火山方舟示例见 `.spike/ark.patch.yml`（当前不可用，因为 .env 是 DeepSeek key）。

## 4. MCP 桥接（dsh-mcp-client）— 已跑通连接

- 插件 `@deepseek-ai/dsh-mcp-client`，`inject:["tools"]`（依赖 dsh-base 已挂载的 `dsh-tools` 服务）。
- 传输：`stdio`（本地程序）或 `streamable-http`（服务，Electron 主进程方案用这个）。
- 配置（新增行必须用 `- insert:` 块）：
  ```yaml
  - insert:
      - id: mcp-paper
        name: '@deepseek-ai/dsh-mcp-client'
        config: { serverName: paper, transport: stdio, command: node, args: [...] }
  ```
- **关键坑**：`--patch` 覆盖层只能改**已存在行**的 config（如 llm-pi-ai）；**新增插件行必须包在 `- insert:` 里**，否则报 `patch: entry "mcp-paper" not found` 且插件静默不加载。
- 工具命名：`mcp__<serverName>__<tool>`（与 Claude Code/Codex 一致）。
- 实测：stdio echo server 被拉起并完成 initialize/tools-list 握手（`.spike/mcp-echo-server.mjs` 日志见 `.spike/echo-server.log`）。

## 5. 会话与存储

- 会话持久化：`~/.dsh/sessions/<workspace-key>/<sessionId>/session.jsonl.zstd`（**zstd 压缩**；zstd 在 `C:\Users\Administrator` 环境用 `/d/miniconda3/Library/bin/zstd` 解压）。
- 会话 key 按工作目录编码（如 `--E-personal~0020files-...`）。

## 6. 未解决 / 待办

1. ~~**401 鉴权**~~ **已解决**：根因 = 用 DeepSeek key 打火山方舟端点（见 §3）。dsh 默认 `deepseek-official` 路由 + `DEEPSEEK_API_KEY` 直接可用。
2. **工具调用端到端**：✅ **已打通**（probe-mcp-3 会话）：模型推理 → `REQ tools/call` → `CALL echo_tool {"text":"hello mcp"}`（echo-server.log 实证）。MCP 连接、工具注册、模型调用、结果回传全链路 OK。
3. **bash 陷阱（本机已踩）**：`VAR=x && cmd` **不会**把变量传给子进程，必须 `export VAR=x`。
4. **会话复用陷阱（已踩）**：对**上一轮报错（如 401/MISSING_CREDENTIAL）的会话**再次 `session/prompt`，回合会立即 `turn/end`（seq=6，无任何请求事件）；**换新 sessionId 正常**。agentHost 遇到回合异常时应新建会话重试。
5. **工具调用审批**：approval policy=ask，SDK 模式无 answerer——实测工具调用未被拦截（fail-open 或 ask 未覆盖工具），但**生产环境仍需验证**（涉及文件写操作的工具可能触发审批 fail-closed）。
6. **/compact 等命令**：sdk profile 是纯净运行时（只挂 system-prompt/title/sdk-server），命令是 UI 层能力（`dsh-command-compact`+`dsh-compaction-basic` 需自行挂载并验证触发通道）——P2 事项（用户已拍板自绘助手页 + 命令自实现）。

## 7. 已定架构决策（用户拍板）

- PaperStudio = 自建 Electron 壳（MUI 统一视觉）；AI 助手页自绘（非官方 web UI）；命令自实现（MVP: /compact /new /resume）。
- 论文域能力 → MCP server（P2 起，生产用 streamable-http 挂主进程）。
- dsh 以子进程嵌入（sdk profile，JSON-RPC stdio），封装在 `agentHost.ts` 单点。
- 简单流式任务直连 LLM；多步 agentic 任务（方向/检视/写作）走 dsh。
- 探针文件：`PaperStudio/.spike/`（probe-sdk.mjs / probe-mcp.mjs / mcp-echo-server.mjs / ark.patch.yml / mcp.patch.yml / mcp-abs.patch.yml）。
