// Electron 主进程入口（薄壳）：创建窗口、注册 IPC、管理 DB 与 dsh 引擎生命周期。
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { openDb, type Db } from '../src/main/db.js';
import { registerIpc } from '../src/main/ipc.js';
import { AgentRepo } from '../src/main/agentRepo.js';
import { AgentHost } from '../src/main/agentHost.js';
import { AgentService } from '../src/main/agentService.js';
import { PaperRepo } from '../src/main/paperRepo.js';
import { PdfService, resolveStorageDir } from '../src/main/pdfService.js';
import { SummaryRepo } from '../src/main/summaryRepo.js';
import { SummaryService } from '../src/main/summaryService.js';
import { DirectionRepo } from '../src/main/directionRepo.js';
import { DraftRepo } from '../src/main/draftRepo.js';
import { PresentationRepo } from '../src/main/presentationRepo.js';
import { NoteRepo } from '../src/main/noteRepo.js';

let db: Db | null = null;
let agentService: AgentService | null = null;

// ── 存储重定向：数据全部放在项目工作目录（跟源代码在一起），不落 C 盘 AppData ──
// dev 运行（electron .）时 appPath = 项目根；打包后回退 userData（避免 asar 不可写）。
const legacyUserData = app.getPath('userData');
const packaged = app.isPackaged;
const storageRoot = packaged ? legacyUserData : path.join(app.getAppPath(), 'storage');
if (!packaged) {
  // 影响范围：DB、papers、导出、dsh 引擎数据、Electron 缓存，全部进 <项目>/storage/
  app.setPath('userData', storageRoot);
}

/** 首启迁移：把 C 盘 AppData 下的旧数据（DB/papers/dsh）复制到项目 storage/，并修正 pdf_path。 */
async function migrateLegacyData(): Promise<void> {
  if (packaged) return;
  const newDbPath = path.join(storageRoot, 'paperstudio.db');
  if (fs.existsSync(newDbPath)) return; // 已迁移过
  const legacyDb = path.join(legacyUserData, 'paperstudio.db');
  if (!fs.existsSync(legacyDb)) return; // 首次全新安装，无需迁移
  fs.mkdirSync(storageRoot, { recursive: true });
  try {
    // 一致性快照：checkpoint 后 backup（better-sqlite3 backup 是异步 API，必须 await）
    const srcDb = new Database(legacyDb);
    try {
      srcDb.pragma('wal_checkpoint(TRUNCATE)');
      await srcDb.backup(newDbPath);
    } finally {
      srcDb.close();
    }
    // papers / dsh 引擎数据 / 配置副本
    const legacyPapers = path.join(legacyUserData, 'papers');
    const newPapers = path.join(storageRoot, 'papers');
    if (fs.existsSync(legacyPapers)) fs.cpSync(legacyPapers, newPapers, { recursive: true });
    for (const sub of ['.dsh', 'blob_storage', 'dsh-mcp.patch.yml', 'settings-dump.txt']) {
      const src = path.join(legacyUserData, sub);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(storageRoot, sub), { recursive: true });
    }
    // 修正库内 pdf_path 的绝对路径前缀（旧 C 盘路径 → 新项目路径）
    const migrated = new Database(newDbPath);
    try {
      const rows = migrated
        .prepare('SELECT id, pdf_path FROM papers WHERE pdf_path IS NOT NULL')
        .all() as Array<{ id: string; pdf_path: string }>;
      const upd = migrated.prepare('UPDATE papers SET pdf_path = ? WHERE id = ?');
      for (const r of rows) {
        const name = path.basename(r.pdf_path);
        if (fs.existsSync(path.join(newPapers, name))) upd.run(path.join(newPapers, name), r.id);
      }
    } finally {
      migrated.close();
    }
    console.log(`[PaperStudio] 数据已从 ${legacyUserData} 迁移到 ${storageRoot}`);
  } catch (err) {
    console.error('[PaperStudio] 数据迁移失败（将使用新空库）:', err);
  }
}

function dbPath(): string {
  fs.mkdirSync(storageRoot, { recursive: true });
  return path.join(storageRoot, 'paperstudio.db');
}

function mcpEntryPath(): string {
  // 与主进程同构编译产物：dist-electron/src/main/mcpServer.js
  return path.join(__dirname, '..', 'src', 'main', 'mcpServer.js');
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // PDF 内链接（target=_blank）→ 新开应用内窗口加载目标网页，不覆盖阅读器；
  // 新窗口里的链接再交系统浏览器。同时兜底阻止主窗口被任何导航覆盖。
  win.webContents.setWindowOpenHandler(({ url }) => {
    const child = new BrowserWindow({
      width: 1200,
      height: 850,
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    void child.loadURL(url);
    child.webContents.setWindowOpenHandler(({ url: u2 }) => {
      void shell.openExternal(u2);
      return { action: 'deny' };
    });
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const current = win.webContents.getURL();
    if (url === current) return;
    const isLocal = url.startsWith('file://') || (devUrl && url.startsWith(devUrl));
    if (!isLocal) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

app.whenReady().then(async () => {
  // 首启迁移（把 C 盘旧数据搬到项目 storage/）在打开 DB 前完成
  await migrateLegacyData();
  db = openDb(dbPath());
  const appRoot = app.getAppPath();
  const host = new AgentHost({
    appRoot,
    userDataDir: app.getPath('userData'),
    settings: () => db!.getSettings(),
  });
  agentService = new AgentService({
    repo: new AgentRepo(db),
    host,
    getSettings: () => db!.getSettings(),
    getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
  });
  // MCP 入口在 dsh 引擎首次启动前注入。
  agentService.setMcpEntry(mcpEntryPath());

  const settings = db.getSettings();
  // PDF 存储目录：默认 <storageRoot>/papers（可在设置页自定义）；导出统一到 <storageRoot>/exports
  const storageDir = resolveStorageDir(settings.storageDir, path.join(storageRoot, 'papers'));
  fs.mkdirSync(storageDir, { recursive: true });
  const exportDir = path.join(storageRoot, 'exports');
  fs.mkdirSync(exportDir, { recursive: true });
  const papers = new PaperRepo(db.raw);
  const pdf = new PdfService(storageDir);
  const summaries = new SummaryRepo(db.raw);
  const summary = new SummaryService({
    getSettings: () => db!.getSettings(),
    getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    insertSummary: (paperId, kind, content, model) => {
      // 刷新制：同类型总结覆盖旧的（先删旧再插新），不保留历史。
      summaries.replace(paperId, kind, content, model);
    },
  });

  registerIpc(ipcMain, {
    db,
    agent: agentService,
    papers,
    pdf,
    summaries,
    summary,
    directions: new DirectionRepo(db.raw),
    drafts: new DraftRepo(db.raw),
    presentations: new PresentationRepo(db.raw),
    notes: new NoteRepo(db.raw),
    getSettings: () => db!.getSettings(),
    storageDir,
    exportDir,
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  void agentService?.dispose().finally(() => {
    db?.close();
    db = null;
  });
});
