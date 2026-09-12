// 文献库页：已入库论文列表，打开阅读器 / 下载 PDF / 删除。
import React, { useEffect, useState } from 'react';
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
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void loadPapers();
  }, [loadPapers]);

  const handleDownload = async (id: string) => {
    setDownloadingId(id);
    setMsg(null);
    try {
      const res = await downloadPdf(id);
      if (res.ok) {
        setMsg({ kind: 'success', text: `PDF 已下载到：${res.path ?? '存储目录'}` });
      } else {
        setMsg({ kind: 'error', text: res.message ?? 'PDF 下载失败' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMsg({ kind: 'error', text: message.replace(/^Error invoking remote method '[^']+': /, '') });
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h5" gutterBottom>
        文献库
      </Typography>
      {papers.length === 0 ? (
        <Typography color="text.secondary">还没有论文，去「检索」页搜索并保存吧。</Typography>
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
