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

export function SearchPage() {
  const [query, setQuery] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadMsg, setDownloadMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const { hits, searching, searchError, searchWarnings, papers, runSearch, loadPapers, saveHit, downloadPdf } =
    useLibraryStore();

  useEffect(() => {
    void loadPapers();
  }, [loadPapers]);

  const savedKeys = new Set(papers.map((p) => `${p.source}:${p.externalId}`));
  const isSaved = (h: PaperHit) => savedKeys.has(`${h.source}:${h.externalId}`);

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
            if (e.key === 'Enter') void runSearch(query);
          }}
        />
        <Button variant="contained" disabled={searching || !query.trim()} onClick={() => void runSearch(query)}>
          检索
        </Button>
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
