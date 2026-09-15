// 提示词编辑器（折叠面板）：显示 + 编辑某个 AI 功能的 system 提示词，保存到 settings。
// 用于所有「点按钮 → AI 自动生成」的功能旁：总结、方向、PPT、写作大纲/小节。
// 保存后立即写入 settings，下次生成即用新提示词（服务端读 settings）。
import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import type { PaperSettings } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/types';

type PromptKey =
  | 'promptSummarySelected'
  | 'promptSummaryFull'
  | 'promptDirections'
  | 'promptSlides'
  | 'promptOutline'
  | 'promptSection';

export function PromptEditor({
  settingKey,
  label,
  hint,
}: {
  settingKey: PromptKey;
  label: string;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [ref, setRef] = useState<PaperSettings | null>(null);
  const isDefault = ref !== null && draft === (DEFAULT_SETTINGS[settingKey] ?? '');

  // 打开时拉取当前 settings 值
  useEffect(() => {
    if (!open || loaded) return;
    void window.paper.invoke('settings:get').then((r) => {
      const s = r as PaperSettings;
      setRef(s);
      setDraft(s[settingKey] ?? '');
      setLoaded(true);
      setFeedback(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loaded]);

  const save = async () => {
    await window.paper.invoke('settings:save', { [settingKey]: draft.trim() });
    setFeedback(`已保存「${label}」提示词，下次生成生效（留空 = 用默认）。`);
  };

  return (
    <Box sx={{ mt: 1 }}>
      <Tooltip title={hint ?? `修改「${label}」使用的 AI 提示词`}>
        <Button
          size="small"
          sx={{ fontSize: 11, textTransform: 'none', color: 'text.secondary' }}
          startIcon={<ExpandMoreIcon sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />}
          onClick={() => setOpen((v) => !v)}
        >
          提示词{ref ? (isDefault ? '' : '（已自定义）') : ''}
        </Button>
      </Tooltip>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ mt: 0.5, p: 1, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            {label}（发送给 AI 的 system 提示词）
          </Typography>
          <TextField
            size="small"
            fullWidth
            multiline
            minRows={3}
            maxRows={10}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setFeedback(null);
            }}
            placeholder="留空 = 使用内置默认提示词"
          />
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button size="small" variant="contained" onClick={() => void save()}>
              保存
            </Button>
            {!isDefault && (
              <Button
                size="small"
                variant="outlined"
                onClick={() => {
                  setDraft(DEFAULT_SETTINGS[settingKey] ?? '');
                  setFeedback('已恢复为默认（保存后生效）。');
                }}
              >
                恢复默认
              </Button>
            )}
          </Stack>
          {feedback && (
            <Alert severity="success" sx={{ mt: 1, py: 0, '& .MuiAlert-message': { py: 0.5 } }}>
              <Typography variant="caption">{feedback}</Typography>
            </Alert>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}