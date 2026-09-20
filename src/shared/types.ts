// PaperStudio IPC 契约：渲染进程 ↔ 主进程。新增通道在此声明类型。

export interface PaperSettings {
  username: string;
  storageDir: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmContextWindow: number;
  /** 总结/写作等任务的输入截断上限（字符数，防超上下文）。 */
  llmMaxInputChars: number;
  /** LLM 输出 token 上限（不传时多数服务默认 4096，长总结会被截断）。 */
  llmMaxOutputTokens: number;
  echoMemEnabled: boolean;
  echoMemEndpoint: string;
  echoMemAgentId: string;
  echoMemAuthKey: string;
  /** 可编辑提示词模板（留空则用内置默认）。 */
  promptSummarySelected: string;
  promptSummaryFull: string;
  promptDirections: string;
  promptSlides: string;
  promptOutline: string;
  promptSection: string;
  /** Semantic Scholar API key（可选）：无 key 检索限流极严（429），配 key 可大幅提高额度。 */
  semanticScholarApiKey: string;
  /** AI 后端：'dsh'（本机 dsh 引擎）/ 'echocap'（Echo 平台能力网关）/ ''（自动：检测到 EchoCap 环境则 echocap，否则 dsh）。 */
  aiBackend: '' | 'dsh' | 'echocap';
}

export const DEFAULT_SETTINGS: PaperSettings = {
  username: 'me',
  storageDir: '',
  llmBaseUrl: 'https://api.deepseek.com',
  llmApiKey: '',
  llmModel: 'deepseek-v4-flash',
  llmContextWindow: 128000,
  llmMaxInputChars: 120000,
  llmMaxOutputTokens: 8000,
  echoMemEnabled: false,
  echoMemEndpoint: 'http://127.0.0.1:8010',
  echoMemAgentId: 'paperstudio',
  echoMemAuthKey: '',
  // 以下提示词与各服务内置默认一致；在设置页可覆盖（留空恢复默认）。
  promptSummarySelected:
    '你是论文精读助手。用户选中了一段论文原文，请用中文解释这段内容：它在讲什么、在论文中起什么作用、有哪些关键概念。' +
    '输出 Markdown 格式：第一行 # 标题（概括这段内容），用 ## 小节、- 列表、**加粗** 组织，控制在 300-600 字。' +
    '如果系统提供的论文图表清单中包含与本段内容相关的图表，请用 Markdown 图片语法引用它（![第X页图](images/.../fig-X.png)），做到图文并茂；需要对比的数据用 Markdown 表格（如 | 指标 | 数值 |）呈现。' +
    '数学公式一律用纯文本表达（如 γ、B±→D(K0S h′+h′−)h±、x²），禁止使用任何 LaTeX 记号（$、\\(、\\frac、\\gamma 等）。',
  promptSummaryFull:
    '你是论文精读助手。请对整篇论文做结构化总结，按「背景 / 方法 / 结果 / 贡献与局限」四部分。' +
    '输出 Markdown 格式：# 标题（论文标题）、## 背景、## 方法、## 结果、## 贡献与局限，用 - 列表和 **加粗** 组织，800-1500 字。' +
    '请图文并茂：系统会提供论文图表清单（含图片引用路径），在总结中与图表相关的小节必须用 Markdown 图片语法引用论文原图（如 ![第3页图](images/.../fig-3.png)，路径按清单原样给出）；需要对比的数据用 Markdown 表格（如 | 指标 | 数值 |）呈现。' +
    '数学公式一律用纯文本表达（如 γ、B±→D(K0S h′+h′−)h±、x²），禁止使用任何 LaTeX 记号（$、\\(、\\frac、\\gamma 等）。',
  promptDirections:
    '你是研究方向规划专家。基于用户给出的论文列表，提出 3-5 个有前景、可落地的研究方向。' +
    '每个方向包含：title（简短标题）、description（1-3 句说明：为什么值得做、切入角度）、nextSteps（2-4 条具体下一步）。' +
    '输出 JSON：{"suggestions":[{"title":"...","description":"...","nextSteps":["...","..."]}]}。' +
    '数学公式一律用纯文本表达（如 γ、x²、B±→D），禁止使用任何 LaTeX 记号。',
  promptSlides:
    '你是演示文稿专家。根据论文信息生成 8-12 页幻灯片的提纲：第一页为标题页，最后一页为总结/展望。' +
    '每页包含 title（短标题）与 bullets（3-5 条要点，每条一行、一页内放得下），可选 note（演讲备注）。' +
    '输出 JSON 数组：[{"title":"...","bullets":["...","..."],"note":"..."}]。' +
    '数学公式一律用纯文本表达（如 γ、x²、B±→D），禁止使用任何 LaTeX 记号。',
  promptOutline:
    '你是学术写作助手。用户会给出 1-N 篇参考论文（标题/作者/年份/摘要），请参考它们的结构与写作风格，' +
    '为新论文生成 8-12 节大纲。每个小节给出 heading 与 description（该节要写什么、包含哪些小节）。' +
    '输出 JSON 数组：[{"heading":"...","description":"..."}]。' +
    'heading 用论文语言（中文或英文均可，保留必要术语），description 中数学公式可用 LaTeX 记号描述（如 $\\gamma$、$B^\\pm \\to D(K^0_S h^{\\prime +} h^{\\prime -}) h^\\pm$）。',
  promptSection:
    '你是学术写作助手。根据参考论文信息与大纲，为指定小节撰写 LaTeX 论文初稿：逻辑清晰、内容扎实，500-1200 字。' +
    '必须用 LaTeX 源码输出：数学公式一律用标准 LaTeX 记号（如 $\\gamma$、$E = mc^2$、$\\frac{a}{b}$、$B^\\pm \\to D^0 K^\\pm$），' +
    '需要引用参考论文时用 \\cite{key}（key 格式为 ref1、ref2…，对应参考论文序号），列表用 itemize/enumerate，强调用 \\textbf{}。' +
    '只输出小节正文源码（不要 \\section{}、\\begin{document} 等外壳），第一行不要重复小节标题。',
  semanticScholarApiKey: '',
  // 留空 = 自动：检测到 EchoCap 环境（ECHO_CAP_SOCKET/鉴权 key）则用 echocap，否则用本机 dsh。
  aiBackend: '',
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
  | 'agent:stop'
  | 'search:run'
  | 'papers:list'
  | 'papers:save'
  | 'papers:delete'
  | 'papers:downloadPdf'
  | 'papers:downloadStop'
  | 'reader:open'
  | 'summaries:list'
  | 'summary:run'
  | 'qa:run'
  | 'notes:list'
  | 'notes:add'
  | 'notes:update'
  | 'notes:delete'
  | 'notes:export'
  | 'notes:import'
  | 'directions:list'
  | 'directions:generate'
  | 'directions:delete'
  | 'drafts:list'
  | 'drafts:create'
  | 'drafts:delete'
  | 'drafts:generateOutline'
  | 'drafts:writeSection'
  | 'drafts:setSection'
  | 'drafts:setOutline'
  | 'drafts:setReferences'
  | 'drafts:export'
  | 'markdown:open'
  | 'markdown:preview'
  | 'preview:latex'
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
  'agent:stop': { req: { id: string }; res: void };
  'search:run': {
    req: { query: string; limit?: number; offset?: number; cursor?: string };
    res: { hits: PaperHit[]; warnings: string[]; nextCursor?: string | null };
  };
  'search:agentic': {
    req: { question: string };
    res: {
      ok: boolean;
      hits?: PaperHit[];
      queries?: string[];
      relevance?: Record<string, { level: '高' | '中' | '低'; reason: string }>;
      warnings?: string[];
      message?: string;
    };
  };
  'papers:list': { req: void; res: PaperRecord[] };
  'papers:save': { req: { hit: PaperHit }; res: PaperRecord };
  'papers:delete': { req: { id: string }; res: void };
  'papers:downloadPdf': {
    req: { id: string; force?: boolean };
    res: { ok: boolean; status?: 'started' | 'running' | 'done'; path?: string; message?: string };
  };
  'papers:downloadStop': { req: { id: string }; res: { ok: boolean; message?: string } };
  'papers:importLocalPdf': { req: { path: string }; res: { ok: boolean; paper?: PaperRecord; message?: string } };
  'paper:exportBundle': { req: { id: string }; res: { ok: boolean; path?: string; message?: string } };
  'paper:importBundle': { req: { path: string }; res: { ok: boolean; paper?: PaperRecord; message?: string } };
  'reader:open': {
    req: { id: string };
    res: { title: string; data: Uint8Array; pdfPath: string } | { error: string };
  };
  'summaries:list': { req: { paperId: string }; res: SummaryRecord[] };
  'summary:run': {
    req: { paperId: string; kind: SummaryKind; text: string; images?: Array<{ page: number; dataUrl: string }> };
    res: { id: string };
  };
  'qa:run': {
    req: { paperId: string; paperTitle: string; fullText: string; question: string };
    res: { id: string };
  };
  'markdown:open': { req: { path: string }; res: { ok: boolean; message?: string; url?: string } };
  // 写作整篇预览：渲染层给 Markdown 内容，服务端渲染 HTML 后返回可访问 URL。
  'markdown:preview': {
    req: { name: string; content: string };
    res: { ok: boolean; message?: string; url?: string };
  };
  // 全文预览（与逐节预览同一渲染函数）：渲染层给结构化 LaTeX 内容，服务端 renderLatexHtml 逐节渲染拼接。
  'preview:latex': {
    req: {
      name: string;
      title?: string;
      sections?: Array<{ heading?: string; description?: string; content?: string }>;
    };
    res: { ok: boolean; message?: string; url?: string };
  };
  // ── 行内批注 ──
  'notes:list': { req: { paperId: string }; res: NoteRecord[] };
  'notes:add': {
    req: { paperId: string; page: number; type: NoteType; text: string; content: string; color?: string | null };
    res: NoteRecord;
  };
  'notes:update': {
    req: { id: string; content?: string; type?: NoteType; text?: string; color?: string | null };
    res: NoteRecord | null;
  };
  'notes:delete': { req: { id: string }; res: void };
  'notes:export': {
    req: { paperId: string };
    res: { ok: boolean; path?: string; imported?: number; message?: string };
  };
  'notes:import': {
    req: { paperId: string; json: string };
    res: { ok: boolean; path?: string; imported?: number; message?: string };
  };
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
    req: { id: string; index: number; instruction?: string; existing?: string };
    res: { ok: boolean; record?: DraftRecord; message?: string };
  };
  'drafts:setSection': {
    req: { id: string; index: number; content: string };
    res: DraftRecord;
  };
  'drafts:setOutline': {
    req: { id: string; outline: DraftOutlineItem[] };
    res: DraftRecord;
  };
  'drafts:setReferences': {
    req: { id: string; referenceIds: string[] };
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
  source: 'arxiv' | 'semantic_scholar' | 'openalex' | 'local';
  externalId: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  abstract: string | null;
  url: string | null;
  pdfUrl: string | null;
}

/** 库内论文记录（papers 表行）。pdfPath 为绝对路径，可为空（未下载）；
 *  lastReadAt 为最近一次在阅读器打开的时间戳，可为空（从未打开）。 */
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
  lastReadAt: number | null;
}

export type SummaryKind = 'selected' | 'full';

export interface SummaryRecord {
  id: string;
  paperId: string;
  kind: SummaryKind;
  content: string;
  model: string | null;
  createdAt: number;
  /** 生成的 Markdown 文件绝对路径（工作目录 storage/markdown 下）；旧记录为 null。 */
  mdPath: string | null;
}

/** summary:event 推送负载（渲染层 window.paper.onSummaryEvent 订阅）。 */
export type SummaryEvent =
  | { id: string; kind: 'delta'; text: string }
  | { id: string; kind: 'done' }
  | { id: string; kind: 'error'; message: string };

/** qa:event 推送负载（阅读器 AI 问答：回答完成后生成 Markdown，done 携带文件路径）。 */
export type QaEvent =
  | { id: string; kind: 'delta'; text: string }
  | { id: string; kind: 'done'; mdPath: string | null }
  | { id: string; kind: 'error'; message: string };

/**
 * papers:event 推送负载（渲染层 window.paper.onPapersEvent 订阅）。
 *
 * PDF 下载改为后台任务：源站（arXiv 等）单连接限速严重，整篇可能要数分钟，
 * 若让 RPC 同步等待，网关会先超时并回 "Bad Gateway"。
 */
export type PapersEvent =
  | { type: 'progress'; id: string; loaded: number; total: number | null }
  | { type: 'done'; id: string; path: string; elapsedMs?: number }
  | { type: 'error'; id: string; message: string }
  | { type: 'stopped'; id: string };

// ── 行内批注 ────────────────────────────────────────────────

export type NoteType = 'highlight' | 'comment';

/** 批注高亮颜色预设（hex）。 */
export const NOTE_COLORS = ['#FFD54D', '#81C784', '#64B5F6', '#F48FB1', '#FFB74D'] as const;

export interface NoteRecord {
  id: string;
  paperId: string;
  page: number;
  type: NoteType;
  /** 被批注的原文片段（用于高亮回放）。 */
  text: string;
  /** 批注内容（评论文字；高亮可为空）。 */
  content: string;
  /** 高亮颜色（hex，如 #FFD54D）；旧记录为 null 时用默认黄。 */
  color: string | null;
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
