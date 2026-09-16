// 文献库页：已入库论文列表，打开阅读器 / 下载 PDF / 删除 / 一体化导出 / 导入。
import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Paper from '@mui/material/Paper';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import { useLibraryStore } from '../store/libraryStore';

export function LibraryPage({ onOpenPaper }: { onOpenPaper: (id: string) => void }) {
  const { papers, loadPapers, removePaper, downloadPdf } = useLibraryStore();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const bundleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadPapers();
  }, [loadPapers]);

  const showMsg = (kind: 'success' | 'error', text: string) => setMsg({ kind, text });

  const handleDownload = async (id: string) => {
    setDownloadingId(id);
    setMsg(null);
    try {
      const res = await downloadPdf(id);
      if (res.ok) {
        showMsg('success', `PDF 已下载到：${res.path ?? '存储目录'}`);
      } else {
        showMsg('error', res.message ?? 'PDF 下载失败');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showMsg('error', message.replace(/^Error invoking remote method '[^']+': /, ''));
    } finally {
      setDownloadingId(null);
    }
  };

  const handleExportBundle = async (id: string) => {
    setExportingId(id);
    setMsg(null);
    try {
      const res = (await window.paper.invoke('paper:exportBundle', { id })) as {
        ok: boolean;
        path?: string;
        message?: string;
      };
      showMsg(res.ok ? 'success' : 'error', res.ok ? `论文包已导出：${res.path}` : `导出失败：${res.message ?? ''}`);
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : String(err));
    } finally {
      setExportingId(null);
    }
  };

  const handleImportLocalPdf = async (file: File) => {
    setMsg(null);
    try {
      const path = window.paper.getPathForFile(file);
      if (!path) {
        showMsg('error', '无法获取文件路径');
        return;
      }
      const res = (await window.paper.invoke('papers:importLocalPdf', { path })) as {
        ok: boolean;
        paper?: { title?: string };
        message?: string;
      };
      showMsg(res.ok ? 'success' : 'error', res.ok ? `已导入本地 PDF：${res.paper?.title ?? ''}` : `导入失败：${res.message ?? ''}`);
      if (res.ok) await loadPapers();
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : String(err));
    }
  };

  const handleImportBundle = async (file: File) => {
    setMsg(null);
    try {
      const path = window.paper.getPathForFile(file);
      if (!path) {
        showMsg('error', '无法获取文件路径');
        return;
      }
      const res = (await window.paper.invoke('paper:importBundle', { path })) as {
        ok: boolean;
        paper?: { title?: string };
        message?: string;
      };
      showMsg(res.ok ? 'success' : 'error', res.ok ? `已导入论文包：${res.paper?.title ?? ''}${res.message ? `（${res.message}）` : ''}` : `导入失败：${res.message ?? ''}`);
      if (res.ok) await loadPapers();
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h5" gutterBottom>
        文献库
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <Button size="small" variant="contained" onClick={() => pdfInputRef.current?.click()}>
          导入本地 PDF
        </Button>
        <Button size="small" variant="outlined" onClick={() => bundleInputRef.current?.click()}>
          导入论文包 (.paperstudio)
        </Button>
        <input
          ref={pdfInputRef}
          type="file"
          accept=".pdf,application/pdf"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImportLocalPdf(f);
            e.target.value = '';
          }}
        />
        <input
          ref={bundleInputRef}
          type="file"
          accept=".paperstudio,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImportBundle(f);
            e.target.value = '';
          }}
        />
      </Stack>
      {papers.length === 0 ? (
        <Typography color="text.secondary">
          还没有论文。可以从「检索」页搜索保存，或直接「导入本地 PDF」。
          <br />
          <Typography variant="caption" color="text.secondary" component="span">
            论文包 (.paperstudio) 是论文一体化数据（PDF + 批注 + 总结），可完整迁移。
          </Typography>
        </Typography>
      ) : (
        <>
          {msg && (
            <Alert severity={msg.kind} sx={{ mb: 2 }}>
              {msg.text}
            </Alert>
          )}
          <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>标题</TableCell>
                <TableCell>作者</TableCell>
                <TableCell>年份</TableCell>
                <TableCell>来源</TableCell>
                <TableCell>PDF</TableCell>
                <TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {papers.map((p) => (
                <TableRow key={p.id}>
                  <TableCell sx={{ maxWidth: 480 }}>
                    <Typography variant="body2">{p.title}</Typography>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 240 }}>
                    <Typography variant="caption">{p.authors.slice(0, 3).join(', ')}{p.authors.length > 3 ? ' 等' : ''}</Typography>
                  </TableCell>
                  <TableCell>{p.year ?? '—'}</TableCell>
                  <TableCell>
                    <Chip size="small" label={p.source} variant="outlined" />
                  </TableCell>
                  <TableCell>
                    {p.pdfPath ? <Chip size="small" color="success" label="已下载" /> : <Chip size="small" label="未下载" />}
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                      <Button size="small" variant="contained" onClick={() => onOpenPaper(p.id)}>
                        打开阅读器
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={exportingId !== null}
                        onClick={() => void handleExportBundle(p.id)}
                      >
                        {exportingId === p.id ? '导出中…' : '导出'}
                      </Button>
                      {!p.pdfPath && p.pdfUrl && (
                        <Button
                          size="small"
                          variant="outlined"
                          disabled={downloadingId !== null}
                          onClick={() => void handleDownload(p.id)}
                        >
                          {downloadingId === p.id ? '下载中…' : '下载 PDF'}
                        </Button>
                      )}
                      <Button size="small" color="error" variant="outlined" onClick={() => void removePaper(p.id)}>
                        删除
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </TableContainer>
        </>
      )}
    </Box>
  );
}
