// 方向建议页（P5）：勾选文献 → 生成研究方向（LLM）→ 落库展示。
import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { useLibraryStore } from '../store/libraryStore';
import { useDirectionsStore } from '../store/directionsStore';
import { PromptEditor } from '../components/PromptEditor';
import { latexToText } from '../../shared/latex';

export function DirectionsPage() {
  const { papers, loadPapers } = useLibraryStore();
  const { records, loading, generating, error, load, generate, remove } = useDirectionsStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadPapers();
    void load();
  }, [loadPapers, load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleGenerate = () => {
    void generate([...selected]);
  };

  const selectAll = () => setSelected(new Set(papers.map((p) => p.id)));

  return (
    <Box sx={{ p: 2, maxWidth: 1100 }}>
      <Typography variant="h5" gutterBottom>
        方向建议
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        勾选文献库中的论文，AI 基于这些论文生成可落地的研究方向建议。
      </Typography>

      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            选择论文（{selected.size}/{papers.length}）
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap', gap: 0.5 }}>
            <Button size="small" variant="outlined" onClick={selectAll}>
              全选
            </Button>
            <Button size="small" variant="outlined" onClick={() => setSelected(new Set())}>
              清空
            </Button>
          </Stack>
          {papers.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              文献库为空，请先到「检索」页搜索并保存论文。
            </Typography>
          ) : (
            <Stack spacing={0.5}>
              {papers.map((p) => (
                <FormControlLabel
                  key={p.id}
                  control={<Checkbox size="small" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />}
                  label={
                    <Typography variant="body2" sx={{ maxWidth: 900, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {latexToText(p.title) || p.title}
                    </Typography>
                  }
                />
              ))}
            </Stack>
          )}
          <Stack direction="row" spacing={1} sx={{ mt: 1.5, alignItems: 'center' }}>
            <Button
              variant="contained"
              startIcon={<AutoAwesomeIcon />}
              disabled={generating || papers.length === 0}
              onClick={handleGenerate}
            >
              {generating ? '生成中…' : '生成方向建议'}
            </Button>
            {generating && <CircularProgress size={20} />}
          </Stack>
          <PromptEditor settingKey="promptDirections" label="生成方向建议" hint="「生成方向建议」使用的 AI 提示词" />
          {error && <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>}
        </CardContent>
      </Card>

      {loading && <LinearProgress />}
      {!loading && records.length === 0 && (
        <Typography color="text.secondary" sx={{ mt: 2 }}>
          还没有方向建议，选择论文后点击「生成方向建议」。
        </Typography>
      )}
      <Stack spacing={2} sx={{ mt: 2 }}>
        {records.map((r) => (
          <Card key={r.id} variant="outlined">
            <CardContent>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
                <Chip size="small" label={`${new Date(r.createdAt).toLocaleString()}`} variant="outlined" />
                <Chip size="small" label={`基于 ${r.context.split('\n').filter(Boolean).length} 篇论文`} />
                <Box sx={{ flexGrow: 1 }} />
                <IconButton size="small" onClick={() => void remove(r.id)}>
                  <DeleteOutlinedIcon fontSize="small" />
                </IconButton>
              </Stack>
              {r.context.split('\n').filter(Boolean).length > 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1, whiteSpace: 'pre-wrap' }}>
                  上下文：{r.context}
                </Typography>
              )}
              <Divider sx={{ mb: 1 }} />
              <Stack spacing={1.5}>
                {r.suggestions.map((s, i) => (
                  <Box key={i} sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                    <Typography variant="subtitle2">
                      {i + 1}. {s.title}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>
                      {s.description}
                    </Typography>
                    {s.nextSteps.length > 0 && (
                      <Box sx={{ mt: 0.5 }}>
                        <Typography variant="caption" color="text.secondary">
                          下一步：
                        </Typography>
                        {s.nextSteps.map((n, j) => (
                          <Typography key={j} variant="body2" sx={{ pl: 2 }}>
                            • {n}
                          </Typography>
                        ))}
                      </Box>
                    )}
                  </Box>
                ))}
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>
    </Box>
  );
}
