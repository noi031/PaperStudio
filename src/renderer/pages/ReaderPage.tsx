// 阅读器页：pdfjs 渲染 PDF（canvas + 可选中的文本层），侧栏做选中/全文总结。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import InputLabel from '@mui/material/InputLabel';
import Tooltip from '@mui/material/Tooltip';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import 'pdfjs-dist/web/pdf_viewer.css';
import { useLibraryStore } from '../store/libraryStore';
import { useAssistantStore } from '../store/assistantStore';
import { PromptEditor } from '../components/PromptEditor';
import type { SummaryRecord, NoteRecord, NoteType } from '../../shared/types';
import { latexToText } from '../../shared/latex';

// pdfjs 主进程/渲染进程共用；Vite 下 worker 用 ?url 加载。
let pdfjs: typeof import('pdfjs-dist') | null = null;
let workerUrl = '';
let standardFontsUrl = '';
let cMapUrl = '';

async function loadPdfjs() {
  if (!pdfjs) {
    const mod = await import('pdfjs-dist');
    // dev 模式：Vite 会把 new URL('pdfjs-dist/...') 当作静态资源解析（剥掉尾斜杠、指向不存在的
    // src/renderer/pages/pdfjs-dist），故 dev 直接用 dev server 能伺服的 /node_modules/ 根路径；
    // 构建模式：vite 已把字体目录复制到 dist/standard_fonts、dist/cmaps，new URL 解析到资源。
    if (import.meta.env.DEV) {
      workerUrl = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs';
      standardFontsUrl = '/node_modules/pdfjs-dist/standard_fonts/';
      cMapUrl = '/node_modules/pdfjs-dist/cmaps/';
    } else {
      workerUrl = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
      // pdfjs 5.x 渲染 PDF 内嵌标准字体必需；构建时 vite 已把字体复制到 dist/standard_fonts。
      standardFontsUrl = new URL('pdfjs-dist/standard_fonts/', import.meta.url).href;
      cMapUrl = new URL('pdfjs-dist/cmaps/', import.meta.url).href;
    }
    mod.GlobalWorkerOptions.workerSrc = workerUrl;
    pdfjs = mod;
  }
  return pdfjs;
}

const KIND_LABEL: Record<string, string> = { selected: '选中总结', full: '全文总结' };

/** 归一化文本（去空白）用于片段匹配。 */
function normText(s: string): string {
  return s.replace(/\s+/g, '');
}

/** 渲染后把当前页的批注原文片段高亮到文本层 span 上。 */
function applyHighlights(
  tl: { textDivs: Array<HTMLSpanElement & { style: CSSStyleDeclaration }> },
  pageNum: number,
  notes: NoteRecord[],
): void {
  const divs = tl.textDivs;
  if (!divs.length) return;
  const norms = divs.map((d) => normText(d.textContent ?? ''));
  const offsets: number[] = [];
  let acc = 0;
  for (const n of norms) {
    offsets.push(acc);
    acc += n.length;
  }
  const joined = norms.join('');
  for (const note of notes) {
    if (note.page !== pageNum || !note.text) continue;
    const target = normText(note.text);
    if (!target) continue;
    const start = joined.indexOf(target);
    if (start < 0) continue;
    const end = start + target.length;
    for (let i = 0; i < divs.length; i++) {
      const s = offsets[i];
      const e = s + norms[i].length;
      if (e <= start || s >= end) continue;
      divs[i].style.backgroundColor = 'rgba(255, 213, 79, 0.45)';
      divs[i].style.borderRadius = '2px';
    }
  }
}

export function ReaderPage({
  paperId,
  onBack,
  onOpenAssistant,
}: {
  paperId: string | null;
  onBack: () => void;
  onOpenAssistant: () => void;
}) {
  const { summaries, streaming, notes, loadSummaries, loadNotes, addNote, updateNote, deleteNote, startSummary, handleSummaryEvent } =
    useLibraryStore();
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerElRef = useRef<HTMLDivElement | null>(null);
  const selOverlayRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<InstanceType<typeof import('pdfjs-dist/web/pdf_viewer').PDFViewer> | null>(null);
  const eventBusRef = useRef<InstanceType<typeof import('pdfjs-dist/web/pdf_viewer').EventBus> | null>(null);
  const notesRef = useRef<NoteRecord[]>([]);
  // 最近一次鼠标位置：拖选经过 span 间空隙时 Chromium 会把选区端点钉在
  // textLayer 容器（DIV）上导致跳行，需要用它 + caretPositionFromPoint 归位。
  const lastMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [title, setTitle] = useState('');
  const [pageNum, setPageNum] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.4);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [fullText, setFullText] = useState('');
  const [commentDraft, setCommentDraft] = useState('');
  const [showCommentInput, setShowCommentInput] = useState(false);
  // 批注编辑对话框
  const [editingNote, setEditingNote] = useState<NoteRecord | null>(null);
  const [editType, setEditType] = useState<NoteType>('comment');
  const [editContent, setEditContent] = useState('');
  // 批注导出/导入
  const [noteMsg, setNoteMsg] = useState<string | null>(null);
  const noteImportRef = useRef<HTMLInputElement>(null);

  const docRef = useRef<{ doc: import('pdfjs-dist').PDFDocumentProxy; data: Uint8Array } | null>(null);

  /** 在指定页码的已渲染文本层上重放批注高亮（PDFViewer 惰性渲染：只处理已渲染的页）。
   *  注意：PDFViewer 的 pageView.textLayer 是 TextLayerBuilder，不暴露 textDivs，
   *  需从它的 .textLayer div 元素里取 span（与旧版手动 TextLayer 不同）。 */
  const replayHighlights = useCallback(() => {
    const viewer = viewerRef.current;
    const doc = docRef.current;
    if (!viewer || !doc) return;
    const n = doc.doc.numPages;
    for (let i = 0; i < n; i++) {
      const pv = viewer.getPageView(i);
      const tlDiv = pv?.textLayer?.div;
      if (!tlDiv) continue;
      const spans = Array.from(tlDiv.querySelectorAll('span'));
      if (spans.length) applyHighlights({ textDivs: spans as HTMLSpanElement[] }, i + 1, notesRef.current);
    }
  }, []);

  useEffect(() => {
    if (!paperId) return;
    setError(null);
    setLoading(true);
    let cancelled = false;
    void (async () => {
      try {
        const pdf = await loadPdfjs();
        const res = await window.paper.invoke('reader:open', { id: paperId });
        if ('error' in res) {
          setError(res.error);
          setLoading(false);
          return;
        }
        if (cancelled) return;
        const data = res.data;
        setTitle(res.title);
        const task = pdf.getDocument({ data, standardFontDataUrl: standardFontsUrl, cMapUrl, cMapPacked: true });
        const doc = await task.promise;
        docRef.current = { doc, data };
        setPageCount(doc.numPages);
        setPageNum(1);
        // 批注/总结先行加载（不等全文提取，57 页提取需要几十秒）
        void loadSummaries(paperId);
        void loadNotes(paperId);

        // 官方 PDFViewer：整份 PDF 连续滚动渲染（惰性渲染可视页）。
        const vmod = await import('pdfjs-dist/web/pdf_viewer');
        const container = viewerContainerRef.current;
        const viewerEl = viewerElRef.current;
        if (!container || !viewerEl) throw new Error('阅读器容器未就绪');
        const eventBus = new vmod.EventBus();
        const linkService = new vmod.PDFLinkService({ eventBus });
        const viewer = new vmod.PDFViewer({ container, viewer: viewerEl, eventBus, linkService });
        linkService.setViewer(viewer);
        viewerRef.current = viewer;
        eventBusRef.current = eventBus;
        // 页码随滚动更新（整份连续滚动，不再有「上一页/下一页」）。
        eventBus.on('updateviewarea', (evt) => {
          const e = evt as { location?: { pageNumber?: number } };
          const n = e.location?.pageNumber;
          if (typeof n === 'number' && n >= 1) setPageNum(n);
        });
        // 每页渲染完成后回放该页批注高亮（PDFViewer 惰性渲染，滚动到哪渲染到哪）。
        eventBus.on('pagerendered', (evt) => {
          const e = evt as { pageNumber?: number; source?: { textLayer?: { div?: HTMLElement } } };
          const tlDiv = e.source?.textLayer?.div;
          const n = e.pageNumber;
          if (tlDiv && n) {
            const spans = Array.from(tlDiv.querySelectorAll('span'));
            if (spans.length) applyHighlights({ textDivs: spans as HTMLSpanElement[] }, n, notesRef.current);
          }
        });
        if (cancelled) return;
        viewer.setDocument(doc);
        // setDocument 异步创建页面（_pages 在 Promise.all 后填充）：必须等页面就绪
        // 再设 currentScale，否则 _pages 为空 → 渲染中断（「renderView TypeError / scrollPageIntoView 无效页码」）。
        eventBus.on('pagesloaded', () => {
          viewer.currentScale = scale;
        });
        setLoading(false);

        // 提取全文（供全文总结）：后台串行提取（pdfjs worker 内部串行，并发会打崩 worker），
        // 提取完成后「总结全文」按钮才可用。
        void (async () => {
          const parts: string[] = [];
          const maxPages = Math.min(doc.numPages, 100);
          for (let i = 1; i <= maxPages; i++) {
            if (cancelled) return;
            try {
              const p = await doc.getPage(i);
              const tc = await p.getTextContent();
              const text = tc.items
                .map((it) => ('str' in it ? it.str : ''))
                .join(' ')
                .replace(/\s+/g, ' ');
              parts.push(text);
              if (parts.join('\n').length > 60000) break;
            } catch {
              // 单页提取失败不影响其余页
            }
          }
          if (cancelled) return;
          setFullText(parts.join('\n').slice(0, 60000));
        })();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      const v = viewerRef.current;
      if (v && 'cleanup' in v && typeof (v as { cleanup: () => void }).cleanup === 'function') {
        (v as { cleanup: () => void }).cleanup();
      }
      viewerRef.current = null;
      eventBusRef.current = null;
      void docRef.current?.doc.destroy();
      docRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId]);

  // pdfjs 5.x 默认给 .page 加了 9px 透明边框（--page-border），box-sizing:border-box
  // 会把 canvas 显示区（canvasWrapper）挤进 padding box，导致 canvas 位图被 CSS
  // 压缩、与 textLayer（1:1 坐标）错位——高亮/选区就跟着偏移。去掉边框后 canvas
  // 与 textLayer 完全重合，高亮坐标换算不再需要任何压缩修正。
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `.pdfViewer .page { border: none !important; }`;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  const goto = (num: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const n = Math.max(1, Math.min(num, pageCount));
    viewer.currentPageNumber = n;
    setPageNum(n);
  };

  const zoom = (delta: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const next = Math.max(0.6, Math.min(3, scale + delta));
    setScale(next);
    viewer.currentScale = next;
  };

  const onMouseUp = () => {
    const sel = window.getSelection()?.toString().trim() ?? '';
    setSelectedText(sel);
  };

  // 字形带测量缓存：span 元素 → { top, height }（相对所在页顶部的内容坐标）。
  // span 重建（缩放/重渲染）时 WeakMap 键自动失效；字体大小变化时显式重测。
  const glyphBandCacheRef = useRef<WeakMap<Element, { top: number; height: number; fontSize: string }>>(new WeakMap());

  // 扫描 span 所在页 canvas 的对应行，找字形（黑色像素带）的精确 top/height。
  // span 盒（em 盒）比字形视觉高度高 ~30%，直接用它画高亮会在字下方留白，
  // 用户反馈「高亮不到字的下沿」——这里用 canvas 像素级字形带贴合。
  // 坐标基准：canvas 位图像素与 textLayer CSS 是 1:1（同高），但 canvas 的
  // CSS 显示尺寸可能被压缩（位图 ≠ CSS 尺寸），因此必须用 textLayer 的 rect
  // 换算，不能用 canvas 的 getBoundingClientRect（否则滚动后扫描窗口错位）。
  const measureGlyphBand = useCallback((span: HTMLElement): { top: number; height: number } | null => {
    const cached = glyphBandCacheRef.current.get(span);
    const fontSize = getComputedStyle(span).fontSize;
    if (cached && cached.fontSize === fontSize) return cached;
    const pageDiv = span.closest('.page') as HTMLElement | null;
    const canvas = pageDiv?.querySelector('canvas') as HTMLCanvasElement | null;
    const textLayer = span.closest('.textLayer') as HTMLElement | null;
    if (!pageDiv || !canvas || !textLayer) return null;
    const pageRect = pageDiv.getBoundingClientRect();
    const tlRect = textLayer.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();
    if (tlRect.width <= 0 || tlRect.height <= 0) return null;
    const dprX = canvas.width / tlRect.width;
    const dprY = canvas.height / tlRect.height;
    const x0 = Math.max(0, Math.round((spanRect.left - tlRect.left) * dprX));
    const x1 = Math.min(canvas.width, Math.round((spanRect.right - tlRect.left) * dprX));
    const y0 = Math.max(0, Math.round((spanRect.top - tlRect.top) * dprY) - 8);
    const y1 = Math.min(canvas.height, Math.round((spanRect.bottom - tlRect.top) * dprY) + 8);
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    let img: ImageData;
    try {
      img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
    } catch {
      return null;
    }
    const w = x1 - x0;
    const h = y1 - y0;
    // 每行字形像素计数（不透明且为深色像素；canvas 空白是透明像素，须排除）
    const rows = new Array(h).fill(0);
    for (let y = 0; y < h; y++) {
      const base = y * w * 4;
      let c = 0;
      for (let x = 0; x < w; x++) {
        const i = base + x * 4;
        if (img.data[i + 3] > 128 && img.data[i] < 170 && img.data[i + 1] < 170 && img.data[i + 2] < 170) c++;
      }
      rows[y] = c;
    }
    // 找最长的连续字形行带（一行文字应是一个带；公式上下标会并入同一带）
    let bestStart = -1;
    let bestLen = 0;
    let curStart = -1;
    for (let y = 0; y < h; y++) {
      if (rows[y] > 2) {
        if (curStart < 0) curStart = y;
      } else if (curStart >= 0) {
        if (y - curStart > bestLen) {
          bestLen = y - curStart;
          bestStart = curStart;
        }
        curStart = -1;
      }
    }
    if (curStart >= 0 && h - curStart > bestLen) {
      bestLen = h - curStart;
      bestStart = curStart;
    }
    if (bestStart < 0 || bestLen < 4) return null;
    const res = {
      top: (y0 + bestStart) / dprY + tlRect.top - pageRect.top,
      height: bestLen / dprY,
      fontSize,
    };
    glyphBandCacheRef.current.set(span, res);
    return res;
  }, []);

  // 自定义选区高亮：Chromium 对 pdfjs 文本层（绝对定位 span）的原生选区渲染
  // 会退化成整行矩形（选中一个词也高亮整行）。这里禁用原生 ::selection 背景，
  // 改用 Range.getClientRects()（精确到词的几何）自绘高亮层。
  //
  // 注意：跨多个 span 的选区，Chromium 对「完全包含」的 span 返回整个 span 的矩形
  // （整行宽），因此这里把选区与每个 span 求交集、逐 span 取字符精确矩形；
  // 高度优先用 canvas 字形带（贴合字形下沿），扫描失败时回退 span 字形盒。
  const drawSelectionHighlight = useCallback(() => {
    const overlay = selOverlayRef.current;
    const container = viewerContainerRef.current;
    if (!overlay || !container) return;
    overlay.replaceChildren();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    // 只处理文本层内的选区（侧栏等处的选区不画）；选区可跨页（连续滚动下
    // 起点在第 N 页、终点在第 N+1 页），两端任一在文本层内即可。
    let inTextLayer = false;
    let node: Node | null = range.startContainer;
    while (node && node !== document.body) {
      if (node instanceof HTMLElement && node.classList.contains('textLayer')) {
        inTextLayer = true;
        break;
      }
      node = node.parentNode;
    }
    if (!inTextLayer) {
      node = range.endContainer;
      while (node && node !== document.body) {
        if (node instanceof HTMLElement && node.classList.contains('textLayer')) {
          inTextLayer = true;
          break;
        }
        node = node.parentNode;
      }
    }
    if (!inTextLayer) return;
    const crect = container.getBoundingClientRect();
    const spans = Array.from(document.querySelectorAll('.textLayer span'));
    // 坐标：overlay 是容器（滚动容器）的 absolute 子元素，会随内容滚动，
    // 因此把视口坐标转成「内容坐标」= 视口坐标 - 容器左上 + scrollLeft/scrollTop。
    const draw = (left: number, top: number, width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      const d = document.createElement('div');
      d.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;background:rgba(66,133,244,0.35);border-radius:2px;pointer-events:none;`;
      overlay.appendChild(d);
    };
    for (const span of spans) {
      if (!range.intersectsNode(span)) continue;
      const spanEl = span as HTMLElement;
      const spanRect = spanEl.getBoundingClientRect();
      // 字形带（canvas 像素级）；失败则用 span 盒。
      // 前提：页面无边框（见下方 .pdfViewer .page { border: none } 覆盖），
      // canvas 显示区与 textLayer 1:1 对齐，band（位图坐标）与 textLayer CSS
      // 完全一致，直接换算即可，无需压缩因子。
      let bandTop = spanRect.top - crect.top + container.scrollTop;
      let bandHeight = spanRect.height;
      const band = measureGlyphBand(spanEl);
      if (band) {
        const pageRect = (spanEl.closest('.page') as HTMLElement).getBoundingClientRect();
        bandTop = band.top + pageRect.top - crect.top + container.scrollTop;
        bandHeight = band.height;
      }
      // 逐文本节点求 range ∩ 文本节点的子 range。关键：子 range 的起点/终点必须
      // 落在文本节点内部（offset 为字符偏移）——若端点是 span 元素节点，
      // Chromium 的 getClientRects() 会返回整个 span 的矩形（整行），导致
      // 首尾行只选中一部分也整行高亮。
      // 裁剪偏移用节点关系判断（不用 compareBoundaryPoints——其返回值方向
      // 在不同 Chromium 版本表现不一致，曾导致合法相交被误跳过）。
      const children = Array.from(spanEl.childNodes);
      for (let ci = 0; ci < children.length; ci++) {
        const child = children[ci];
        if (child.nodeType !== Node.TEXT_NODE) continue;
        const tn = child as Text;
        if (!tn.length || !range.intersectsNode(tn)) continue;
        let s = 0;
        let e = tn.length;
        const sc = range.startContainer;
        const ec = range.endContainer;
        if (sc === tn) s = range.startOffset;
        else if (sc === span && range.startOffset > ci) continue; // start 在 tn 之后，不相交
        if (ec === tn) e = range.endOffset;
        else if (ec === span && range.endOffset <= ci) continue; // end 在 tn 之前，不相交
        if (e <= s) continue;
        const sub = document.createRange();
        sub.setStart(tn, s);
        sub.setEnd(tn, e);
        for (const r of sub.getClientRects()) {
          if (r.width === 0 || r.height === 0) continue;
          draw(
            r.left - crect.left + container.scrollLeft,
            bandTop,
            r.width,
            bandHeight,
          );
        }
      }
    }
  }, [measureGlyphBand]);

  // 修复「跳行」：拖选多行时鼠标经过 span 间的空隙（行间 10px 空隙、
  // 公式碎片间的大空隙），Chromium 会把选区端点钉在 textLayer 容器
  // （DIV 元素）上，选区瞬间变成「从容器开头/某子节点边界」，表现为
  // 某些行被整个跳过、且后续 mouseMove 不再恢复。
  // 检测端点是 textLayer 容器时，把端点归位到鼠标附近最近的真实文本：
  // 优先 caretPositionFromPoint（鼠标在文本上时直接命中），失败时
  // （空隙处它可能返回非文本层 DIV，视口外返回 null）用最近 span 兜底。
  const fixDivEndpointSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const mouse = lastMouseRef.current;
    if (mouse.x === 0 && mouse.y === 0) return;
    const isTextLayerDiv = (node: Node | null): boolean =>
      !!node && node instanceof HTMLElement && node.classList.contains('textLayer');
    const isInsideTextLayer = (node: Node | null): boolean => {
      let n: Node | null = node;
      while (n && n !== document.body) {
        if (n instanceof HTMLElement && n.classList.contains('textLayer')) return true;
        n = n.parentNode;
      }
      return false;
    };
    // 找离鼠标最近的 span（按点到盒的距离），把鼠标 clamp 进盒内再取 caret
    const applyNear = (textLayer: HTMLElement, apply: (n: Node, o: number) => void): boolean => {
      let best: HTMLElement | null = null;
      let bestD = Infinity;
      for (const span of Array.from(textLayer.querySelectorAll('span'))) {
        const r = span.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const dx = mouse.x < r.left ? r.left - mouse.x : mouse.x > r.right ? mouse.x - r.right : 0;
        const dy = mouse.y < r.top ? r.top - mouse.y : mouse.y > r.bottom ? mouse.y - r.bottom : 0;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = span;
        }
      }
      if (!best) return false;
      const r = best.getBoundingClientRect();
      const cx = Math.min(r.right, Math.max(r.left, mouse.x));
      const cy = Math.min(r.bottom, Math.max(r.top, mouse.y));
      const cp = document.caretPositionFromPoint(cx, cy);
      if (cp?.offsetNode && isInsideTextLayer(cp.offsetNode)) {
        apply(cp.offsetNode, cp.offset);
        return true;
      }
      const tns = Array.from(best.childNodes).filter((c) => c.nodeType === Node.TEXT_NODE) as Text[];
      if (!tns.length) return false;
      // caret 失败：归到 span 起/终点（鼠标在盒上半部 → 起点，否则终点）
      const first = tns[0];
      const last = tns[tns.length - 1];
      if (mouse.y < r.top + r.height / 2) apply(first, 0);
      else apply(last, last.length);
      return true;
    };
    const set = (node: Node | null, offset: number, apply: (n: Node, o: number) => void): boolean => {
      if (!isTextLayerDiv(node)) return false;
      // 中间 offset（空隙处 Chromium 已把端点归到相邻 span 边界）语义合理，不修；
      // 只有容器边缘（0 / 末尾）才导致「从容器开头算起」的跳变，需要归位。
      const len = (node as HTMLElement).childNodes.length;
      if (offset > 0 && offset < len) return false;
      const cp = document.caretPositionFromPoint(mouse.x, mouse.y);
      if (cp?.offsetNode && isInsideTextLayer(cp.offsetNode)) {
        apply(cp.offsetNode, cp.offset);
        return true;
      }
      return applyNear(node as HTMLElement, apply);
    };
    const changedStart = set(range.startContainer, range.startOffset, (n, o) => range.setStart(n, o));
    const changedEnd = set(range.endContainer, range.endOffset, (n, o) => range.setEnd(n, o));
    if (changedStart || changedEnd) {
      sel.removeAllRanges();
      sel.addRange(range); // 触发重入 selectionchange；此时端点已是文本/span，不再修复
    }
  }, []);

  // 监听选区变化 / 滚动，重绘精确选区高亮。
  // 注意：不用 rAF 节流——隐藏窗口/后台时 rAF 会被暂停导致高亮不更新。
  useEffect(() => {
    const container = viewerContainerRef.current;
    const onSel = () => {
      fixDivEndpointSelection();
      drawSelectionHighlight();
    };
    const onMove = (e: MouseEvent) => {
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    };
    document.addEventListener('selectionchange', onSel);
    window.addEventListener('mousemove', onMove);
    container?.addEventListener('scroll', onSel, { passive: true });
    return () => {
      document.removeEventListener('selectionchange', onSel);
      window.removeEventListener('mousemove', onMove);
      container?.removeEventListener('scroll', onSel);
    };
  }, [drawSelectionHighlight, fixDivEndpointSelection]);

  // 批注数据同步到 ref（渲染高亮用），并在变化后重放已渲染页的高亮。
  useEffect(() => {
    const list = notes[paperId ?? ''] ?? [];
    notesRef.current = list;
    replayHighlights();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, paperId]);

  const handleAddHighlight = () => {
    if (!paperId || !selectedText) return;
    void addNote(paperId, pageNum, 'highlight', selectedText, '').then(() => {
      setSelectedText('');
      setShowCommentInput(false);
      setCommentDraft('');
    });
  };

  const handleAddComment = () => {
    if (!paperId || !selectedText) return;
    void addNote(paperId, pageNum, 'comment', selectedText, commentDraft.trim() || selectedText.slice(0, 100)).then(() => {
      setSelectedText('');
      setShowCommentInput(false);
      setCommentDraft('');
    });
  };

  const handleDeleteNote = (id: string) => {
    void deleteNote(id).then(() => {
      if (paperId) void loadNotes(paperId);
    });
  };

  const openEditNote = (n: NoteRecord) => {
    setEditingNote(n);
    setEditType(n.type);
    setEditContent(n.content);
  };

  const saveEditNote = () => {
    if (!editingNote) return;
    void updateNote(editingNote.id, { type: editType, content: editContent.trim() }).then(() => {
      setEditingNote(null);
      if (paperId) void loadNotes(paperId);
    });
  };

  const handleExportNotes = () => {
    if (!paperId) return;
    void window.paper
      .invoke('notes:export', { paperId })
      .then((r) => {
        const res = r as { ok: boolean; path?: string; message?: string };
        setNoteMsg(res.ok ? `已导出：${res.path}` : `导出失败：${res.message ?? ''}`);
      });
  };

  const handleImportNotesFile = (file: File) => {
    if (!paperId) return;
    const reader = new FileReader();
    reader.onload = () => {
      void window.paper
        .invoke('notes:import', { paperId, json: String(reader.result ?? '') })
        .then(async (r) => {
          const res = r as { ok: boolean; imported?: number; message?: string };
          setNoteMsg(res.ok ? `已导入 ${res.imported ?? 0} 条批注` : `导入失败：${res.message ?? ''}`);
          if (res.ok) await loadNotes(paperId);
        });
    };
    reader.readAsText(file);
  };

  const handleSendToAssistant = () => {
    if (!selectedText) return;
    // @ 引用块：把选中段落加入助手待发引用列表，可继续在对话里追加问题后一次性发出。
    useAssistantStore.getState().appendQuote({
      source: title || '论文',
      page: pageNum,
      text: selectedText,
    });
    setSelectedText('');
    onOpenAssistant();
  };

  const paperNotes: NoteRecord[] = notes[paperId ?? ''] ?? [];

  const runningStreams = Object.entries(streaming)
    .filter(([, s]) => s.paperId === paperId && s.running)
    .map(([id, s]) => ({ id, ...s }));
  const errorStreams = Object.entries(streaming)
    .filter(([, s]) => s.paperId === paperId && s.error && !s.running)
    .map(([id, s]) => ({ id, ...s }));
  const history: SummaryRecord[] = summaries[paperId ?? ''] ?? [];

  if (!paperId) {
    return (
      <Box sx={{ p: 4 }}>
        <Typography variant="h5" gutterBottom>阅读器</Typography>
        <Typography color="text.secondary">从「文献库」选择一篇论文打开。</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', gap: 2, height: '100%' }}>
      <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <Button size="small" onClick={onBack}>← 返回</Button>
          <Typography variant="h6" noWrap sx={{ flexGrow: 1 }}>
            {title || '加载中…'}
          </Typography>
          <Button size="small" variant="outlined" onClick={() => void zoom(-0.2)}>−</Button>
          <Typography variant="caption">{Math.round(scale * 100)}%</Typography>
          <Button size="small" variant="outlined" onClick={() => void zoom(0.2)}>+</Button>
          <Typography variant="caption">{pageCount ? `${pageNum} / ${pageCount}` : ''}</Typography>
        </Stack>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        {loading && <CircularProgress size={24} sx={{ m: 2 }} />}
        <Box sx={{ position: 'relative', flexGrow: 1, minHeight: 0 }}>
          <Box
            ref={viewerContainerRef}
            sx={{ position: 'absolute', inset: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider' }}
            onMouseUp={onMouseUp}
          >
            {/* 禁用文本层原生选区背景（Chromium 对绝对定位 span 的选区渲染退化为整行矩形），由自绘层替代 */}
            <style>{`
              .textLayer ::selection { background: transparent; }
              .textLayer ::-moz-selection { background: transparent; }
            `}</style>
            <div ref={viewerElRef} className="pdfViewer" style={{ position: 'relative' }} />
            {/* 精确选区高亮层（Chromium 对文本层的原生选区会整行高亮，这里自绘替代） */}
            <div
              ref={selOverlayRef}
              style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}
            />
          </Box>
        </Box>
      </Box>

      <Box sx={{ width: 320, flexShrink: 0, overflow: 'auto', maxHeight: '88vh' }}>
        <Stack spacing={1} sx={{ p: 1 }}>
          <Typography variant="h6">AI 总结</Typography>
          <Button
            variant="contained"
            size="small"
            disabled={!selectedText || runningStreams.length > 0}
            onClick={() => paperId && void startSummary(paperId, 'selected', selectedText)}
          >
            总结选中段落
          </Button>
          {selectedText && (
            <Typography variant="caption" color="text.secondary" sx={{ maxHeight: 60, overflow: 'auto', display: 'block' }}>
              选中：{selectedText.slice(0, 120)}…
            </Typography>
          )}
          <Button
            variant="outlined"
            size="small"
            disabled={!fullText || runningStreams.length > 0}
            onClick={() => paperId && void startSummary(paperId, 'full', fullText)}
          >
            {fullText ? '总结全文' : '全文提取中…'}
          </Button>
          <PromptEditor settingKey="promptSummarySelected" label="总结选中段落" hint="「总结选中段落」使用的 AI 提示词" />
          <PromptEditor settingKey="promptSummaryFull" label="总结全文" hint="「总结全文」使用的 AI 提示词" />

          {runningStreams.map((s) => (
            <Box key={s.id} sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
              <Typography variant="caption" color="primary">生成中…</Typography>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{latexToText(s.text)}</Typography>
            </Box>
          ))}
          {errorStreams.map((s) => (
            <Alert key={s.id} severity="error">{s.error}</Alert>
          ))}

          <Divider />
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
            <Typography variant="subtitle2" sx={{ fontSize: 12 }}>批注</Typography>
            <Box sx={{ flexGrow: 1 }} />
            <Button size="small" variant="outlined" onClick={handleExportNotes}>导出</Button>
            <Button size="small" variant="outlined" onClick={() => noteImportRef.current?.click()}>导入</Button>
            <input
              ref={noteImportRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleImportNotesFile(f);
                e.target.value = '';
              }}
            />
          </Stack>
          {noteMsg && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5, wordBreak: 'break-all' }}>
              {noteMsg}
            </Typography>
          )}
          {selectedText && (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', maxHeight: 48, overflow: 'auto' }}>
                选中：{latexToText(selectedText).slice(0, 120)}…
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button size="small" variant="contained" onClick={handleAddHighlight}>
                  高亮
                </Button>
                <Button size="small" variant="outlined" onClick={() => setShowCommentInput((v) => !v)}>
                  批注
                </Button>
                <Button size="small" variant="outlined" color="secondary" onClick={handleSendToAssistant}>
                  发送到助手
                </Button>
              </Stack>
              {showCommentInput && (
                <Stack spacing={0.5}>
                  <TextField
                    size="small"
                    multiline
                    minRows={2}
                    placeholder="写下你的评论…"
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                  />
                  <Button size="small" variant="contained" disabled={!commentDraft.trim()} onClick={handleAddComment}>
                    保存批注
                  </Button>
                </Stack>
              )}
            </>
          )}
          {paperNotes.length === 0 && <Typography variant="caption" color="text.secondary">选中文字后可高亮或批注</Typography>}
          <List dense disablePadding>
            {paperNotes.map((n) => (
              <ListItem key={n.id} alignItems="flex-start" disableGutters
                secondaryAction={
                  <Stack direction="row" spacing={0}>
                    <Tooltip title={`跳转到第 ${n.page} 页`}>
                      <IconButton edge="end" size="small" onClick={() => void goto(n.page)}>
                        <OpenInNewIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <IconButton edge="end" size="small" onClick={() => handleDeleteNote(n.id)}>
                      <DeleteOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                }
              >
                <ListItemText
                  primary={
                    <Typography variant="caption">
                      <Chip size="small" label={n.type === 'comment' ? '批注' : '高亮'} sx={{ mr: 0.5, height: 18 }} />
                      第 {n.page} 页 · {new Date(n.createdAt).toLocaleString()}
                    </Typography>
                  }
                  secondary={
                    <>
                      <Typography variant="body2" component="span" sx={{ display: 'block', color: 'text.secondary' }}>
                        {latexToText(n.text).slice(0, 80)}
                      </Typography>
                      {n.content && (
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                          💬 {latexToText(n.content).slice(0, 120)}
                        </Typography>
                      )}
                    </>
                  }
                  onClick={() => openEditNote(n)}
                  sx={{ cursor: 'pointer' }}
                />
              </ListItem>
            ))}
          </List>

          {/* 批注编辑对话框 */}
          <Dialog open={editingNote !== null} onClose={() => setEditingNote(null)} fullWidth maxWidth="sm">
            <DialogTitle>编辑批注</DialogTitle>
            <DialogContent>
              <Stack spacing={1.5} sx={{ mt: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
                  原文（第 {editingNote?.page} 页）：{latexToText(editingNote?.text ?? '')}
                </Typography>
                <Box>
                  <InputLabel size="small">类型</InputLabel>
                  <Select
                    size="small"
                    fullWidth
                    value={editType}
                    onChange={(e) => setEditType(e.target.value as NoteType)}
                  >
                    <MenuItem value="comment">批注（评论）</MenuItem>
                    <MenuItem value="highlight">高亮</MenuItem>
                  </Select>
                </Box>
                <TextField
                  label="批注内容"
                  multiline
                  minRows={3}
                  fullWidth
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
              </Stack>
            </DialogContent>
            <DialogActions>
              <Button size="small" onClick={() => setEditingNote(null)}>取消</Button>
              <Button size="small" variant="contained" onClick={saveEditNote}>保存</Button>
            </DialogActions>
          </Dialog>

          <Divider />
          <Typography variant="subtitle2">上次总结</Typography>
          {history.length === 0 && <Typography variant="caption" color="text.secondary">暂无</Typography>}
          <List dense disablePadding>
            {history.map((s) => (
              <ListItem key={s.id} alignItems="flex-start" disableGutters>
                <ListItemText
                  primary={<Typography variant="caption">{KIND_LABEL[s.kind]} · {new Date(s.createdAt).toLocaleString()}</Typography>}
                  secondary={<Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{latexToText(s.content).slice(0, 400)}</Typography>}
                />
              </ListItem>
            ))}
          </List>
        </Stack>
      </Box>
    </Box>
  );
}
