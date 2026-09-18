// 检索页：普通关键词检索（arXiv + Semantic Scholar + OpenAlex）+ AI 提问式检索（agentic）。
import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import LinearProgress from '@mui/material/LinearProgress';
import Chip from '@mui/material/Chip';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Paper from '@mui/material/Paper';
import Link from '@mui/material/Link';
import { pdfProgressLabel, useLibraryStore } from '../store/libraryStore';
import { downloadUrlOf, fileNameOf } from '../fileLink';
import type { PaperHit, PaperRecord } from '../../shared/types';
import { latexToText } from '../../shared/latex';

const SOURCE_LABEL: Record<string, string> = { arxiv: 'arXiv', semantic_scholar: 'S2', openalex: 'OpenAlex' };
const PAGE_SIZE = 10;
const STAGE_LABEL: Record<string, string> = { plan: 'AI 正在分析问题并生成检索策略…', searching: '正在多源检索并合并结果…', scoring: '正在评估各结果的相关程度…' };

interface Relevance {
  level: '高' | '中' | '低';
  reason: string;
}

const LEVEL_COLOR: Record<string, 'success' | 'warning' | 'default'> = { 高: 'success', 中: 'warning', 低: 'default' };

export function SearchPage() {
  const [mode, setMode] = useState<'keyword' | 'agentic'>('keyword');
  const [query, setQuery] = useState('');
  // 分页：第 1 页起；翻页时用同一关键词重新检索（offset = (page-1)*PAGE_SIZE）。
  const [page, setPage] = useState(1);
  // 每页的 OpenAlex 游标（cursors[page-1] = 请求第 page 页用的 cursor；OpenAlex 用 cursor 分页）。
  const [cursors, setCursors] = useState<string[]>(['*']);
  // 是否已到最后一页（下一页返回空结果）
  const [noMore, setNoMore] = useState(false);
  // AI 检索状态
  const [agenticQuestion, setAgenticQuestion] = useState('');
  const [agenticSearching, setAgenticSearching] = useState(false);
  const [agenticStage, setAgenticStage] = useState<string | null>(null);
  const [agenticHits, setAgenticHits] = useState<PaperHit[]>([]);
  const [agenticQueries, setAgenticQueries] = useState<string[]>([]);
  const [agenticRelevance, setAgenticRelevance] = useState<Record<string, Relevance>>({});
  const [agenticError, setAgenticError] = useState<string | null>(null);
  const [agenticWarnings, setAgenticWarnings] = useState<string[]>([]);
  const [downloadMsg, setDownloadMsg] = useState<{
    kind: 'success' | 'error';
    text: string;
    file?: string | null;
  } | null>(null);
  const { hits, searching, searchError, searchWarnings, papers, runSearch, loadPapers, saveHit, downloadPdf, stopDownload, pdfJobs } =
    useLibraryStore();

  useEffect(() => {
    void loadPapers();
  }, [loadPapers]);

  // AI 检索阶段进度（主进程 search:event）
  useEffect(() => {
    const off = window.paper.onSearchEvent((p) => {
      if (p?.stage && STAGE_LABEL[p.stage]) setAgenticStage(p.stage);
    });
    return off;
  }, []);

  const savedKeys = new Set(papers.map((p) => `${p.source}:${p.externalId}`));
  const isSaved = (h: PaperHit) => savedKeys.has(`${h.source}:${h.externalId}`);

  const doSearch = async (p: number) => {
    if (!query.trim()) return { nextCursor: null as string | null, count: 0 };
    const cursor = cursors[p - 1] ?? '*';
    setNoMore(false);
    const res = await runSearch(query, PAGE_SIZE, (p - 1) * PAGE_SIZE, cursor);
    // 记录本页返回的 nextCursor，供「下一页」使用（OpenAlex 通道）
    if (res.nextCursor) {
      setCursors((cs) => {
        const next = [...cs];
        next[p] = res.nextCursor ?? '';
        return next;
      });
    }
    return res;
  };

  const handleSearch = () => {
    setPage(1);
    setCursors(['*']);
    setNoMore(false);
    void doSearch(1);
  };

  const handleNext = async () => {
    const res = await doSearch(page + 1);
    if (res.count === 0) {
      // 下一页无任何结果：提示没有更多，留在当前页
      setNoMore(true);
    } else {
      setPage(page + 1);
    }
  };

  const handlePrev = () => {
    const prev = Math.max(1, page - 1);
    setPage(prev);
    setNoMore(false);
    void doSearch(prev);
  };

  const handleAgenticSearch = async () => {
    if (!agenticQuestion.trim()) return;
    setAgenticSearching(true);
    setAgenticError(null);
    setAgenticWarnings([]);
    setAgenticHits([]);
    setAgenticQueries([]);
    setAgenticRelevance({});
    setDownloadMsg(null);
    try {
      const res = (await window.paper.invoke('search:agentic', { question: agenticQuestion.trim() })) as {
        ok: boolean;
        hits?: PaperHit[];
        queries?: string[];
        relevance?: Record<string, Relevance>;
        warnings?: string[];
        message?: string;
      };
      if (!res.ok) {
        setAgenticError(res.message ?? 'AI 检索失败');
        return;
      }
      setAgenticHits(res.hits ?? []);
      setAgenticQueries(res.queries ?? []);
      setAgenticRelevance(res.relevance ?? {});
      setAgenticWarnings(res.warnings ?? []);
    } catch (err) {
      setAgenticError(err instanceof Error ? err.message : String(err));
    } finally {
      setAgenticSearching(false);
      setAgenticStage(null);
    }
  };

  const handleSave = async (h: PaperHit) => {
    await saveHit(h);
  };

  // PDF 下载是后台任务：进度与结果经 papers:event 推送写回 pdfJobs。
  // 多篇可同时下载（每行各自显示进度，可单独停止）。
  const handleDownload = async (id: string) => {
    if (!id) {
      setDownloadMsg({ kind: 'error', text: '未找到已入库的论文记录，请先「保存」' });
      return;
    }
    setDownloadMsg(null);
    try {
      const res = await downloadPdf(id);
      if (!res.ok) {
        setDownloadMsg({ kind: 'error', text: res.message ?? 'PDF 下载失败' });
        return;
      }
      if (res.status === 'done') {
        setDownloadMsg({ kind: 'success', text: 'PDF 已下载到：', file: res.path ?? null });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDownloadMsg({ kind: 'error', text: message.replace(/^Error invoking remote method '[^']+': /, '') });
    }
  };

  // 正在下载的任务数（多任务并发时用于顶部提示）。
  const downloadingIds = Object.keys(pdfJobs).filter((id) => pdfJobs[id]?.status === 'running');

  // 行内下载单元：多任务并发，各自显示进度，可单独停止。
  const renderDownloadCell = (h: PaperHit) => {
    const id = getSavedId(h, papers);
    if (!id) return null;
    const job = pdfJobs[id];
    if (job?.status === 'running') {
      return (
        <>
          <Typography variant="caption" sx={{ alignSelf: 'center' }}>{pdfProgressLabel(job)}</Typography>
          <Button size="small" variant="outlined" color="warning" onClick={() => void stopDownload(id)}>
            停止
          </Button>
        </>
      );
    }
    return (
      <Button size="small" variant="outlined" onClick={() => void handleDownload(id)}>
        {job?.status === 'stopped' ? '继续下载' : job?.status === 'error' ? '重试下载' : '下载 PDF'}
      </Button>
    );
  };

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h5" gutterBottom>
        检索
      </Typography>
      <Tabs value={mode} onChange={(_e, v) => setMode(v as 'keyword' | 'agentic')} sx={{ mb: 2 }}>
        <Tab value="keyword" label="关键词检索" />
        <Tab value="agentic" label="AI 提问检索" />
      </Tabs>

      {mode === 'keyword' && (
        <>
          <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
            <TextField
              label="关键词"
              size="small"
              sx={{ width: 420 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
            />
            <Button variant="contained" disabled={searching || !query.trim()} onClick={handleSearch}>
              检索
            </Button>
            <Button variant="outlined" disabled={searching || page <= 1} onClick={handlePrev}>
              上一页
            </Button>
            <Button variant="outlined" disabled={searching || noMore} onClick={() => void handleNext()}>
              下一页
            </Button>
            {hits.length > 0 && (
              <Typography variant="caption" sx={{ alignSelf: 'center' }}>
                第 {page} 页（每页 {PAGE_SIZE} 条）{noMore ? ' · 已到最后一页' : ''}
              </Typography>
            )}
          </Stack>
          {searching && <LinearProgress sx={{ mb: 2 }} />}
          {searchError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {searchError}
            </Alert>
          )}
          {searchWarnings.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {searchWarnings.join('；')}
            </Alert>
          )}
        </>
      )}

      {mode === 'agentic' && (
        <>
          <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
            <TextField
              label="用自然语言提问，让 AI 帮你检索论文"
              size="small"
              sx={{ width: 560 }}
              multiline
              maxRows={3}
              value={agenticQuestion}
              onChange={(e) => setAgenticQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) void handleAgenticSearch();
              }}
              placeholder="例如：关于量子纠缠在超导量子比特中应用的最新论文"
            />
            <Button variant="contained" disabled={agenticSearching || !agenticQuestion.trim()} onClick={() => void handleAgenticSearch()}>
              {agenticSearching ? 'AI 检索中…' : 'AI 检索'}
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            与普通关键词检索不同：AI 会先分析你的问题生成检索策略，再多源检索，最后为每条结果标注相关程度。结果同样支持保存入库与下载 PDF。
          </Typography>
          {agenticSearching && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
              <LinearProgress sx={{ flexGrow: 1 }} />
              <Typography variant="caption">{STAGE_LABEL[agenticStage ?? ''] ?? 'AI 检索中…'}</Typography>
            </Stack>
          )}
          {agenticError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {agenticError}
            </Alert>
          )}
          {agenticWarnings.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {agenticWarnings.join('；')}
            </Alert>
          )}
          {agenticQueries.length > 0 && (
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap' }}>
              <Typography variant="caption" color="text.secondary">AI 生成的检索词：</Typography>
              {agenticQueries.map((q) => (
                <Chip key={q} size="small" label={q} variant="outlined" onClick={() => { setMode('keyword'); setQuery(q); handleSearch(); }} />
              ))}
            </Stack>
          )}
        </>
      )}

      {downloadingIds.length > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {`正在下载 PDF（${downloadingIds.length} 个任务）：可继续检索或总结，也可在列表中单独停止`}
        </Alert>
      )}

      {downloadMsg && (
        <Alert severity={downloadMsg.kind} sx={{ mb: 2 }}>
          {downloadMsg.text}
          {downloadMsg.file && downloadUrlOf(downloadMsg.file) && (
            <Link
              href={String(downloadUrlOf(downloadMsg.file))}
              download={fileNameOf(downloadMsg.file)}
              underline="hover"
              sx={{ wordBreak: 'break-all' }}
            >
              {fileNameOf(downloadMsg.file)}
            </Link>
          )}
        </Alert>
      )}

      {mode === 'keyword' && hits.length > 0 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>标题</TableCell>
                <TableCell>作者</TableCell>
                <TableCell>年份</TableCell>
                <TableCell>来源</TableCell>
                <TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {hits.map((h, i) => (
                <TableRow key={`${h.source}-${h.externalId}-${i}`}>
                  <TableCell sx={{ maxWidth: 480 }}>
                    <Typography variant="body2">{latexToText(h.title) || h.title}</Typography>
                    {h.abstract && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {latexToText(h.abstract).slice(0, 240)}
                        {h.abstract.length > 240 ? '…' : ''}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 240 }}>
                    <Typography variant="caption">{h.authors.slice(0, 3).join(', ')}{h.authors.length > 3 ? ' 等' : ''}</Typography>
                  </TableCell>
                  <TableCell>{h.year ?? '—'}</TableCell>
                  <TableCell>
                    <Chip size="small" label={SOURCE_LABEL[h.source] ?? h.source} variant="outlined" />
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                      {isSaved(h) ? (
                        <Chip size="small" color="success" label="已入库" />
                      ) : (
                        <Button size="small" variant="outlined" onClick={() => void handleSave(h)}>
                          保存
                        </Button>
                      )}
                      {isSaved(h) && renderDownloadCell(h)}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {mode === 'agentic' && agenticHits.length > 0 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>相关度</TableCell>
                <TableCell>标题</TableCell>
                <TableCell>作者</TableCell>
                <TableCell>年份</TableCell>
                <TableCell>来源</TableCell>
                <TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {agenticHits.map((h, i) => {
                const rel = agenticRelevance[`${h.source}:${h.externalId.replace(/v\d+$/, '')}`]
                  ?? agenticRelevance[`${h.source}:${h.externalId}`];
                return (
                  <TableRow key={`agentic-${h.source}-${h.externalId}-${i}`}>
                    <TableCell sx={{ maxWidth: 220, verticalAlign: 'top' }}>
                      {rel ? (
                        <>
                          <Chip size="small" color={LEVEL_COLOR[rel.level] ?? 'default'} label={`相关度：${rel.level}`} sx={{ mb: 0.5 }} />
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', whiteSpace: 'normal' }}>
                            {rel.reason}
                          </Typography>
                        </>
                      ) : (
                        <Chip size="small" label="未评估" variant="outlined" />
                      )}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 480 }}>
                      <Typography variant="body2">{latexToText(h.title) || h.title}</Typography>
                      {h.abstract && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {latexToText(h.abstract).slice(0, 240)}
                          {h.abstract.length > 240 ? '…' : ''}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 200 }}>
                      <Typography variant="caption">{h.authors.slice(0, 3).join(', ')}{h.authors.length > 3 ? ' 等' : ''}</Typography>
                    </TableCell>
                    <TableCell>{h.year ?? '—'}</TableCell>
                    <TableCell>
                      <Chip size="small" label={SOURCE_LABEL[h.source] ?? h.source} variant="outlined" />
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                        {isSaved(h) ? (
                          <Chip size="small" color="success" label="已入库" />
                        ) : (
                          <Button size="small" variant="outlined" onClick={() => void handleSave(h)}>
                            保存
                          </Button>
                        )}
                        {isSaved(h) && renderDownloadCell(h)}
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {mode === 'agentic' && !agenticSearching && !agenticError && agenticHits.length === 0 && agenticQuestion.trim() !== '' && (
        <Typography variant="body2" color="text.secondary">AI 没有找到相关结果，换个问法试试。</Typography>
      )}
    </Box>
  );
}

function getSavedId(h: PaperHit, papers: PaperRecord[]): string | null {
  return papers.find((p) => p.source === h.source && p.externalId === h.externalId)?.id ?? null;
}
