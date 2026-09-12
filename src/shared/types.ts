// PaperStudio IPC 契约：渲染进程 ↔ 主进程。新增通道在此声明类型。

export interface PaperSettings {
  username: string;
  storageDir: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmContextWindow: number;
  echoMemEnabled: boolean;
  echoMemEndpoint: string;
  echoMemAgentId: string;
  echoMemAuthKey: string;
}

export const DEFAULT_SETTINGS: PaperSettings = {
  username: 'me',
  storageDir: '',
  llmBaseUrl: 'https://api.deepseek.com',
  llmApiKey: '',
  llmModel: 'deepseek-v4-flash',
  llmContextWindow: 128000,
  echoMemEnabled: false,
  echoMemEndpoint: 'http://127.0.0.1:8010',
  echoMemAgentId: 'paperstudio',
  echoMemAuthKey: '',
};

export type IpcChannel =
  | 'settings:get'
  | 'settings:save'
  | 'db:ping'
  | 'agent:health'
  | 'agent:listSessions'
  | 'agent:createSession'
  | 'agent:deleteSession'
  | 'agent:listMessages'
  | 'agent:sendMessage'
  | 'search:run'
  | 'papers:list'
  | 'papers:save'
  | 'papers:delete'
  | 'papers:downloadPdf'
  | 'reader:open'
  | 'summaries:list'
  | 'summary:run'
  | 'notes:list'
  | 'notes:add'
  | 'notes:delete'
  | 'directions:list'
  | 'directions:generate'
  | 'directions:delete'
  | 'drafts:list'
  | 'drafts:create'
  | 'drafts:delete'
  | 'drafts:generateOutline'
  | 'drafts:writeSection'
  | 'drafts:setSection'
  | 'drafts:export'
  | 'presentations:list'
  | 'presentations:create'
  | 'presentations:generateSlides'
  | 'presentations:delete'
  | 'presentations:export';

export interface AgentSessionLite {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMessageLite {
  id: string;
  role: string;
  kind: string;
  content: string;
  createdAt: number;
}

export interface IpcContract {
  'settings:get': { req: void; res: PaperSettings };
  'settings:save': { req: Partial<PaperSettings>; res: PaperSettings };
  'db:ping': { req: void; res: string };
  'agent:health': { req: void; res: { ok: boolean; version?: string; message?: string } };
  'agent:listSessions': { req: void; res: AgentSessionLite[] };
  'agent:createSession': { req: { title?: string; context?: string }; res: AgentSessionLite };
  'agent:deleteSession': { req: { id: string }; res: void };
  'agent:listMessages': { req: { id: string }; res: AgentMessageLite[] };
  'agent:sendMessage': { req: { id: string; text: string }; res: { ok: boolean } };
  'search:run': { req: { query: string; limit?: number }; res: { hits: PaperHit[]; warnings: string[] } };
  'papers:list': { req: void; res: PaperRecord[] };
  'papers:save': { req: { hit: PaperHit }; res: PaperRecord };
  'papers:delete': { req: { id: string }; res: void };
  'papers:downloadPdf': { req: { id: string }; res: { ok: boolean; path?: string; message?: string } };
  'reader:open': {
    req: { id: string };
    res: { title: string; data: Uint8Array; pdfPath: string } | { error: string };
  };
  'summaries:list': { req: { paperId: string }; res: SummaryRecord[] };
  'summary:run': { req: { paperId: string; kind: SummaryKind; text: string }; res: { id: string } };
  // ── 行内批注 ──
  'notes:list': { req: { paperId: string }; res: NoteRecord[] };
  'notes:add': {
    req: { paperId: string; page: number; type: NoteType; text: string; content: string };
    res: NoteRecord;
  };
  'notes:delete': { req: { id: string }; res: void };
  // ── P5 方向建议 ──
  'directions:list': { req: void; res: DirectionRecord[] };
  'directions:generate': {
    req: { paperIds: string[] };
    res: { ok: boolean; record?: DirectionRecord; message?: string };
  };
  'directions:delete': { req: { id: string }; res: void };
  // ── P6 写作 ──
  'drafts:list': { req: void; res: DraftRecord[] };
  'drafts:create': {
    req: { paperId: string | null; title: string; referenceIds?: string[] };
    res: DraftRecord;
  };
  'drafts:delete': { req: { id: string }; res: void };
  'drafts:generateOutline': {
    req: { id: string };
    res: { ok: boolean; record?: DraftRecord; message?: string };
  };
  'drafts:writeSection': {
    req: { id: string; index: number };
    res: { ok: boolean; record?: DraftRecord; message?: string };
  };
  'drafts:setSection': {
    req: { id: string; index: number; content: string };
    res: DraftRecord;
  };
  'drafts:export': {
    req: { id: string; format?: 'docx' | 'md' | 'tex' | 'bib' };
    res: { ok: boolean; path?: string; message?: string };
  };
  // ── P7 演示 ──
  'presentations:list': { req: void; res: PresentationRecord[] };
  'presentations:create': { req: { paperId: string | null; title: string }; res: PresentationRecord };
  'presentations:generateSlides': {
    req: { id: string };
    res: { ok: boolean; record?: PresentationRecord; message?: string };
  };
  'presentations:delete': { req: { id: string }; res: void };
  'presentations:export': {
    req: { id: string };
    res: { ok: boolean; path?: string; message?: string };
  };
}

export type IpcRequest<K extends IpcChannel> = IpcContract[K]['req'];
export type IpcResponse<K extends IpcChannel> = IpcContract[K]['res'];

// ── P3 读的闭环 ────────────────────────────────────────────

/** 检索命中（尚未入库）。source 区分数据源；externalId 为 arXiv id 或 S2 paperId。 */
export interface PaperHit {
  source: 'arxiv' | 'semantic_scholar';
  externalId: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  abstract: string | null;
  url: string | null;
  pdfUrl: string | null;
}

/** 库内论文记录（papers 表行）。pdfPath 为绝对路径，可为空（未下载）。 */
export interface PaperRecord {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  abstract: string | null;
  source: string;
  externalId: string;
  url: string | null;
  pdfUrl: string | null;
  pdfPath: string | null;
  addedAt: number;
}

export type SummaryKind = 'selected' | 'full';

export interface SummaryRecord {
  id: string;
  paperId: string;
  kind: SummaryKind;
  content: string;
  model: string | null;
  createdAt: number;
}

/** summary:event 推送负载（渲染层 window.paper.onSummaryEvent 订阅）。 */
export type SummaryEvent =
  | { id: string; kind: 'delta'; text: string }
  | { id: string; kind: 'done' }
  | { id: string; kind: 'error'; message: string };

// ── 行内批注 ────────────────────────────────────────────────

export type NoteType = 'highlight' | 'comment';

export interface NoteRecord {
  id: string;
  paperId: string;
  page: number;
  type: NoteType;
  /** 被批注的原文片段（用于高亮回放）。 */
  text: string;
  /** 批注内容（评论文字；高亮可为空）。 */
  content: string;
  author: string;
  createdAt: number;
}

// ── P5 方向建议 ────────────────────────────────────────────

export interface DirectionSuggestion {
  title: string;
  description: string;
  nextSteps: string[];
}

export interface DirectionRecord {
  id: string;
  /** 生成时的上下文（参与论文的标题列表快照）。 */
  context: string;
  suggestions: DirectionSuggestion[];
  status: string;
  createdAt: number;
}

// ── P6 写作 ────────────────────────────────────────────────

export interface DraftOutlineItem {
  heading: string;
  description: string;
}

export interface DraftSection {
  heading: string;
  content: string;
}

export interface DraftRecord {
  id: string;
  paperId: string | null;
  title: string;
  outline: DraftOutlineItem[];
  sections: DraftSection[];
  format: string;
  exportedPath: string | null;
  /** 参考论文 id 列表（生成大纲/撰写时作为写作格式与内容参考） */
  referenceIds: string[];
  createdAt: number;
}

// ── P7 演示 ────────────────────────────────────────────────

export interface SlideItem {
  title: string;
  bullets: string[];
  note?: string;
}

export interface PresentationRecord {
  id: string;
  sourceType: string;
  sourceId: string | null;
  title: string;
  slides: SlideItem[];
  pptxPath: string | null;
  createdAt: number;
}
