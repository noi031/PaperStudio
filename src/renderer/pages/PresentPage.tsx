// 演示页（P7）：选论文 → 生成幻灯片提纲 → 预览 → 导出 .pptx。
import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import SlideshowIcon from '@mui/icons-material/Slideshow';
import Link from '@mui/material/Link';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import { useLibraryStore } from '../store/libraryStore';
import { usePresentationStore } from '../store/presentationStore';
import { PromptEditor } from '../components/PromptEditor';
import { latexToText } from '../../shared/latex';
import { downloadUrlOf, fileNameOf } from '../fileLink';
import type { PresentationRecord } from '../../shared/types';

export function PresentPage() {
  const { papers, loadPapers } = useLibraryStore();
  const { records, loading, busy, error, load, create, remove, generateSlides, export: exportPptx } =
    usePresentationStore();
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [paperId, setPaperId] = useState<string>('');

  useEffect(() => {
    void loadPapers();
    void load();
  }, [loadPapers, load]);

  const current: PresentationRecord | null = records.find((r) => r.id === currentId) ?? null;

  const handleCreate = async () => {
    const paper = papers.find((p) => p.id === paperId) ?? null;
    const title = paper ? `${latexToText(paper.title) || paper.title} 演示` : '未命名演示';
    const record = await create(paper?.id ?? null, title);
    if (record) setCurrentId(record.id);
  };

  const generating = busy.generatingFor === currentId;
  const exporting = busy.exportingFor === currentId;

  return (
    <Box sx={{ p: 2, display: 'flex', gap: 2, height: 'calc(100vh - 120px)' }}>
      {/* 左：演示列表 */}
      <Paper variant="outlined" sx={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ p: 1.5 }}>
          <Typography variant="h6" gutterBottom sx={{ fontSize: 17 }}>
            演示
          </Typography>
          <Typography variant="caption" color="text.secondary">选择论文新建演示</Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
            <Select
              size="small"
              value={paperId}
              onChange={(e) => setPaperId(e.target.value)}
              displayEmpty
              sx={{
                flexGrow: 1,
                minWidth: 0,
                '& .MuiSelect-select': { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
              }}
            >
              <MenuItem value="" disabled>
                选择论文…
              </MenuItem>
              {papers.map((p) => (
                <MenuItem
                  key={p.id}
                  value={p.id}
                  sx={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 420 }}
                >
                  {(latexToText(p.title) || p.title).slice(0, 60)}
                </MenuItem>
              ))}
            </Select>
            <Button size="small" variant="contained" disabled={!paperId} onClick={() => void handleCreate()}>
              新建
            </Button>
          </Stack>
          {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
        </Box>
        <Divider />
        <List dense sx={{ flexGrow: 1, overflow: 'auto' }}>
          {records.map((r) => (
            <ListItem
              key={r.id}
              disablePadding
              secondaryAction={
                <IconButton
                  edge="end"
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(r.id);
                    if (r.id === currentId) setCurrentId(null);
                  }}
                >
                  <DeleteOutlinedIcon fontSize="small" />
                </IconButton>
              }
            >
              <ListItemButton selected={r.id === currentId} onClick={() => setCurrentId(r.id)}>
                <ListItemText
                  primary={r.title}
                  slotProps={{ primary: { noWrap: true, sx: { fontSize: 13 } } }}
                  secondary={
                    <Typography variant="caption" color="text.secondary">
                      {r.slides.length ? `${r.slides.length} 页` : '未生成'}
                      {r.pptxPath ? ' · 已导出' : ''}
                    </Typography>
                  }
                />
              </ListItemButton>
            </ListItem>
          ))}
          {records.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              暂无演示
            </Typography>
          )}
        </List>
      </Paper>

      {/* 右：幻灯片预览 */}
      <Box sx={{ flexGrow: 1, minWidth: 0, overflow: 'auto' }}>
        {!current ? (
          <Typography color="text.secondary" sx={{ mt: 4, textAlign: 'center' }}>
            选择或新建一个演示开始制作。
          </Typography>
        ) : (
          <Card variant="outlined">
            <CardContent>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap', rowGap: 1 }}>
                <Typography
                  variant="h6"
                  sx={{ flexGrow: 1, minWidth: 120, fontSize: 17, lineHeight: 1.4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {current.title}
                </Typography>
                <Button
                  size="small"
                  variant="contained"
                  startIcon={generating ? <CircularProgress size={14} /> : <AutoAwesomeIcon />}
                  disabled={generating || exporting}
                  onClick={() => void generateSlides(current.id)}
                >
                  {generating ? '生成中…' : current.slides.length ? '重新生成' : '生成幻灯片'}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<FileDownloadIcon />}
                  disabled={exporting || current.slides.length === 0}
                  onClick={() => void exportPptx(current.id)}
                >
                  导出 PPTX
                </Button>
              </Stack>
              <PromptEditor settingKey="promptSlides" label="生成幻灯片" hint="「生成幻灯片」使用的 AI 提示词" />
              {exporting && (
                <Typography variant="caption" color="primary">
                  正在导出…
                </Typography>
              )}
              {current.pptxPath && (
                <Link
                  href={downloadUrlOf(current.pptxPath) ?? '#'}
                  download={fileNameOf(current.pptxPath)}
                  underline="hover"
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, mb: 1, fontSize: 13 }}
                >
                  <FileDownloadIcon sx={{ fontSize: 15 }} />
                  下载 PPTX：{fileNameOf(current.pptxPath)}
                </Link>
              )}
              {current.slides.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  尚未生成幻灯片。点击「生成幻灯片」后即可预览并导出 .pptx。
                </Typography>
              ) : (
                <Stack spacing={1.5} sx={{ mt: 1 }}>
                  {current.slides.map((s, i) => (
                    <Box key={i} sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`${i + 1}`}
                        sx={{ mt: 1.5, minWidth: 34 }}
                      />
                      <Box
                        sx={{
                          flexGrow: 1,
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: 1,
                          p: 1.5,
                          aspectRatio: '16 / 9',
                          overflow: 'hidden',
                          bgcolor: 'background.paper',
                        }}
                      >
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <SlideshowIcon fontSize="small" color="primary" />
                          <Typography variant="subtitle2">{latexToText(s.title) || s.title}</Typography>
                        </Stack>
                        <Stack spacing={0.25} sx={{ mt: 0.75 }}>
                          {s.bullets.map((b, j) => (
                            <Typography key={j} variant="body2" sx={{ pl: 1 }}>
                              • {latexToText(b) || b}
                            </Typography>
                          ))}
                        </Stack>
                        {s.note && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, fontStyle: 'italic' }}>
                            备注：{s.note}
                          </Typography>
                        )}
                      </Box>
                    </Box>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>
        )}
        {loading && <Typography variant="caption">加载中…</Typography>}
      </Box>
    </Box>
  );
}
