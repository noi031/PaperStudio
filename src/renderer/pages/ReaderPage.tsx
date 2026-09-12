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
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import 'pdfjs-dist/web/pdf_viewer.css';
import { useLibraryStore } from '../store/libraryStore';
import { useAssistantStore } from '../store/assistantStore';
import type { SummaryRecord, NoteRecord } from '../../shared/types';
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
  const { summaries, streaming, notes, loadSummaries, loadNotes, addNote, deleteNote, startSummary, handleSummaryEvent } =
    useLibraryStore();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const notesRef = useRef<NoteRecord[]>([]);

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

  const docRef = useRef<{ doc: import('pdfjs-dist').PDFDocumentProxy; data: Uint8Array } | null>(null);

  const renderPage = useCallback(
    async (doc: import('pdfjs-dist').PDFDocumentProxy, num: number, s: number) => {
      const page = await doc.getPage(num);
      const viewport = page.getViewport({ scale: s });
      const canvas = canvasRef.current;
      const textLayer = textLayerRef.current;
      if (!canvas || !textLayer) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;

      textLayer.innerHTML = '';
      // pdfjs v5 的 TextLayer 依赖 CSS 变量做布局：--total-scale-factor 决定
      // 容器尺寸（setLayerDimensions 用 calc(var(--total-scale-factor) * ...px)）
      // 与 span 字号（font-size: calc(var(--total-scale-factor) * var(--font-height))）。
      // 官方 viewer 由 .pdfViewer .page 提供这些变量；裸 .textLayer 必须手动补齐，
      // 否则容器塌缩、字号退回默认 16px，文本层与画布错位，表现为「PDF 全是图片、无法选中」。
      textLayer.style.setProperty('--scale-factor', String(s));
      textLayer.style.setProperty('--total-scale-factor', String(s));
      textLayer.style.setProperty('--user-unit', '1');
      textLayer.style.setProperty('--scale-round-x', '1px');
      textLayer.style.setProperty('--scale-round-y', '1px');
      // 文本层：可选中文本，锚定到画布上方。
      const textSource = await page.streamTextContent();
      const tl = new pdfjs!.TextLayer({
        textContentSource: textSource,
        container: textLayer,
        viewport,
      });
      await tl.render();
      // 回放当前页的行内批注高亮
      applyHighlights(tl, num, notesRef.current);
    },
    [],
  );

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
        await renderPage(doc, 1, scale);
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
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      void docRef.current?.doc.destroy();
      docRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId]);

  const goto = async (num: number) => {
    const d = docRef.current;
    if (!d) return;
    const n = Math.max(1, Math.min(num, pageCount));
    await renderPage(d.doc, n, scale);
    setPageNum(n);
  };

  const zoom = async (delta: number) => {
    const d = docRef.current;
    if (!d) return;
    const next = Math.max(0.6, Math.min(3, scale + delta));
    setScale(next);
    await renderPage(d.doc, pageNum, next);
  };

  const onMouseUp = () => {
    const sel = window.getSelection()?.toString().trim() ?? '';
    setSelectedText(sel);
  };

  // 批注数据同步到 ref（渲染高亮用），并在变化后重绘当前页。
  useEffect(() => {
    const list = notes[paperId ?? ''] ?? [];
    notesRef.current = list;
    if (docRef.current && list.length >= 0) {
      void renderPage(docRef.current.doc, pageNum, scale).catch(() => {});
    }
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

  const handleSendToAssistant = () => {
    if (!selectedText) return;
    useAssistantStore
      .getState()
      .setPendingContext({ source: `阅读器：${title || '论文'}`, text: `论文：${title}\n\n选中段落（第 ${pageNum} 页）：\n${selectedText}` });
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
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <Button size="small" onClick={onBack}>← 返回</Button>
          <Typography variant="h6" noWrap sx={{ flexGrow: 1 }}>
            {title || '加载中…'}
          </Typography>
          <Button size="small" variant="outlined" onClick={() => void zoom(-0.2)}>−</Button>
          <Typography variant="caption">{Math.round(scale * 100)}%</Typography>
          <Button size="small" variant="outlined" onClick={() => void zoom(0.2)}>+</Button>
          <Button size="small" disabled={pageNum <= 1} onClick={() => void goto(pageNum - 1)}>上一页</Button>
          <Typography variant="caption">{pageCount ? `${pageNum} / ${pageCount}` : ''}</Typography>
          <Button size="small" disabled={pageNum >= pageCount} onClick={() => void goto(pageNum + 1)}>下一页</Button>
        </Stack>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        {loading && <CircularProgress size={24} sx={{ m: 2 }} />}
        <Box
          ref={containerRef}
          sx={{ position: 'relative', overflow: 'auto', maxHeight: '78vh', border: '1px solid', borderColor: 'divider' }}
          onMouseUp={onMouseUp}
        >
          <canvas ref={canvasRef} style={{ display: 'block' }} />
          <div
            ref={textLayerRef}
            className="textLayer"
            style={{
              position: 'absolute',
              inset: 0,
              lineHeight: 1,
              color: 'transparent',
              userSelect: 'text',
              zIndex: 1,
            }}
          />
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
          <Typography variant="subtitle2">批注</Typography>
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
                  <IconButton edge="end" size="small" onClick={() => handleDeleteNote(n.id)}>
                    <DeleteOutlinedIcon fontSize="small" />
                  </IconButton>
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
                  onClick={() => void goto(n.page)}
                  sx={{ cursor: 'pointer' }}
                />
              </ListItem>
            ))}
          </List>

          <Divider />
          <Typography variant="subtitle2">历史总结</Typography>
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
