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
import Link from '@mui/material/Link';
import { pdfProgressLabel, useLibraryStore } from '../store/libraryStore';
import { downloadUrlOf, fileNameOf } from '../fileLink';

export function LibraryPage({ onOpenPaper }: { onOpenPaper: (id: string) => void }) {
  const { papers, loadPapers, removePaper, downloadPdf, stopDownload, pdfJobs } = useLibraryStore();
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string; file?: string | null } | null>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const bundleInputRef = useRef<HTMLInputElement>(null);
  // 提示条里的产物名做成可点击下载（绝对路径只在服务端使用，不下发到界面）
  const msgFileUrl = msg?.file ? downloadUrlOf(msg.file) : null;

  useEffect(() => {
    void loadPapers();
  }, [loadPapers]);

  const showMsg = (kind: 'success' | 'error', text: string, file: string | null = null) => setMsg({ kind, text, file });

  // 正在下载的任务数（多任务并发时用于顶部提示）。
  const downloadingIds = Object.keys(pdfJobs).filter((id) => pdfJobs[id]?.status === 'running');

  // PDF 下载已改为后台任务：源站限速下整篇要数分钟，同步等待会被网关判成超时
  // 并回 "Bad Gateway"。这里只负责发起，进度/结果由 papers:event 回调写回 pdfJobs。
  // 多篇可同时下载（pdfJobs 按论文 id 各自记录），每篇可单独停止。
  const handleDownload = async (id: string) => {
    setMsg(null);
    try {
      const res = await downloadPdf(id);
      if (!res.ok) {
        showMsg('error', res.message ?? 'PDF 下载失败');
        return;
      }
      if (res.status === 'done') {
        showMsg('success', 'PDF 已下载到：', res.path ?? null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showMsg('error', message.replace(/^Error invoking remote method '[^']+': /, ''));
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
      showMsg(
          res.ok ? 'success' : 'error',
          res.ok ? '论文包已导出：' : `导出失败：${res.message ?? ''}`,
          res.ok ? res.path ?? null : null,
        );
    } catch (err) {
      showMsg('error', err instanceof Error ? err.message : String(err));
    } finally {
      setExportingId(null);
    }
  };

  const handleImportLocalPdf = async (file: File) => {
    setMsg(null);
    try {
      const path = await window.paper.uploadFile(file);
      if (!path) {
        showMsg('error', '文件上传失败');
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
      const path = await window.paper.uploadFile(file);
      if (!path) {
        showMsg('error', '文件上传失败');
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
              {msg.file && msgFileUrl && (
                <Link href={msgFileUrl} download={fileNameOf(msg.file)} underline="hover" sx={{ wordBreak: 'break-all' }}>
                  {fileNameOf(msg.file)}
                </Link>
              )}
            </Alert>
          )}
          {downloadingIds.length > 0 && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {`正在下载 PDF（${downloadingIds.length} 个任务）：可继续使用其他功能，也可在列表中单独停止`}
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
                        pdfJobs[p.id]?.status === 'running' ? (
                          <>
                            <Typography variant="caption" sx={{ alignSelf: 'center' }}>{pdfProgressLabel(pdfJobs[p.id])}</Typography>
                            <Button size="small" variant="outlined" color="warning" onClick={() => void stopDownload(p.id)}>
                              停止
                            </Button>
                          </>
                        ) : (
                          <Button size="small" variant="outlined" onClick={() => void handleDownload(p.id)}>
                            {pdfJobs[p.id]?.status === 'stopped' ? '继续下载' : pdfJobs[p.id]?.status === 'error' ? '重试下载' : '下载 PDF'}
                          </Button>
                        )
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
