// 写作页（P6）：选论文 → 生成大纲 → 逐节撰写/手改 → 导出 docx / md。
import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import AddIcon from '@mui/icons-material/Add';
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
import { PromptEditor } from '../components/PromptEditor';
import { SearchablePaperSelect, filterPapers } from '../components/PaperSelect';
import { latexToText } from '../../shared/latex';
import { renderLatexHtml, latexHeadingToText } from '../../shared/latexPreview';
import 'katex/dist/katex.min.css';
import Link from '@mui/material/Link';
import { downloadUrlOf, fileNameOf } from '../fileLink';
import type { DraftRecord } from '../../shared/types';

export function WritingPage() {
  const { papers, loadPapers } = useLibraryStore();
  const {
    drafts,
    loading,
    busy,
    error,
    setError,
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
  // 小节预览模式：key = `${draftId}:${index}` 处于预览时显示渲染后的内容
  const [previewKeys, setPreviewKeys] = useState<Set<string>>(new Set());
  const togglePreview = (key: string) =>
    setPreviewKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // 人工修改建议：每小节一个（AI 撰写/重写时传递给模型），key = `${draftId}:${index}`
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  const [instructionOpen, setInstructionOpen] = useState<Set<string>>(new Set());
  // 大纲手工编辑：进入编辑模式时拷贝一份草稿大纲
  const [outlineEditing, setOutlineEditing] = useState(false);
  const [outlineDraft, setOutlineDraft] = useState<Array<{ heading: string; description: string }>>([]);
  // 参考文献管理（编号与 \cite{refN} 对应）
  const [refDialogOpen, setRefDialogOpen] = useState(false);
  const [refQuery, setRefQuery] = useState('');
  const [refSelected, setRefSelected] = useState<string[]>([]);
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
    setInstructions({});
    setInstructionOpen(new Set());
    setPreviewKeys(new Set());
    setOutlineEditing(false);
    setOutlineDraft([]);
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

  const [exportResult, setExportResult] = useState<{ path: string | null; bibPath: string | null }>({ path: null, bibPath: null });

  const handleExport = async (format: 'docx' | 'md' | 'tex' | 'bib') => {
    if (!current) return;
    setExportResult({ path: null, bibPath: null });
    await flushLocalDrafts();
    const r = await exportDraft(current.id, format);
    setExportResult(r);
  };

  /** 整篇预览：大纲标题 + 各小节内容 → Markdown（公式 $…$ 保留）→ 服务端渲染 HTML 弹窗。 */
  /** 大纲手工编辑：进入编辑模式 / 保存 / 取消。 */
  const startOutlineEdit = () => {
    if (!current) return;
    setOutlineDraft(current.outline.map((o) => ({ heading: o.heading, description: o.description ?? '' })));
    setOutlineEditing(true);
  };
  const saveOutline = async () => {
    if (!current) return;
    const items = outlineDraft
      .map((o) => ({ heading: o.heading.trim(), description: o.description.trim() }))
      .filter((o) => o.heading);
    if (items.length === 0) {
      setError('大纲至少保留一个小节');
      return;
    }
    try {
      await window.paper.invoke('drafts:setOutline', { id: current.id, outline: items });
      await load();
      setOutlineEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openRefDialog = () => {
    setRefSelected([...(current?.referenceIds ?? [])]);
    setRefQuery('');
    setRefDialogOpen(true);
  };
  const toggleRef = (id: string) =>
    setRefSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const saveRefs = async () => {
    if (!current) return;
    try {
      await window.paper.invoke('drafts:setReferences', { id: current.id, referenceIds: refSelected });
      await load();
      setRefDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePreviewFull = async () => {
    if (!current) return;
    // 传给服务端结构与各节 LaTeX 源码；服务端与逐节预览共用同一 renderLatexHtml 渲染，结果一致
    try {
      const res = await window.paper.invoke('preview:latex', {
        name: `draft-${current.id.slice(0, 8)}`,
        title: current.title,
        sections: current.outline.map((item, i) => ({
          heading: item.heading,
          description: item.description ?? '',
          content: localDrafts[`${current.id}:${i}`] ?? current.sections[i]?.content ?? '',
        })),
      });
      const url = (res as { url?: string } | undefined)?.url;
      if (url) window.open(url, '_blank', 'noopener');
      else setError('预览生成失败');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const current: DraftRecord | null = drafts.find((d) => d.id === currentId) ?? null;
  // 当前草稿的参考文献详情（按 draft.referenceIds 顺序 = ref1、ref2…）
  const refPapers = (current?.referenceIds ?? [])
    .map((id) => papers.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

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
            <SearchablePaperSelect
              papers={papers}
              value={paperId}
              onChange={(v) => setPaperId(v as string)}
              placeholder="选择论文…"
            />
            <Button size="small" variant="contained" disabled={!paperId} onClick={() => void handleCreate()}>
              新建
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            参考论文（写作格式/内容参考，可多选）
          </Typography>
          <SearchablePaperSelect
            papers={papers}
            multiple
            value={refIds}
            onChange={(v) => setRefIds(v as string[])}
            placeholder="选择参考论文…"
            sx={{ mt: 0.5, width: '100%' }}
          />
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
                  color="secondary"
                  disabled={current.outline.length === 0}
                  onClick={() => void handlePreviewFull()}
                >
                  预览全文
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={current.outline.length === 0}
                  onClick={startOutlineEdit}
                >
                  编辑大纲
                </Button>
              </Stack>
              {/* 参考文献：编号与 \cite{refN} 对应，可管理增删改 */}
              <Box sx={{ mt: 1, p: 1, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Typography variant="subtitle2" sx={{ fontSize: 13 }}>📚 参考文献（{refPapers.length}）</Typography>
                  <Box sx={{ flexGrow: 1 }} />
                  <Button size="small" onClick={openRefDialog}>
                    管理
                  </Button>
                </Stack>
                {refPapers.length === 0 ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    暂无参考论文。点「管理」勾选文献库论文，写作时用 {'\\cite{refN}'} 引用（如 {'\\cite{ref1}'}）。
                  </Typography>
                ) : (
                  <List dense disablePadding sx={{ mt: 0.5 }}>
                    {refPapers.map((p, i) => (
                      <ListItem key={p.id} disableGutters dense sx={{ py: 0.25 }}>
                        <ListItemText
                          primary={
                            <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                              <b>[ref{i + 1}]</b> {latexToText(p.title) || p.title}
                            </Typography>
                          }
                          secondary={`${[...(p.authors ?? [])].slice(0, 3).join(', ')}${(p.authors ?? []).length > 3 ? ' 等' : ''}${p.year ? ` · ${p.year}` : ''}${p.venue ? ` · ${p.venue}` : ''}`}
                        />
                      </ListItem>
                    ))}
                  </List>
                )}
              </Box>
              <PromptEditor settingKey="promptOutline" label="生成大纲" hint="「生成大纲」使用的 AI 提示词" />
              <PromptEditor settingKey="promptSection" label="撰写小节" hint="「AI 撰写 / AI 重写」使用的 AI 提示词" />
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
              {(exportResult.path ?? current.exportedPath) && (
                  <Stack direction="row" spacing={2} sx={{ mb: 1, flexWrap: 'wrap' }}>
                    <Link
                      href={downloadUrlOf(exportResult.path ?? current.exportedPath) ?? '#'}
                      download={fileNameOf(exportResult.path ?? current.exportedPath)}
                      underline="hover"
                      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13 }}
                    >
                      <FileDownloadIcon sx={{ fontSize: 15 }} />
                      下载导出文件：{fileNameOf(exportResult.path ?? current.exportedPath)}
                    </Link>
                    {exportResult.bibPath && (
                      <Link
                        href={downloadUrlOf(exportResult.bibPath) ?? '#'}
                        download={fileNameOf(exportResult.bibPath)}
                        underline="hover"
                        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13 }}
                      >
                        <FileDownloadIcon sx={{ fontSize: 15 }} />
                        下载参考文献 refs.bib
                      </Link>
                    )}
                  </Stack>
                )}
              {outlineEditing ? (
                <Stack spacing={1} sx={{ mt: 1 }}>
                  {outlineDraft.map((o, i) => (
                    <Box key={i} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Chip size="small" label={`${i + 1}`} />
                        <TextField
                          size="small"
                          fullWidth
                          placeholder="小节标题"
                          value={o.heading}
                          onChange={(e) =>
                            setOutlineDraft((d) => d.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)))
                          }
                        />
                        <IconButton size="small" onClick={() => setOutlineDraft((d) => d.filter((_, j) => j !== i))}>
                          <DeleteOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Stack>
                      <TextField
                        size="small"
                        fullWidth
                        multiline
                        minRows={2}
                        placeholder="大纲说明（该节要写什么）"
                        value={o.description}
                        onChange={(e) =>
                          setOutlineDraft((d) => d.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))
                        }
                        sx={{ mt: 0.5 }}
                      />
                    </Box>
                  ))}
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<AddIcon />}
                    onClick={() => setOutlineDraft((d) => [...d, { heading: '', description: '' }])}
                  >
                    新增小节
                  </Button>
                  <Stack direction="row" spacing={1}>
                    <Button size="small" variant="contained" onClick={() => void saveOutline()}>
                      保存大纲
                    </Button>
                    <Button size="small" variant="outlined" onClick={() => setOutlineEditing(false)}>
                      取消
                    </Button>
                  </Stack>
                </Stack>
              ) : current.outline.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  尚未生成大纲。点击「生成大纲」后，逐节用 AI 撰写或手动编辑。
                </Typography>
              ) : (
                <Stack spacing={1.5} sx={{ mt: 1 }}>
                  {current.outline.map((item, i) => {
                    const section = current.sections[i];
                    // 并发撰写：每个小节独立判断自己的撰写状态，互不禁用
                    const writingThis = busy.sectionsWriting.includes(`${current.id}:${i}`);
                    const previewing = previewKeys.has(`${current.id}:${i}`);
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
                            variant={previewing ? 'contained' : 'outlined'}
                            color="secondary"
                            disabled={writingThis || (!section?.content && !localDrafts[`${current.id}:${i}`])}
                            onClick={() => togglePreview(`${current.id}:${i}`)}
                          >
                            {previewing ? '编辑' : '预览'}
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            color={instructions[`${current.id}:${i}`]?.trim() ? 'warning' : 'inherit'}
                            onClick={() =>
                              setInstructionOpen((prev) => {
                                const next = new Set(prev);
                                if (next.has(`${current.id}:${i}`)) next.delete(`${current.id}:${i}`);
                                else next.add(`${current.id}:${i}`);
                                return next;
                              })
                            }
                          >
                            {instructions[`${current.id}:${i}`]?.trim() ? '✍️ 修改建议' : '修改建议'}
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={writingThis ? <CircularProgress size={14} /> : <EditNoteIcon />}
                            disabled={writingThis}
                            onClick={() =>
                              void writeSection(
                                current.id,
                                i,
                                instructions[`${current.id}:${i}`]?.trim() || undefined,
                                (localDrafts[`${current.id}:${i}`] ?? section?.content ?? '').trim() || undefined,
                              )
                            }
                          >
                            {writingThis ? '撰写中…' : section?.content ? 'AI 重写' : 'AI 撰写'}
                          </Button>
                        </Stack>
                        {instructionOpen.has(`${current.id}:${i}`) && (
                          <TextField
                            size="small"
                            fullWidth
                            multiline
                            minRows={2}
                            placeholder="人工修改建议（AI 撰写/重写时会严格遵循），如：缩短一半、突出实验结果、补一段公式推导…"
                            value={instructions[`${current.id}:${i}`] ?? ''}
                            onChange={(e) =>
                              setInstructions((s) => ({ ...s, [`${current.id}:${i}`]: e.target.value }))
                            }
                            sx={{ mt: 0.5 }}
                          />
                        )}
                        {item.description && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            大纲说明：{latexToText(item.description) || item.description}
                          </Typography>
                        )}
                        {previewing ? (
                          <Box
                            component="div"
                            dangerouslySetInnerHTML={{
                              __html:
                                renderLatexHtml(localDrafts[`${current.id}:${i}`] ?? section?.content ?? '') ||
                                '<span style="color:#999">（空）</span>',
                            }}
                            sx={{
                              mt: 1,
                              border: '1px dashed',
                              borderColor: 'divider',
                              borderRadius: 1,
                              p: 1.5,
                              '& .katex-display': { overflowX: 'auto', overflowY: 'hidden' },
                            }}
                          />
                        ) : (
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
                        )}
                      </Box>
                    );
                  })}
                </Stack>
              )}
              {/* 参考文献管理对话框 */}
              <Dialog open={refDialogOpen} onClose={() => setRefDialogOpen(false)} fullWidth maxWidth="sm">
                <DialogTitle>管理参考文献</DialogTitle>
                <DialogContent>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                    勾选文献库论文作为参考；**勾选顺序即引用编号顺序**（第一勾的为 ref1，写作时用 {'\\cite{ref1}'} 引用）。
                  </Typography>
                  <TextField
                    size="small"
                    fullWidth
                    placeholder="搜索标题 / 作者 / 年份…"
                    value={refQuery}
                    onChange={(e) => setRefQuery(e.target.value)}
                    sx={{ mb: 1 }}
                  />
                  <List dense sx={{ maxHeight: 320, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                    {filterPapers(papers, refQuery).map((p) => {
                      const checked = refSelected.includes(p.id);
                      return (
                        <ListItemButton key={p.id} dense onClick={() => toggleRef(p.id)}>
                          <Checkbox size="small" checked={checked} onClick={(e) => e.stopPropagation()} onChange={() => toggleRef(p.id)} />
                          <ListItemText
                            primary={<Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{latexToText(p.title) || p.title}</Typography>}
                            secondary={`${[...(p.authors ?? [])].slice(0, 3).join(', ')}${p.year ? ` · ${p.year}` : ''}`}
                          />
                        </ListItemButton>
                      );
                    })}
                    {filterPapers(papers, refQuery).length === 0 && (
                      <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>
                        无匹配论文
                      </Typography>
                    )}
                  </List>
                  {refSelected.length > 0 && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                      当前编号：{refSelected.map((id, i) => `ref${i + 1}`).join('、')}
                    </Typography>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button size="small" onClick={() => setRefDialogOpen(false)}>取消</Button>
                  <Button size="small" variant="contained" onClick={() => void saveRefs()}>保存</Button>
                </DialogActions>
              </Dialog>
            </CardContent>
          </Card>
        )}
        {loading && <Typography variant="caption">加载中…</Typography>}
      </Box>
    </Box>
  );
}
