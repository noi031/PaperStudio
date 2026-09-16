# PaperStudio · 论文工作台

面向科研工作流的一站式桌面应用（Electron + React）：**检索论文 → 阅读批注 → AI 总结 → 研究方向建议 → 论文写作（LaTeX）→ 分享 PPT**，并内嵌 dsh AI 助手（可与工作台数据联动）。

> 本文档的目标：让任何人（包括 AI 代理）**只读这一份 README，就能从零安装依赖、构建并启动 PaperStudio**。所有命令均以 Windows 10/11 + PowerShell 为例；路径含空格的目录（如 `E:\personal files\...`）命令同样有效。

---

## 功能一览

| 功能 | 说明 |
|---|---|
| 论文检索 | Semantic Scholar + arXiv 双源并发检索，一键入库、下载 PDF |
| 阅读与批注 | PDF 渲染（pdfjs）、选中文本高亮/批注、AI 摘要（选中段落 / 全文） |
| 写作 | 以 1 篇主论文 + 多篇参考论文为上下文生成大纲，逐节 AI 撰写 **LaTeX 源码**，导出 `.docx` / `.md` / `.tex` / `.bib`（xelatex 可直接编译） |
| 方向建议 | 基于论文列表生成 3-5 条创意与研究方向 |
| 分享 PPT | AI 生成提纲 → 导出 `.pptx` |
| AI 助手 | dsh 引擎驱动的多会话助手，可调用工作台数据 |

---

## 1. 环境要求

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11（64 位） | 本应用主要在 Windows 上开发与验证；macOS/Linux 未验证 |
| Node.js | **≥ 20.19**（推荐 22 LTS 及以上） | Vite 8 要求 Node 20.19+；可用 `node -v` 检查 |
| npm | ≥ 10（随 Node 附带） | `npm -v` 检查 |
| Git | 任意较新版本 | 用于拉取代码；`git --version` 检查 |
| 编译工具链 | **Windows 需 VS Build Tools（含 C++ 工作负载）+ Python 3** | 仅当 better-sqlite3 / electron-rebuild 找不到预编译二进制、需要本地编译 native 模块时需要。先用第 3 节步骤试装，若 `electron-rebuild` 失败再补装 |
| 网络 | 可访问 GitHub、npm registry、arXiv / Semantic Scholar | 检索论文和安装依赖需要 |

> 快捷检查：在 PowerShell 执行 `node -v; npm -v; git --version`，三项都有输出即可继续。

---

## 2. 获取代码

```powershell
git clone https://github.com/noi031/PaperStudio.git
cd PaperStudio
```

> 若只是安装使用（不参与开发），到第 3 步 `npm install` 即可；源码结构说明见第 8 节。

---

## 3. 安装依赖

> **仓库不包含 `node_modules/`**（已被 `.gitignore` 忽略，不会随 GitHub 上传）。克隆代码后，在项目根目录（含 `package.json`）执行下面这一条命令即可安装全部 Node 依赖包：

```powershell
npm install
```

安装过程会自动执行 `postinstall` 脚本（`scripts/fix-dsh-dupes.mjs`，修复 dsh 引擎的依赖重复问题），通常无需干预。

安装完成后**必须**为 Electron 重新编译原生模块 better-sqlite3（Node 与 Electron 的 V8 ABI 不同）：

```powershell
npm run rebuild
```

成功标志：输出包含 `✔ Rebuild Complete`（或类似成功的英文提示）。

> - 若 `npm install` 因网络失败，可换镜像：`npm install --registry=https://registry.npmmirror.com`，之后仍需 `npm run rebuild`。
> - 若 `npm run rebuild` 报编译错误（找不到 `node-gyp`、`MSBuild` 等），说明需要补装 **Visual Studio Build Tools**（勾选「使用 C++ 的桌面开发」工作负载）和 **Python 3**（勾选「将 Python 加入 PATH」），装好后重开 PowerShell 再执行 `npm run rebuild`。

---

## 4. 构建

生成主进程编译产物（TypeScript → `dist-electron/`）与渲染层产物（Vite → `dist/`）：

```powershell
npm run build:main
npm run build
```

> `npm run build:main` 编译 Electron 主进程；`npm run build` 做类型检查 + 构建渲染层（`vite build`，会把 pdfjs 字体资源复制进 `dist/`）。两个都成功后再启动。

---

## 5. 启动

### 开发模式（推荐，热更新）

```powershell
npm run dev
```

流程：自动 `electron-rebuild` → 启动 Vite dev server（`http://127.0.0.1:5173`）→ 启动 Electron 窗口。看到应用窗口出现即成功。

### 生产模式（使用构建产物）

```powershell
npm start
```

> 两种模式数据完全一致：都写入项目目录下的 `storage/`（见第 6 节）。

### 首次启动

1. 应用窗口打开后，进入左侧「设置」页；
2. 填写 **LLM 配置**（应用所有 AI 能力依赖一个 OpenAI 兼容的 LLM 端点）：

   | 字段 | 示例 |
   |---|---|
   | Base URL | `http://192.168.1.48:3000/v1`（你自己的端点，需以 `/v1` 结尾） |
   | 模型名 | `deepseek-v4-flash`（与你的端点匹配） |
   | API Key | 你的端点密钥 |

   点击「保存」。若已有 C 盘 `%APPDATA%\paperstudio` 旧数据，启动时会被自动复制迁移到项目 `storage/`（首次启动的迁移是幂等的，失败也不影响使用）。

3. 进入「检索」页搜索论文 →「保存」→「下载 PDF」→ 打开阅读器即可用。
4. 未配置 LLM 时，检索/下载/批注等本地功能仍可用；AI 类功能（总结、写作、方向、PPT、助手）会提示未配置。

---

## 6. 数据存储位置（重要）

所有应用数据都存放在**项目工作目录**下的 `storage/`，不落 C 盘 AppData：

```
PaperStudio/
└── storage/
    ├── paperstudio.db        # 主数据库：设置/论文/批注/草稿/方向/PPT/会话
    ├── papers/               # 下载的论文 PDF
    ├── exports/              # 导出的 docx/md/tex/bib/pptx
    ├── .dsh / blob_storage/  # dsh 引擎数据
    └── …（Electron 自身缓存）
```

- 设置页的「存储目录」留空时默认 `storage/papers/`；也可自定义绝对路径。
- 备份 = 直接复制整个 `storage/` 目录。
- 该目录已被 `.gitignore` 忽略，不会提交到代码仓库。

---

## 7. 测试

```powershell
npm test
```

> 注意：`npm test` 会先把 better-sqlite3 重编译为 **Node ABI** 用于跑单测；**测完再启动应用前，必须重新执行**：
>
> ```powershell
> npm run rebuild
> ```
>
> 否则启动应用会报 `NODE_MODULE_VERSION` 不匹配错误。这是本项目唯一的 ABI 坑，务必记住。

---

## 8. 技术架构（给想改代码的人）

```
electron/main.ts         # 主进程入口：storage 重定向/迁移、创建窗口、注册 IPC、管理 dsh 引擎
src/main/*.ts            # 主进程服务：db/paperRepo/pdfService(含 pdfjs 提取)/summary 等
src/shared/types.ts      # IPC 契约（IpcContract）与领域类型（PaperRecord/DraftRecord…）
src/renderer/            # React 渲染层：页面 + zustand store
  pages/                 #   Library/Search/Reader/Directions/Writing/Presentation/Agent/Settings
  store/                 #   zustand stores（经 preload 的 window.paper.invoke 调 IPC）
src/main/agentHost.ts    # dsh 引擎托管：子进程 + MCP 入口注入
```

- **IPC 全链路**：按钮 → store action → `window.paper.invoke(channel, payload)` → `ipcMain.handle` → 主进程服务 → 返回。
- **LLM**：所有 AI 功能直连主进程调用 OpenAI 兼容端点（设置页配置，key 存本地 DB），不经过渲染层。
- **PDF 渲染**：pdfjs-dist v5；开发模式从 `/node_modules/pdfjs-dist/` 伺服字体/cmap，构建模式复制到 `dist/`。
- **打包**：尚未配置 NSIS 安装包；当前以 `npm run dev` / `npm start` 运行。

---

## 9. 常见问题排查

| 现象 | 原因与解决 |
|---|---|
| 启动报 `NODE_MODULE_VERSION` 不匹配 | better-sqlite3 是 Node ABI（跑了 `npm test` 后常见）。执行 `npm run rebuild` 切回 Electron ABI |
| 打开 PDF 报 `UnknownErrorException: standardFontDataUrl` | 渲染层产物缺字体目录：重新执行 `npm run build`（开发模式无需处理） |
| 打开 PDF 报 `Invalid factory url ... must include trailing slash` | 只发生在开发模式加载旧构建缓存：完全停止 `npm run dev`（Ctrl+C 两次）后重新启动 |
| 检索无结果 / 下载失败 | 检查网络与 arXiv/Semantic Scholar 可达性；「未入库」时先点「保存」再下载 |
| AI 功能报「未配置 LLM API Key」 | 设置页填写 Base URL / 模型名 / API Key 并保存 |
| `npm install` 卡在 better-sqlite3 编译 | 补装 VS Build Tools（C++ 桌面开发）+ Python 3 后重试，或使用 npmmirror 镜像 |
| 端口 5173 被占用 | 关掉占用进程，或改用 `npm run dev:renderer` 只启动前端调试 |

---

## 10. 协议

ISC License。本项目仅供学习与科研个人使用。