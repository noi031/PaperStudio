// 设置页：读/写 settings（IPC）。LLM 端点/key 不读 EchoAgent/.env，由用户填写。
import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import type { PaperSettings } from '../../shared/types';

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
          label="EchoMem 端点（可选）"
          value={s.echoMemEndpoint}
          onChange={set('echoMemEndpoint')}
          helperText="EchoMem 记忆接入在 P8 生效"
        />
        <Button variant="contained" onClick={() => void save()}>
          保存
        </Button>
      </Stack>
    </Box>
  );
}
