// Echo App Runtime 入口：Unix Socket HTTP 服务。
//
// 承载三件事：
//   1) 渲染层静态资源（Vite 构建产物，路径由 ECHO_APP_WEB_DIR 指定）
//   2) 全部 IPC 通道 → POST /rpc/<channel>（与 Electron 版共用 src/main/ipc.ts 的同一批 handler）
//   3) 事件推送 → GET /events（SSE），替代 webContents.send
//
// 监听契约：优先 ECHO_APP_SOCKET（Unix Socket，启动后 chmod 0600）；兼容旧平台的
// ECHO_APP_HOST/ECHO_APP_PORT；两者都没有时直接退出（不猜端口、不自建映射）。
//
// 安全边界：CAP 凭证只经 src/main/echoCap.ts 在服务端使用；HTTP 层不下发任何凭证，
// 文件接口限制在数据目录白名单内并做路径穿越校验。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createAppContext, type AppContext } from './appContext.js';
import { registerIpc, type HandlerRegistrar } from '../main/ipc.js';
import type { HostEmit } from '../main/ipc.js';

const MAX_BODY_BYTES = 256 * 1024 * 1024;
const BIN_KEY = '__paperstudioBin';

// ── 二进制编解码 ───────────────────────────────────────────────
// JSON 无法表达 Uint8Array（reader:open 会返回 PDF 字节），统一编码为 { __paperstudioBin: base64 }。
function encodeBinary(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BIN_KEY]: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeBinary);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeBinary(v);
    return out;
  }
  return value;
}

function decodeBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBinary);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const b64 = obj[BIN_KEY];
    if (typeof b64 === 'string' && Object.keys(obj).length === 1) return new Uint8Array(Buffer.from(b64, 'base64'));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = decodeBinary(v);
    return out;
  }
  return value;
}

// ── SSE 事件广播（HostEmit 的 Web 实现）────────────────────────
const sseClients = new Set<http.ServerResponse>();

const emit: HostEmit = (type, payload) => {
  const frame = `event: ${type}\ndata: ${JSON.stringify(encodeBinary(payload))}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
};

// ── RPC 通道注册表（HandlerRegistrar 的 Web 实现）──────────────
type Handler = (req: unknown) => unknown;
const handlers = new Map<string, Handler>();

const registrar: HandlerRegistrar = {
  handle: (channel, fn) => {
    handlers.set(channel, fn as Handler);
  },
};

// ── HTTP 工具 ─────────────────────────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.bcmap': 'application/octet-stream',
};

function contentType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(encodeBinary(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超过上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 把请求路径解析到 rootDir 内，拒绝穿越（.. / 绝对路径 / 符号链接逃逸）。 */
function safeResolve(rootDir: string, relPath: string): string | null {
  const decoded = decodeURIComponent(relPath).replace(/^\/+/, '');
  if (!decoded || decoded.includes('\0')) return null;
  const root = path.resolve(rootDir);
  const target = path.resolve(root, decoded);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return target;
}

function serveFile(res: http.ServerResponse, file: string, opts: { download?: string } = {}): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    const headers: Record<string, string> = {
      'Content-Type': contentType(file),
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-cache',
    };
    if (opts.download) {
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(opts.download)}`;
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

// ── 额外的 Web 专有通道 ────────────────────────────────────────
/** marked 为纯 ESM 包：CJS 输出下必须走真正的动态 import（tsc 会把字面 import() 降级为 require）。 */
interface MarkedLike {
  parse(md: string): string;
  use(options: { extensions: Array<Record<string, unknown>> }): void;
}

const dynamicImport = new Function('specifier', 'return import(specifier);') as (
  specifier: string,
) => Promise<{ marked: MarkedLike }>;

// ── Markdown 弹窗页的公式渲染（KaTeX）───────────────────────────
// marked 无内置 LaTeX 支持：注册行内 $...$ 与块级 $$...$$ 扩展，用 KaTeX 渲染为 HTML；
// KaTeX 字体静态文件首次使用时复制到 markdown 目录（/files/markdown/katex-fonts/ 可访问）。
import katex from 'katex';

let mathExtensionsRegistered = false;
let katexCssCache: string | null = null;

function getKatexCss(appRoot: string): string {
  if (katexCssCache !== null) return katexCssCache;
  try {
    const cssPath = path.join(appRoot, 'node_modules', 'katex', 'dist', 'katex.min.css');
    katexCssCache = fs
      .readFileSync(cssPath, 'utf8')
      .replace(/url\(fonts\//g, 'url(/files/markdown/katex-fonts/');
  } catch {
    katexCssCache = '';
  }
  return katexCssCache;
}

function ensureKatexFonts(appRoot: string, markdownDir: string): void {
  try {
    const dst = path.join(markdownDir, 'katex-fonts');
    if (fs.existsSync(dst)) return;
    const src = path.join(appRoot, 'node_modules', 'katex', 'dist', 'fonts');
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  } catch {
    // 字体拷贝失败不影响页面（公式缺字体时仍可用系统字体降级）
  }
}

/** 注册 marked 的 $...$ / $$...$$ 公式扩展（模块级只注册一次）。 */
async function registerMathExtensions(): Promise<void> {
  if (mathExtensionsRegistered) return;
  const { marked } = await dynamicImport('marked');
  const render = (math: string, displayMode: boolean): string =>
    katex.renderToString(math, { displayMode, throwOnError: false, strict: false });
  marked.use({
    extensions: [
      {
        name: 'inlineMath',
        level: 'inline',
        start(src: string) {
          const i = src.indexOf('$');
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string) {
          const m = /^\$([^$\n]+?)\$/.exec(src);
          if (m) return { type: 'inlineMath', raw: m[0], math: m[1] };
          return undefined;
        },
        renderer(token: { math: string }) {
          return render(token.math, false);
        },
      },
      {
        name: 'blockMath',
        level: 'block',
        start(src: string) {
          const i = src.indexOf('$$');
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string) {
          const m = /^\$\$([\s\S]+?)\$\$/.exec(src);
          if (m) return { type: 'blockMath', raw: m[0], math: m[1] };
          return undefined;
        },
        renderer(token: { math: string }) {
          return render(token.math, true);
        },
      },
    ] as Array<Record<string, unknown>>,
  });
  mathExtensionsRegistered = true;
}

/** Unicode 数学符号 → LaTeX 命令（裸公式兜底渲染用）。 */
const MATH_SYMBOL_MAP: Record<string, string> = {
  ℓ: '\\ell', σ: '\\sigma', Σ: '\\sum', θ: '\\theta', γ: '\\gamma', ν: '\\nu', λ: '\\lambda',
  α: '\\alpha', β: '\\beta', π: '\\pi', μ: '\\mu', δ: '\\delta', ε: '\\epsilon', η: '\\eta',
  κ: '\\kappa', τ: '\\tau', φ: '\\phi', ω: '\\omega', Ω: '\\Omega', Δ: '\\Delta',
  '∞': '\\infty', '√': '\\sqrt', '∫': '\\int', '≤': '\\le', '≥': '\\ge', '≠': '\\ne',
  '±': '\\pm', '×': '\\times', '·': '\\cdot',
  '∈': '\\in', '⇒': '\\Rightarrow', '→': '\\to', '∇': '\\nabla', '≈': '\\approx',
};

const MATH_CHARS_RE = /[ℓσΣθηλγαβπμνδεηκτφωΩΔ∞√∫≤≥≠±×·∈⇒→∇≈]/;

/** 裸公式行兜底：LLM 未用 $ 包裹的独立公式行（无中文、含数学符号/下标）→ KaTeX 渲染；失败回退原文。 */
function renderBareMath(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t || t.includes('$') || /[\u4e00-\u9fa5]/.test(t)) return line; // 已包裹/含中文 → 不动
      const symbols = (t.match(MATH_CHARS_RE) ?? []).length;
      const hasSub = /[A-Za-zℓσΣθηλγν]_/.test(t);
      const looksLikeEq = /^[A-Za-zℓLfghEy]\s*[=:]/.test(t);
      const isFormula = (symbols >= 1 && (hasSub || looksLikeEq)) || symbols >= 3;
      if (!isFormula) return line;
      let tex = t;
      for (const [u, cmd] of Object.entries(MATH_SYMBOL_MAP)) tex = tex.split(u).join(cmd);
      tex = tex.replace(/([A-Za-z\\]+)_([A-Za-z0-9]+)/g, '$1_{\\text{$2}}');
      tex = tex.replace(/\b(log|exp|cos|sin|tan|min|max|lim|arg)\(/g, '\\\\$1(');
      try {
        const html = katex.renderToString(tex, { displayMode: true, throwOnError: false, strict: false });
        if (!html.includes('katex-error')) return html;
      } catch {
        // 渲染失败回退原文
      }
      return line;
    })
    .join('\n');
}

function registerWebChannels(ctx: AppContext): void {
  // Electron 版的 markdown:open 依赖 BrowserWindow 开新窗口；Web 版把 MD 渲染成 HTML
  // 落到 markdown/ 目录，并返回可通过 /files/markdown/ 访问的 URL（前端用 window.open 打开）。
  /** 把 MD 文件渲染成 HTML 落盘（markdown 区），返回可访问 URL。 */
  const renderMarkdownFile = async (file: string, outName: string): Promise<string> => {
    const content = fs.readFileSync(file, 'utf8');
    const { marked } = await dynamicImport('marked');
    // 公式渲染：$...$ 行内 / $$...$$ 块级（KaTeX），字体文件保证可访问。
    await registerMathExtensions();
    const appRoot = path.resolve(__dirname, '..', '..', '..');
    ensureKatexFonts(appRoot, ctx.markdownDir);
    const katexCss = getKatexCss(appRoot);
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; base-uri 'none'">
<title>${path.basename(file)}</title>
<style>
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; max-width: 860px; margin: 0 auto; padding: 32px 40px 80px; color: #1f2328; line-height: 1.7; }
  h1 { font-size: 24px; border-bottom: 1px solid #d0d7de; padding-bottom: 8px; }
  h2 { font-size: 19px; margin-top: 28px; border-bottom: 1px solid #eaeef2; padding-bottom: 4px; }
  h3 { font-size: 16px; } pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow-x: auto; }
  code { background: #f6f8fa; padding: 2px 5px; border-radius: 4px; font-family: Consolas, monospace; font-size: 13px; }
  pre code { background: none; padding: 0; } blockquote { color: #57606a; border-left: 4px solid #d0d7de; margin-left: 0; padding-left: 12px; }
  table { border-collapse: collapse; } th, td { border: 1px solid #d0d7de; padding: 6px 10px; }
  img { max-width: 100%; height: auto; border: 1px solid #eaeef2; border-radius: 4px; }
  a { color: #0969da; } ul, ol { padding-left: 22px; }
  ${katexCss}
</style></head>
<body>${marked.parse(renderBareMath(content))}</body></html>`;
    const htmlFile = path.join(ctx.markdownDir, outName);
    fs.writeFileSync(htmlFile, html, 'utf8');
    return `/files/markdown/${encodeURIComponent(path.basename(htmlFile))}`;
  };

  registrar.handle('markdown:open', async (req: unknown) => {
    try {
      const rel = String((req as { path?: unknown })?.path ?? '');
      const root = path.resolve(ctx.markdownDir);
      const file = path.resolve(rel);
      if (file !== root && !file.startsWith(root + path.sep)) {
        return { ok: false, message: '仅允许打开工作目录下的 MD 文件' };
      }
      const url = await renderMarkdownFile(file, `${path.basename(file, '.md')}.html`);
      return { ok: true, url };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // 写作预览：渲染层给出 Markdown 内容 → 写到 markdown/preview/ 并渲染 HTML，返回可访问 URL。
  registrar.handle('markdown:preview', async (req: unknown) => {
    try {
      const { name, content } = (req ?? {}) as { name?: unknown; content?: unknown };
      const safeName =
        String(name ?? 'preview').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 48) || 'preview';
      const dir = path.join(ctx.markdownDir, 'preview');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${safeName}-${Date.now()}.md`);
      fs.writeFileSync(file, String(content ?? ''), 'utf8');
      const url = await renderMarkdownFile(file, `${safeName}-${Date.now()}.html`);
      return { ok: true, url };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
}

// ── 请求路由 ──────────────────────────────────────────────────
function createHandler(ctx: AppContext, webDir: string): http.RequestListener {
  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://paperstudio.local');
      const pathname = url.pathname;

      if (pathname === '/healthz') {
        const engine = ctx.agentService.health();
        sendJson(res, 200, {
          ok: true,
          name: 'paperstudio',
          uptimeMs: Math.round(process.uptime() * 1000),
          engine: { ok: engine.ok, version: engine.version ?? null, message: engine.message ?? null },
        });
        return;
      }

      if (pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            /* 连接已断开 */
          }
        }, 15_000);
        req.on('close', () => {
          clearInterval(ping);
          sseClients.delete(res);
        });
        return;
      }

      if (pathname.startsWith('/rpc/')) {
        const channel = decodeURIComponent(pathname.slice('/rpc/'.length));
        const fn = handlers.get(channel);
        if (!fn) {
          sendJson(res, 404, { ok: false, message: `未知通道：${channel}` });
          return;
        }
        const raw = await readBody(req);
        const payload = raw.length ? decodeBinary(JSON.parse(raw.toString('utf8'))) : undefined;
        const result = await fn(payload);
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (pathname.startsWith('/files/')) {
        const rest = pathname.slice('/files/'.length);
        const slash = rest.indexOf('/');
        const bucket = slash < 0 ? rest : rest.slice(0, slash);
        const rel = slash < 0 ? '' : rest.slice(slash + 1);
        const roots: Record<string, { dir: string; download: boolean }> = {
          papers: { dir: ctx.storageDir, download: false },
          exports: { dir: ctx.exportDir, download: true },
          markdown: { dir: ctx.markdownDir, download: false },
        };
        const target = roots[bucket];
        if (!target) {
          sendJson(res, 404, { ok: false, message: '未知文件区' });
          return;
        }
        const file = safeResolve(target.dir, rel);
        if (!file || !serveFile(res, file, target.download ? { download: path.basename(file) } : {})) {
          sendJson(res, 404, { ok: false, message: '文件不存在' });
        }
        return;
      }

      if (pathname === '/upload' && req.method === 'POST') {
        const name = path.basename(url.searchParams.get('name') ?? 'upload.bin').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
        const buf = await readBody(req);
        const target = path.join(ctx.uploadDir, `${Date.now()}-${name}`);
        fs.writeFileSync(target, buf);
        sendJson(res, 200, { ok: true, result: { path: target, name, size: buf.length } });
        return;
      }

      // 静态资源 + SPA 回退
      if (req.method === 'GET' || req.method === 'HEAD') {
        const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
        const file = safeResolve(webDir, rel);
        if (file && serveFile(res, file)) return;
        const index = path.join(webDir, 'index.html');
        if (serveFile(res, index)) return;
        sendJson(res, 404, { ok: false, message: '前端产物缺失（web/index.html）' });
        return;
      }

      sendJson(res, 405, { ok: false, message: '不支持的方法' });
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, message });
      else res.end();
    });
  };
}

// ── 启动 ──────────────────────────────────────────────────────
async function main(): Promise<void> {
  const appRoot = path.resolve(__dirname, '..', '..', '..');
  const storageRoot = process.env.ECHO_APP_DATA_DIR || path.join(appRoot, 'storage');
  const webDir = process.env.ECHO_APP_WEB_DIR || path.join(appRoot, 'web');

  const ctx = createAppContext({ storageRoot, emit });
  registerIpc(registrar, ctx.deps);
  registerWebChannels(ctx);

  const server = http.createServer(createHandler(ctx, webDir));
  // SSE 长连接：禁用请求超时，避免事件流被服务端掐断。
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  const socketPath = process.env.ECHO_APP_SOCKET;
  const port = process.env.ECHO_APP_PORT;

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[paperstudio] 收到 ${signal}，正在退出…`);
    for (const client of sseClients) client.end();
    sseClients.clear();
    server.close();
    await ctx.dispose();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  if (socketPath) {
    // 仅当残留路径确实是 socket 时才清理；普通文件/目录/符号链接一律拒绝启动。
    if (fs.existsSync(socketPath)) {
      if (fs.statSync(socketPath).isSocket()) fs.unlinkSync(socketPath);
      else {
        console.error(`[paperstudio] ECHO_APP_SOCKET 路径被非 socket 占用：${socketPath}`);
        process.exit(1);
      }
    }
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      console.log(`[paperstudio] listening on unix socket ${socketPath} (data=${storageRoot})`);
    });
  } else if (port) {
    const host = process.env.ECHO_APP_HOST || '127.0.0.1';
    server.listen(Number(port), host, () => {
      console.log(`[paperstudio] listening on http://${host}:${port} (data=${storageRoot})`);
    });
  } else {
    console.error('[paperstudio] 缺少 ECHO_APP_SOCKET 或 ECHO_APP_PORT，拒绝在未知端口启动');
    process.exit(1);
  }
}

void main();
