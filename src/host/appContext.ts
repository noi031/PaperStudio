// Web 宿主装配：服务端应用的全部服务装配逻辑（DB / 仓储 / 服务 / 代理宿主）。
//
// 同一套 src/main 服务层与同一份 IPC 契约（通道名、请求/响应形状完全一致）；
// HandlerRegistrar 与 HostEmit 由 src/host/server.ts 实现（HTTP RPC + SSE）。
//
// AI 后端按 backend.ts 解析（环境变量 / 设置 / EchoCap 自动探测）：
//  echocap —— Echo 平台注入的 Unix Socket 能力网关（Web 部署默认形态）；
//  dsh    —— 本机 deepseek-harness 子进程（需 node_modules 含 @deepseek-ai/dsh）。
import fs from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from '../main/db.js';
import { createAgentHost } from '../main/agentHost.js';
import { AgentRepo } from '../main/agentRepo.js';
import { AgentService } from '../main/agentService.js';
import { DirectionRepo } from '../main/directionRepo.js';
import { DraftRepo } from '../main/draftRepo.js';
import { NoteRepo } from '../main/noteRepo.js';
import { PaperRepo } from '../main/paperRepo.js';
import { PdfService, resolveStorageDir } from '../main/pdfService.js';
import { PresentationRepo } from '../main/presentationRepo.js';
import { SummaryRepo } from '../main/summaryRepo.js';
import { SummaryService } from '../main/summaryService.js';
import { QaService } from '../main/qaService.js';
import { backendLabel, resolveBackend } from '../main/backend.js';
import type { HostEmit, IpcDeps } from '../main/ipc.js';

export interface AppContext {
  deps: IpcDeps;
  /** 数据根目录（ECHO_APP_DATA_DIR）。 */
  storageRoot: string;
  /** 论文 PDF 目录。 */
  storageDir: string;
  /** 导出文件目录（docx/md/tex/bib/pptx）。 */
  exportDir: string;
  /** 总结 Markdown 目录（含 images/ 与渲染后的 .html）。 */
  markdownDir: string;
  /** 上传暂存目录（浏览器上传的本地 PDF / 论文包）。 */
  uploadDir: string;
  agentService: AgentService;
  db: Db;
  dispose(): Promise<void>;
}

export interface CreateAppContextOptions {
  /** 数据根目录；App Runtime 传 ECHO_APP_DATA_DIR。 */
  storageRoot: string;
  /** 事件广播器（SSE）。 */
  emit: HostEmit;
}

export function createAppContext(opts: CreateAppContextOptions): AppContext {
  const storageRoot = opts.storageRoot;
  fs.mkdirSync(storageRoot, { recursive: true });

  const db = openDb(path.join(storageRoot, 'paperstudio.db'));

  // 代理宿主日志：沿用 Electron 版的落盘位置（storage/logs/agent-host.log）。
  const engineLogPath = path.join(storageRoot, 'logs', 'agent-host.log');
  fs.mkdirSync(path.dirname(engineLogPath), { recursive: true });
  const appendLog = (line: string): void => {
    try {
      fs.appendFileSync(engineLogPath, `[${new Date().toISOString()}] ${line}`);
    } catch {
      /* 日志失败不影响运行 */
    }
  };

  const backend = resolveBackend(() => db.getSettings());
  console.log(`[paperstudio] AI 后端：${backendLabel(backend)}`);

  const host = createAgentHost({
    // userDataDir 仅 dsh 后端使用（写 dsh-mcp.patch.yml + DSH_HOME 默认目录），
    // 指到数据目录避免把运行时产物落到项目根。
    userDataDir: storageRoot,
    settings: () => db.getSettings(),
    onLog: (line) => appendLog(`[host] ${line}\n`),
  });

  const agentService = new AgentService({
    repo: new AgentRepo(db),
    host,
    getSettings: () => db.getSettings(),
    emit: opts.emit,
  });

  // 论文域 MCP server 入口（编译产物 dist-host/src/main/mcpServer.js）：dsh 后端启动时
  // 注入引擎；echocap 后端接收后忽略（代理侧使用平台自带工具集）。
  agentService.setMcpEntry(path.join(__dirname, '..', 'src', 'main', 'mcpServer.js'));

  const settings = db.getSettings();
  const storageDir = resolveStorageDir(settings.storageDir, path.join(storageRoot, 'papers'));
  fs.mkdirSync(storageDir, { recursive: true });
  const exportDir = path.join(storageRoot, 'exports');
  fs.mkdirSync(exportDir, { recursive: true });
  const markdownDir = path.join(storageRoot, 'markdown');
  fs.mkdirSync(markdownDir, { recursive: true });
  const uploadDir = path.join(storageRoot, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const summaries = new SummaryRepo(db.raw);
  const summary = new SummaryService({
    getSettings: () => db.getSettings(),
    emit: opts.emit,
    markdownDir,
    insertSummary: (paperId, kind, content, model, mdPath) => {
      // 刷新制：同类型总结覆盖旧的（先删旧再插新），与原实现一致。
      summaries.replace(paperId, kind, content, model, mdPath);
    },
  });
  const qa = new QaService({ getSettings: () => db.getSettings(), emit: opts.emit });

  const deps: IpcDeps = {
    emit: opts.emit,
    db,
    agent: agentService,
    papers: new PaperRepo(db.raw),
    pdf: new PdfService(storageDir),
    summaries,
    summary,
    qa,
    directions: new DirectionRepo(db.raw),
    drafts: new DraftRepo(db.raw),
    presentations: new PresentationRepo(db.raw),
    notes: new NoteRepo(db.raw),
    getSettings: () => db.getSettings(),
    storageDir,
    exportDir,
    markdownDir,
  };

  return {
    deps,
    storageRoot,
    storageDir,
    exportDir,
    markdownDir,
    uploadDir,
    agentService,
    db,
    async dispose() {
      await agentService.dispose();
      db.close();
    },
  };
}
