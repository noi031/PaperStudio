# PaperStudio · 论文工作台

面向科研工作流的一站式 Web 应用：**检索论文 → 阅读批注 → AI 总结 → 研究方向建议 → 论文写作（LaTeX）→ 分享 PPT**，并内嵌双后端 AI 助手（dsh 引擎 / EchoCap 平台网关，可与工作台数据联动）。

应用由两部分组成，部署在同一个 Node 进程里（`src/host/server.ts`）：
- **Web(Host) 服务端**：静态资源 + `POST /rpc/<channel>`（业务通道）+ `GET /events`（SSE 事件推送）+ `/files/`（产物下载）+ `/upload`（本地文件上传）
- **React 渲染层**：浏览器端只持有一份 `window.paper` 契约（`webBridge.ts` 实现），不持有任何 LLM/CAP 凭证

> 本文档的目标：让任何人（包括 AI 代理）**只读这一份 README，就能从零安装依赖、构建并启动 PaperStudio**。所有命令均以 Windows 10/11 + PowerShell 为例；路径含空格的目录（如 `E:\personal files\...`）命令同样有效。

---

## 功能一览

| 功能 | 说明 |
|---|---|
| 论文检索 | Semantic Scholar + arXiv + OpenAlex 多源并发检索，一键入库、下载 PDF（后台任务 + 进度） |
| 阅读与批注 | PDF 渲染（pdfjs）、选中文本高亮/批注（自定义颜色、批注作者名）、AI 摘要（选中段落 / 全文） |
| 写作 | 以 1 篇主论文 + 多篇参考论文为上下文生成大纲，逐节 AI 撰写 **LaTeX 源码**，导出 `.docx` / `.md` / `.tex` / `.bib`（xelatex 可直接编译） |
| 方向建议 | 基于论文列表生成 3-5 条创意与研究方向 |
| 分享 PPT | AI 生成提纲 → 导出 `.pptx` |
| AI 助手 | 双后端多会话助手（dsh 引擎 / EchoCap 平台网关，设置页可切换），可与工作台数据联动 |

---

## 1. 环境要求

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11 / macOS / Linux | 纯 Node 应用，无平台耦合（Unix Socket 监听在 Windows 上不可用，本地开发用 `ECHO_APP_PORT`） |
| Node.js | **≥ 20.19**（推荐 22.5+） | Vite 8 要求 20.19+；22.5+ 可让 SQLite 走内置 `node:sqlite`（无原生编译）；更低的版本依赖 better-sqlite3 可用 |
| npm | ≥ 10（随 Node 附带） | `npm -v` 检查 |
| Git | 任意较新版本 | 用于拉取代码；`git --version` 检查 |
| 编译工具链 | 仅 better-sqlite3 无预编译二进制时需要（VS Build Tools C++ + Python 3） | 先按第 3 节步骤试装；Node 22.5+ 时 `node:sqlite` 兜底，通常无需编译 |
| 网络 | 可访问 GitHub、npm registry、arXiv / Semantic Scholar | 检索论文和安装依赖需要 |

> 快捷检查：在 PowerShell 执行 `node -v; npm -v; git --version`，三项都有输出即可继续。

---

## 2. 获取代码

```powershell
git clone https://github.com/noi031/PaperStudio.git
cd PaperStudio
```

> 若只是安装使用（不参与开发），到第 3 步 `npm install` 即可；源码结构说明见第 7 节。

---

## 3. 安装依赖

> **仓库不包含 `node_modules/`**（已被 `.gitignore` 忽略，不会随 GitHub 上传）。克隆代码后，在项目根目录（含 `package.json`）执行下面这一条命令即可安装全部 Node 依赖包：

```powershell
npm install
```

安装过程会自动执行 `postinstall` 脚本（`scripts/fix-dsh-dupes.mjs`，修复 dsh 引擎的依赖重复问题），通常无需干预。

> 不再需要为 Electron 重编译原生模块：本应用是纯 Node 服务端，better-sqlite3 只编译一次（Node ABI）；Node 22.5+ 时即使原生模块加载失败也会自动回退内置 `node:sqlite`。

---

## 4. 构建

```powershell
npm run build:host   # 服务端 TypeScript → dist-host/
npm run build        # 类型检查 + 前端产物（Vite → web/，含 pdfjs 字体资源）
```

---

## 5. 启动

### 本地运行（推荐）

```powershell
npm run dev:server   # 构建服务端并启动：http://127.0.0.1:18080
```

等价命令：`npm run build:host && node scripts/start-host.mjs`（本地默认值：端口 18080、数据目录 `storage/`、前端目录 `web/`）。启动成功后浏览器打开 `http://127.0.0.1:18080`。

### 开发模式（前端热更新）

两个终端分别运行：

```powershell
npm run dev:server   # 终端 1：服务端（18080）
npm run dev:renderer # 终端 2：Vite dev server（5173，HMR；/rpc /events /files /upload 已代理到 18080）
```

浏览器打开 `http://127.0.0.1:5173`。

### Echo 平台部署（Web Host）

平台直接运行 `node dist-host/src/host/server.js`，由平台注入环境变量：

| 环境变量 | 说明 |
|---|---|
| `ECHO_APP_SOCKET` | Unix Socket 监听路径（平台优先使用；与 `ECHO_APP_PORT` 二选一） |
| `ECHO_APP_HOST` / `ECHO_APP_PORT` | TCP 监听（兼容旧平台） |
| `ECHO_APP_DATA_DIR` | 数据目录（默认 `<项目根>/storage`） |
| `ECHO_APP_WEB_DIR` | 前端产物目录（默认 `<项目根>/web`） |
| `ECHO_CAP_SOCKET` / `ECHO_CAP_AUTH_KEY` | EchoCap 能力网关（存在时 AI 后端自动选 echocap） |
| `PAPERSTUDIO_BACKEND` | 强制 AI 后端：`dsh` / `echocap`（最高优先级） |

> 安全边界：同时缺失 `ECHO_APP_SOCKET` 与 `ECHO_APP_PORT` 时服务端拒绝启动（不猜端口）。

### 首次启动

1. 浏览器打开应用后，进入左侧「设置」页；
2. 选择 **AI 后端**（默认为「自动」，无需手工选择）：

   | 后端 | 适用场景 | 需要配置 |
   |---|---|---|
   | `dsh`（本机引擎） | 本地独立使用 | **LLM 端点 / API Key / 模型名**（OpenAI 兼容端点） |
   | `echocap`（平台网关） | 运行在 Echo 平台（自动注入 `ECHO_CAP_SOCKET` / `ECHO_CAP_AUTH_KEY`） | 无需任何 LLM 凭证，模型与鉴权由平台提供 |
   | 自动（推荐） | 检测到 EchoCap 环境则用 echocap，否则用 dsh | 同上，按探测结果而定 |

   也可用环境变量强制指定（优先级最高）：`$env:PAPERSTUDIO_BACKEND = "dsh"` 或 `"echocap"`。

   点击「保存」。批注作者名在「用户名」字段配置，两种后端通用。

3. 进入「检索」页搜索论文 →「保存」→「下载 PDF」→ 打开阅读器即可用。
4. 未配置 LLM（dsh 后端）/ 平台网关不可达（echocap 后端）时，检索/下载/批注等本地功能仍可用；AI 类功能（总结、写作、方向、PPT、助手）会提示对应错误。

---

## 6. 数据存储位置（重要）

所有应用数据都存放在**数据目录**（本地默认项目下 `storage/`，平台部署为 `ECHO_APP_DATA_DIR`）：

```
PaperStudio/
└── storage/
    ├── paperstudio.db        # 主数据库：设置/论文/批注/草稿/方向/PPT/会话
    ├── papers/               # 下载的论文 PDF
    ├── exports/              # 导出的 docx/md/tex/bib/pptx
    ├── markdown/             # AI 总结的 Markdown（含 images/ 与渲染后的 .html）
    ├── uploads/              # 浏览器上传的本地 PDF / 论文包暂存
    ├── logs/                 # agent-host.log（代理宿主日志）
    └── .dsh / blob_storage/  # dsh 引擎数据（dsh 后端）
```

- 设置页的「存储目录」留空时默认 `<数据目录>/papers/`；也可自定义绝对路径。
- 备份 = 直接复制整个数据目录。
- 该目录已被 `.gitignore` 忽略，不会提交到代码仓库。

---

## 7. 技术架构（给想改代码的人）

```
src/host/server.ts           # Web(Host) 服务端：静态资源 + /rpc/<channel> + /events(SSE) + /files + /upload
src/host/appContext.ts       # 服务装配：DB/仓储/服务/代理宿主（Electron 版同构，见历史提交）
src/main/*.ts                # 服务层：db/paperRepo/pdfService(含 pdfjs 提取)/summary 等
src/shared/types.ts          # IPC 契约（IpcContract）与领域类型（PaperRecord/DraftRecord…）
src/renderer/                # React 渲染层：页面 + zustand store
  pages/                     #   Library/Search/Reader/Directions/Writing/Presentation/Agent/Settings
  store/                     #   zustand stores（经 window.paper.invoke 调 IPC）
src/main/backend.ts          # AI 后端解析：环境变量 > 设置页 aiBackend > EchoCap 自动探测
src/main/agentHost.ts        # 代理宿主抽象接口 + createAgentHost 工厂
src/main/dshAgentHost.ts     # dsh 引擎托管：子进程 + stdio JSON-RPC + MCP 入口注入
src/main/echocapAgentHost.ts # EchoCap 代理托管：sub_agent 回合轮询 → AgentEvent
src/main/echoCap.ts          # ECHO_CAP 客户端：Unix Socket RPC（sub_agent.send/query、model.call）
src/main/sqlite.ts           # SQLite 适配层：better-sqlite3 优先，纯 Node 环境回退 node:sqlite
src/renderer/webBridge.ts    # 浏览器版 window.paper 桥（HTTP RPC + SSE）
src/renderer/fileLink.ts     # 服务端绝对路径 → /files/<区>/<文件名> 可下载 URL
scripts/start-host.mjs       # 本地启动器（补默认环境变量后拉起服务端）
```

- **双后端切换**：`resolveBackend()`（`src/main/backend.ts`）按「环境变量 `PAPERSTUDIO_BACKEND` → 设置页 `aiBackend` → EchoCap 自动探测」解析；`createAgentHost()` 据此选择 `DshAgentHost` 或 `EchoCapAgentHost`，`llm.ts` 的 `chatText/chatJson/chatTextStream` 按同一规则选择 OpenAI 直连或 `model.call`。
- **IPC 全链路**：按钮 → store action → `window.paper.invoke(channel, payload)` → `POST /rpc/<channel>` → 服务端 handler → 返回。
- **事件推送**：`HostEmit` 抽象 → `GET /events`（SSE）：`agent:event` / `summary:event` / `search:event` / `papers:event`。
- **LLM**：dsh 后端直连 OpenAI 兼容端点（设置页配置，key 存本地 DB）；echocap 后端经平台能力网关，应用不持有任何 LLM 凭证。
- **PDF 下载**：后台任务 + `papers:event` 进度推送（源站限速时整篇可能数分钟，同步等待会被网关判超时）；分片并发下载 + 文件头校验。
- **安全**：CAP 凭证只经 `src/main/echoCap.ts` 在服务端使用；HTTP 层不下发任何凭证；`/files/` 限数据目录白名单并做路径穿越校验。
- **EchoCap 验证**：`npm run build:host && npm run verify:echocap`（详见 `docs/echocap-接入验证.md`）。

---

## 8. 测试

```powershell
npm test
```

> 纯 Node 环境无需 ABI 切换（无 Electron），测试与运行互不干扰；SQLite 测试自动走 better-sqlite3（已安装时）。

---

## 9. 常见问题排查

| 现象 | 原因与解决 |
|---|---|
| 启动报 `缺少 ECHO_APP_SOCKET 或 ECHO_APP_PORT` | 服务端拒绝在未知端口启动：本地用 `npm run dev:server`（自动补默认端口），平台部署由平台注入 |
| 打开 PDF 报 `UnknownErrorException: standardFontDataUrl` | 前端产物缺字体目录：重新执行 `npm run build`（开发模式无需处理） |
| 打开 PDF 报 `Invalid factory url ... must include trailing slash` | 只发生在开发模式加载旧构建缓存：完全停止 dev 进程后重新启动 |
| 检索无结果 / 下载失败 | 检查网络与 arXiv/Semantic Scholar 可达性；「未入库」时先点「保存」再下载 |
| AI 功能报「未配置 LLM API Key」 | dsh 后端：设置页填写 Base URL / 模型名 / API Key 并保存 |
| AI 功能报「EchoCap 不可用」 | echocap 后端：确认进程运行在注入 `ECHO_CAP_SOCKET` / `ECHO_CAP_AUTH_KEY` 的环境中；或改用 dsh 后端 |
| PDF 下载一直「下载中」 | 源站（arXiv 等）单连接限速，后台任务可能需数分钟；进度条会持续更新，可先做别的事 |
| 端口 18080 / 5173 被占用 | 关掉占用进程；`dev:renderer` 的 Vite 固定 5173，服务端端口可用 `$env:ECHO_APP_PORT` 调整 |

---

## 10. 协议

ISC License。本项目仅供学习与科研个人使用。
