// 检索页：arXiv + Semantic Scholar 并发检索 → 结果表 → 保存入库 / 下载 PDF。
import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import LinearProgress from '@mui/material/LinearProgress';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Paper from '@mui/material/Paper';
import Chip from '@mui/material/Chip';
import { useLibraryStore } from '../store/libraryStore';
import type { PaperHit, PaperRecord } from '../../shared/types';
import { latexToText } from '../../shared/latex';

const SOURCE_LABEL: Record<string, string> = { arxiv: 'arXiv', semantic_scholar: 'S2', openalex: 'OpenAlex' };
const PAGE_SIZE = 10;

export function SearchPage() {
  const [query, setQuery] = useState('');
  // 分页：第 1 页起；翻页时用同一关键词重新检索（offset = (page-1)*PAGE_SIZE）。
  const [page, setPage] = useState(1);
  // 每页的 OpenAlex 游标（cursors[page-1] = 请求第 page 页用的 cursor；OpenAlex 用 cursor 分页）。
  const [cursors, setCursors] = useState<string[]>(['*']);
  // 是否已到最后一页（下一页返回空结果）
  const [noMore, setNoMore] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadMsg, setDownloadMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const { hits, searching, searchError, searchWarnings, papers, runSearch, loadPapers, saveHit, downloadPdf } =
    useLibraryStore();

  useEffect(() => {
    void loadPapers();
  }, [loadPapers]);

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

  const handleSave = async (h: PaperHit) => {
    await saveHit(h);
  };

  const handleDownload = async (id: string) => {
    if (!id) {
      setDownloadMsg({ kind: 'error', text: '未找到已入库的论文记录，请先「保存」' });
      return;
    }
    setDownloadingId(id);
    setDownloadMsg(null);
    try {
      const res = await downloadPdf(id);
      if (res.ok) {
        setDownloadMsg({ kind: 'success', text: `PDF 已下载到：${res.path ?? '存储目录'}` });
      } else {
        setDownloadMsg({ kind: 'error', text: res.message ?? 'PDF 下载失败' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDownloadMsg({ kind: 'error', text: message.replace(/^Error invoking remote method '[^']+': /, '') });
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h5" gutterBottom>
        检索
      </Typography>
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
      {downloadMsg && (
        <Alert severity={downloadMsg.kind} sx={{ mb: 2 }}>
          {downloadMsg.text}
        </Alert>
      )}
      {hits.length > 0 && (
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
                      {isSaved(h) && (
                        <Button
                          size="small"
                          variant="outlined"
                          disabled={downloadingId !== null}
                          onClick={() => void handleDownload(getSavedId(h, papers) ?? '')}
                        >
                          {downloadingId === getSavedId(h, papers) ? '下载中…' : '下载 PDF'}
                        </Button>
                      )}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}

function getSavedId(h: PaperHit, papers: PaperRecord[]): string | null {
  return papers.find((p) => p.source === h.source && p.externalId === h.externalId)?.id ?? null;
}
