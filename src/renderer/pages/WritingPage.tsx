// 写作页（P6）：选论文 → 生成大纲 → 逐节撰写/手改 → 导出 docx / md。
import React, { useEffect, useRef, useState } from 'react';
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
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import EditNoteIcon from '@mui/icons-material/EditNote';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import { useLibraryStore } from '../store/libraryStore';
import { useWritingStore } from '../store/writingStore';
import { latexToText } from '../../shared/latex';
import type { DraftRecord } from '../../shared/types';

export function WritingPage() {
  const { papers, loadPapers } = useLibraryStore();
  const {
    drafts,
    loading,
    busy,
    error,
    load,
    create,
    remove,
    generateOutline,
    writeSection,
    setSection,
    export: exportDraft,
  } = useWritingStore();
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [paperId, setPaperId] = useState<string>('');
  const [refIds, setRefIds] = useState<string[]>([]);
  // 小节编辑本地缓冲 + 防抖落库（避免每敲一个字一次 IPC/写库）
  const [localDrafts, setLocalDrafts] = useState<Record<string, string>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    void loadPapers();
    void load();
  }, [loadPapers, load]);

  // 切换草稿/刷新后丢弃未提交的本地缓冲
  useEffect(() => {
    setLocalDrafts({});
    for (const t of Object.values(saveTimers.current)) clearTimeout(t);
    saveTimers.current = {};
  }, [currentId]);

  const handleSectionChange = (id: string, index: number, value: string) => {
    const key = `${id}:${index}`;
    setLocalDrafts((s) => ({ ...s, [key]: value }));
    const prev = saveTimers.current[key];
    if (prev) clearTimeout(prev);
    saveTimers.current[key] = setTimeout(() => {
      void setSection(id, index, value).catch(() => {});
      delete saveTimers.current[key];
    }, 500);
  };

  /** 导出/删除前把防抖中未落库的本地内容立即提交。 */
  const flushLocalDrafts = async () => {
    const keys = Object.keys(saveTimers.current);
    for (const key of keys) {
      const timer = saveTimers.current[key];
      if (timer) clearTimeout(timer);
      delete saveTimers.current[key];
      const [id, idxStr] = key.split(':');
      const value = localDrafts[key];
      if (value !== undefined) await setSection(id, Number(idxStr), value);
    }
    setLocalDrafts({});
  };

  const handleExport = async (format: 'docx' | 'md' | 'tex' | 'bib') => {
    if (!current) return;
    await flushLocalDrafts();
    await exportDraft(current.id, format);
  };

  const current: DraftRecord | null = drafts.find((d) => d.id === currentId) ?? null;

  const handleCreate = async () => {
    const paper = papers.find((p) => p.id === paperId) ?? null;
    const title = paper ? `《${latexToText(paper.title) || paper.title}》草稿` : '未命名草稿';
    // 主论文默认也作为参考论文之一（写作格式参考）
    const referenceIds = paperId && !refIds.includes(paperId) ? [paperId, ...refIds] : refIds;
    const record = await create(paper?.id ?? null, title, referenceIds);
    if (record) setCurrentId(record.id);
    setRefIds([]);
  };

  const outlineBusy = busy.outlineFor === currentId;
  const sectionBusyKey = busy.sectionFor;
  const exporting = busy.exportingFor === currentId;

  return (
    <Box sx={{ p: 2, display: 'flex', gap: 2, height: 'calc(100vh - 120px)' }}>
      {/* 左：草稿列表 */}
      <Paper variant="outlined" sx={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ p: 1.5 }}>
          <Typography variant="h6" gutterBottom sx={{ fontSize: 17 }}>
            写作
          </Typography>
          <Typography variant="caption" color="text.secondary">选择论文新建草稿</Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
            <Select size="small" value={paperId} onChange={(e) => setPaperId(e.target.value)} displayEmpty sx={{ flexGrow: 1 }}>
              <MenuItem value="" disabled>
                选择论文…
              </MenuItem>
              {papers.map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {(latexToText(p.title) || p.title).slice(0, 40)}
                </MenuItem>
              ))}
            </Select>
            <Button size="small" variant="contained" disabled={!paperId} onClick={() => void handleCreate()}>
              新建
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            参考论文（写作格式/内容参考，可多选）
          </Typography>
          <Select
            size="small"
            multiple
            value={refIds}
            onChange={(e) => setRefIds(e.target.value as string[])}
            renderValue={(sel) => `${sel.length} 篇参考`}
            sx={{ mt: 0.5, width: '100%' }}
          >
            {papers.map((p) => (
              <MenuItem key={p.id} value={p.id}>
                {(latexToText(p.title) || p.title).slice(0, 40)}
              </MenuItem>
            ))}
          </Select>
          {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
        </Box>
        <Divider />
        <List dense sx={{ flexGrow: 1, overflow: 'auto' }}>
          {drafts.map((d) => (
            <ListItem
              key={d.id}
              disablePadding
              secondaryAction={
                <IconButton
                  edge="end"
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    for (const t of Object.values(saveTimers.current)) clearTimeout(t);
                    saveTimers.current = {};
                    void remove(d.id);
                    if (d.id === currentId) setCurrentId(null);
                  }}
                >
                  <DeleteOutlinedIcon fontSize="small" />
                </IconButton>
              }
            >
              <ListItemButton selected={d.id === currentId} onClick={() => setCurrentId(d.id)}>
                <ListItemText
                  primary={d.title}
                  slotProps={{ primary: { noWrap: true, sx: { fontSize: 13 } } }}
                  secondary={
                    <Typography variant="caption" color="text.secondary">
                      {d.outline.length ? `${d.outline.length} 节` : '未生成大纲'}
                      {d.referenceIds.length ? ` · ${d.referenceIds.length} 篇参考` : ''}
                      {d.exportedPath ? ' · 已导出' : ''}
                    </Typography>
                  }
                />
              </ListItemButton>
            </ListItem>
          ))}
          {drafts.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              暂无草稿
            </Typography>
          )}
        </List>
      </Paper>

      {/* 右：草稿详情 */}
      <Box sx={{ flexGrow: 1, minWidth: 0, overflow: 'auto' }}>
        {!current ? (
          <Typography color="text.secondary" sx={{ mt: 4, textAlign: 'center' }}>
            选择或新建一个草稿开始写作。
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
                  startIcon={<AutoAwesomeIcon />}
                  disabled={outlineBusy || exporting || current.outline.length > 0}
                  onClick={() => void generateOutline(current.id)}
                >
                  {outlineBusy ? '生成中…' : '生成大纲'}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<FileDownloadIcon />}
                  disabled={exporting || current.sections.length === 0}
                  onClick={() => void handleExport('tex')}
                >
                  导出 TEX
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={!current || exporting || current.sections.length === 0}
                  onClick={() => void handleExport('bib')}
                >
                  导出 BIB
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<FileDownloadIcon />}
                  disabled={exporting || current.sections.length === 0}
                  onClick={() => void handleExport('docx')}
                >
                  导出 DOCX
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={exporting || current.sections.length === 0}
                  onClick={() => void handleExport('md')}
                >
                  导出 MD
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                📐 草稿以 LaTeX 源码撰写：数学用 $…$（如 {'$\\gamma$'}、{'$E=mc^2$'}），引用参考论文用 {'\\cite{key}'}
                （导出 .tex 时自动映射并生成 refs.bib，可用 xelatex 编译）
              </Typography>
              {outlineBusy && <CircularProgress size={18} sx={{ ml: 1, mb: 1 }} />}
              {exporting && (
                <Typography variant="caption" color="primary">
                  正在导出…
                </Typography>
              )}
              {current.exportedPath && (
                <Typography variant="caption" color="success.main" sx={{ display: 'block', mb: 1 }}>
                  已导出：{current.exportedPath}
                </Typography>
              )}
              {current.outline.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  尚未生成大纲。点击「生成大纲」后，逐节用 AI 撰写或手动编辑。
                </Typography>
              ) : (
                <Stack spacing={1.5} sx={{ mt: 1 }}>
                  {current.outline.map((item, i) => {
                    const section = current.sections[i];
                    const writingThis = sectionBusyKey === `${current.id}:${i}`;
                    return (
                      <Box key={i} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                          <Chip size="small" label={`${i + 1}`} />
                          <Typography
                            variant="subtitle2"
                            sx={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}
                          >
                            {latexToText(item.heading) || item.heading}
                          </Typography>
                          <Box sx={{ flexGrow: 1 }} />
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={writingThis ? <CircularProgress size={14} /> : <EditNoteIcon />}
                            disabled={writingThis}
                            onClick={() => void writeSection(current.id, i)}
                          >
                            {writingThis ? '撰写中…' : section?.content ? 'AI 重写' : 'AI 撰写'}
                          </Button>
                        </Stack>
                        {item.description && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            大纲说明：{latexToText(item.description) || item.description}
                          </Typography>
                        )}
                        <TextField
                          fullWidth
                          multiline
                          minRows={4}
                          size="small"
                          sx={{ mt: 1, '& .MuiInputBase-root': { fontFamily: 'Consolas, monospace', fontSize: 13 } }}
                          placeholder={'（未撰写）点击「AI 撰写」生成 LaTeX 源码，或直接在此手动编写（如 $\\gamma$、\\textbf{…}）'}
                          value={localDrafts[`${current.id}:${i}`] ?? section?.content ?? ''}
                          onChange={(e) => handleSectionChange(current.id, i, e.target.value)}
                        />
                      </Box>
                    );
                  })}
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
