// 设置页：读/写 settings（IPC）。LLM 端点/key 不读 EchoAgent/.env，由用户填写。
import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Divider from '@mui/material/Divider';
import type { PaperSettings } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/types';

/** 提示词编辑项：key、显示名、说明。 */
const PROMPT_FIELDS: Array<{ key: 'promptSummarySelected' | 'promptSummaryFull' | 'promptDirections' | 'promptSlides' | 'promptOutline' | 'promptSection'; label: string }> = [
  { key: 'promptSummarySelected', label: '总结选中段落' },
  { key: 'promptSummaryFull', label: '总结全文' },
  { key: 'promptDirections', label: '生成方向建议' },
  { key: 'promptSlides', label: '生成 PPT' },
  { key: 'promptOutline', label: '写作·生成大纲' },
  { key: 'promptSection', label: '写作·撰写小节' },
];

export function SettingsPage() {
  const [s, setS] = useState<PaperSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.paper.invoke('settings:get').then((r) => setS(r as PaperSettings));
  }, []);

  if (!s) return <Typography>加载中…</Typography>;

  const set = (k: keyof PaperSettings) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setS({ ...s, [k]: e.target.value });
    setSaved(false);
  };

  const save = async () => {
    await window.paper.invoke('settings:save', s);
    setSaved(true);
  };

  return (
    <Box sx={{ maxWidth: 640, p: 2 }}>
      <Typography variant="h5" gutterBottom>
        设置
      </Typography>
      {saved && <Alert severity="success" sx={{ mb: 2 }}>已保存</Alert>}
      <Stack spacing={2}>
        <TextField label="用户名" value={s.username} onChange={set('username')} />
        <TextField label="LLM 端点 (OpenAI 兼容 baseURL)" value={s.llmBaseUrl} onChange={set('llmBaseUrl')} />
        <TextField label="LLM API Key" type="password" value={s.llmApiKey} onChange={set('llmApiKey')} />
        <TextField label="模型名" value={s.llmModel} onChange={set('llmModel')} />
        <TextField
          label="上下文窗口"
          type="number"
          value={s.llmContextWindow}
          onChange={(e) => setS({ ...s, llmContextWindow: Number(e.target.value) })}
        />
        <TextField
          label="存储目录（留空=PaperStudio/storage/papers，数据不落 C 盘）"
          value={s.storageDir}
          onChange={set('storageDir')}
        />
        <TextField
          label="Semantic Scholar API Key（可选）"
          type="password"
          value={s.semanticScholarApiKey}
          onChange={set('semanticScholarApiKey')}
          helperText="检索页无 key 时 Semantic Scholar 限流很严（常报 429）；填 key（https://www.semanticscholar.org/product/api#api-key-form）可大幅提高额度"
        />
        <TextField
          label="EchoMem 端点（可选）"
          value={s.echoMemEndpoint}
          onChange={set('echoMemEndpoint')}
          helperText="EchoMem 记忆接入在 P8 生效"
        />
      </Stack>

      <Divider sx={{ my: 3 }} />
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
        <Typography variant="h6" sx={{ fontSize: 16 }}>
          提示词（可编辑）
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Button
          size="small"
          variant="outlined"
          onClick={() => {
            setS((prev) => {
              if (!prev) return prev;
              const next = { ...prev };
              for (const f of PROMPT_FIELDS) next[f.key] = DEFAULT_SETTINGS[f.key];
              return next;
            });
            setSaved(false);
          }}
        >
          恢复默认
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        以下提示词为「总结全文 / 总结选中段落 / 方向建议 / PPT / 写作大纲 / 撰写小节」使用的 system 提示词，留空则使用内置默认，修改后需保存生效。
      </Typography>
      <Stack spacing={2}>
        {PROMPT_FIELDS.map((f) => (
          <TextField
            key={f.key}
            label={f.label}
            multiline
            minRows={3}
            maxRows={8}
            value={s[f.key]}
            onChange={(e) => {
              setS({ ...s, [f.key]: e.target.value });
              setSaved(false);
            }}
          />
        ))}
      </Stack>
      <Box sx={{ mt: 2 }}>
        <Button variant="contained" onClick={() => void save()}>
          保存全部设置
        </Button>
      </Box>
    </Box>
  );
}
