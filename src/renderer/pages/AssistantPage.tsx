// AI 助手页：会话列表 + 消息流（流式/思考折叠/工具调用卡片）+ 输入与命令。
import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import PsychologyIcon from '@mui/icons-material/Psychology';
import SendIcon from '@mui/icons-material/Send';
import BuildIcon from '@mui/icons-material/Build';
import type { AgentMessageLite } from '../../shared/types';
import { useAssistantStore } from '../store/assistantStore';

function ReasoningCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ mb: 0.5 }}>
      <Chip
        icon={<PsychologyIcon />}
        label={open ? '收起思考' : '已思考（可展开）'}
        size="small"
        onClick={() => setOpen((v) => !v)}
        sx={{ cursor: 'pointer' }}
      />
      <Collapse in={open}>
        <Paper variant="outlined" sx={{ mt: 0.5, p: 1, bgcolor: 'grey.50', whiteSpace: 'pre-wrap', fontSize: 13 }}>
          {text}
        </Paper>
      </Collapse>
    </Box>
  );
}

function ToolCallCard({ name, args }: { name: string; args: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ mb: 0.5 }}>
      <Chip
        icon={<BuildIcon />}
        label={`工具调用：${name}`}
        size="small"
        onClick={() => setOpen((v) => !v)}
        sx={{ cursor: 'pointer' }}
      />
      <Collapse in={open}>
        <Paper variant="outlined" sx={{ mt: 0.5, p: 1, bgcolor: 'grey.50', fontFamily: 'monospace', fontSize: 12 }}>
          {args}
        </Paper>
      </Collapse>
    </Box>
  );
}

function MessageView({ m }: { m: AgentMessageLite }) {
  if (m.role === 'user') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1.5 }}>
        <Paper sx={{ maxWidth: '75%', p: 1.5, bgcolor: 'primary.main', color: 'white', borderRadius: 3 }}>
          <Typography sx={{ whiteSpace: 'pre-wrap' }}>{m.content}</Typography>
        </Paper>
      </Box>
    );
  }
  if (m.kind === 'reasoning') return <ReasoningCard text={m.content} />;
  if (m.kind === 'context')
    return (
      <Box sx={{ mb: 1 }}>
        <Chip size="small" color="secondary" label={`上下文已注入（${m.content.slice(0, 40)}…）`} />
      </Box>
    );
  if (m.kind === 'error')
    return (
      <Paper variant="outlined" color="error" sx={{ p: 1.5, mb: 1, bgcolor: 'error.light', color: 'error.contrastText' }}>
        <Typography sx={{ whiteSpace: 'pre-wrap' }}>{m.content}</Typography>
      </Paper>
    );
  return (
    <Box sx={{ display: 'flex', mb: 1.5 }}>
      <Paper sx={{ maxWidth: '85%', p: 1.5, bgcolor: 'background.paper', borderRadius: 3 }}>
        <Typography sx={{ whiteSpace: 'pre-wrap' }}>{m.content}</Typography>
      </Paper>
    </Box>
  );
}

export function AssistantPage() {
  const store = useAssistantStore();
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const { currentId, sessions, messages, streaming, status, health, pendingQuotes, error } = store;

  // 挂载：健康检查 + 会话列表 + 事件订阅。
  useEffect(() => {
    void store.loadHealth();
    void store.loadSessions();
    const off = window.paper.onAgentEvent((payload) => store.handleAgentEvent(payload));
    // 全局 Esc 打断正在生成的回复
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const st = useAssistantStore.getState();
        if (st.currentId && (st.status[st.currentId] ?? 'idle') === 'running') {
          void st.stop();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 来自其他页面的「发送到助手」引用块：确保存在会话（引用块待发送，可继续追加问题）。
  useEffect(() => {
    if (pendingQuotes.length > 0 && !currentId) {
      const q = pendingQuotes[0];
      void store.createSession(`来自${q.source}`, '').then(() => {
        // 不自动发送：用户可在输入框继续补充问题后一次性发出（引用块由 send() 合并）。
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuotes, currentId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages[currentId ?? ''], streaming[currentId ?? ''], currentId]);

  const send = () => {
    const text = input.trim();
    if ((!text && pendingQuotes.length === 0) || !currentId) return;
    // 引用块 + 用户追加的问题合并成一条消息一次性发出。
    const quoteText = pendingQuotes
      .map((q) => `@${q.source}（第 ${q.page} 页）：\n${q.text}`)
      .join('\n\n---\n\n');
    const combined = quoteText ? (text ? `${quoteText}\n\n${text}` : quoteText) : text;
    setInput('');
    void store.send(combined);
  };

  const curMessages = currentId ? (messages[currentId] ?? []) : [];
  const curStream = currentId ? (streaming[currentId] ?? { text: '', reasoning: '', toolName: null, toolArgs: '' }) : null;
  const curStatus = currentId ? (status[currentId] ?? 'idle') : 'idle';
  const isRunning = curStatus === 'running';

  return (
    <Box sx={{ display: 'flex', height: 'calc(100vh - 112px)', gap: 2 }}>
      {/* 左：会话列表 */}
      <Paper variant="outlined" sx={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ p: 1 }}>
          <Button
            fullWidth
            startIcon={<AddIcon />}
            variant="contained"
            onClick={() => void store.createSession()}
          >
            新建会话
          </Button>
        </Box>
        <Divider />
        <List dense sx={{ flexGrow: 1, overflow: 'auto' }}>
          {sessions.map((s) => (
            <ListItem
              key={s.id}
              disablePadding
              secondaryAction={
                <IconButton
                  edge="end"
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    void store.deleteSession(s.id);
                  }}
                >
                  <DeleteOutlinedIcon fontSize="small" />
                </IconButton>
              }
            >
              <ListItemButton
                selected={s.id === currentId}
                onClick={() => store.selectSession(s.id)}
              >
                <ListItemText primary={s.title} slotProps={{ primary: { noWrap: true, sx: { fontSize: 13 } } }} />
              </ListItemButton>
            </ListItem>
          ))}
          {sessions.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              暂无会话
            </Typography>
          )}
        </List>
        <Divider />
        <Box sx={{ p: 1 }}>
          {health === null ? (
            <Chip size="small" color="default" label="启动中…" />
          ) : health.ok ? (
            <Chip size="small" color="success" label={`dsh ${health.version ?? ''}`} />
          ) : (
            <Chip size="small" color="warning" label={health.message ?? 'dsh 未启动'} />
          )}
        </Box>
      </Paper>

      {/* 右：消息流 + 输入 */}
      <Paper variant="outlined" sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Box ref={listRef} sx={{ flexGrow: 1, overflow: 'auto', p: 2 }}>
          {error && (
            <Paper variant="outlined" color="error" sx={{ p: 1.5, mb: 1.5, bgcolor: 'error.light', color: 'error.contrastText' }}>
              <Typography variant="body2">{error}——请在「设置」页配置 LLM API Key 后重试。</Typography>
            </Paper>
          )}
          {!currentId && (
            <Box sx={{ textAlign: 'center', mt: 8, color: 'text.secondary' }}>
              <AutoAwesomeIcon sx={{ fontSize: 48 }} />
              <Typography variant="h6" sx={{ mt: 1 }}>
                PaperStudio AI 助手
              </Typography>
              <Typography variant="body2">
                基于 deepseek-harness（dsh）的论文工作台助手。从其他页面「发送到助手」会自动携带论文上下文。
              </Typography>
            </Box>
          )}
          {curMessages.map((m) => (
            <MessageView key={m.id} m={m} />
          ))}
          {curStream && (curStream.text || curStream.reasoning || curStream.toolName) && (
            <Box>
              {curStream.reasoning && <ReasoningCard text={curStream.reasoning} />}
              {curStream.toolName && <ToolCallCard name={curStream.toolName} args={curStream.toolArgs} />}
              {curStream.text && (
                <Box sx={{ display: 'flex', mb: 1.5 }}>
                  <Paper sx={{ maxWidth: '85%', p: 1.5, bgcolor: 'background.paper', borderRadius: 3 }}>
                    <Typography sx={{ whiteSpace: 'pre-wrap' }}>{curStream.text}</Typography>
                  </Paper>
                </Box>
              )}
            </Box>
          )}
          {isRunning && <Chip size="small" label="正在思考…" sx={{ mb: 1 }} />}
        </Box>
        <Divider />
        <Box sx={{ p: 1.5 }}>
          {pendingQuotes.length > 0 && (
            <Box sx={{ mb: 1 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                📌 已引用 {pendingQuotes.length} 处，可继续输入问题后一并发送：
              </Typography>
              <Stack spacing={0.5}>
                {pendingQuotes.map((q) => (
                  <Paper key={q.id} variant="outlined" sx={{ p: 1, bgcolor: 'info.light' }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                        <Typography variant="caption" color="primary" sx={{ fontWeight: 600 }}>
                          @{q.source}（第 {q.page} 页）
                        </Typography>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                          {q.text.slice(0, 200)}{q.text.length > 200 ? '…' : ''}
                        </Typography>
                      </Box>
                      <IconButton size="small" onClick={() => store.removeQuote(q.id)}>
                        <DeleteOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            </Box>
          )}
          <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
            <Button size="small" variant="outlined" onClick={() => void store.createSession()}>
              新对话
            </Button>
            <Tooltip title="P2 MVP：/compact 尚未接通 dsh 压缩后端，先提供「归档当前并新开」">
              <Button size="small" variant="outlined" onClick={() => void store.createSession()}>
                压缩并新开
              </Button>
            </Tooltip>
            <Tooltip title="P2 MVP：/resume 尚未接通，先提供「继续当前会话」（即普通发送）">
              <Button size="small" variant="outlined" disabled={!currentId} onClick={() => void store.selectSession(currentId!)}>
                继续
              </Button>
            </Tooltip>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <TextField
              fullWidth
              size="small"
              multiline
              maxRows={6}
              placeholder={
                isRunning
                  ? 'dsh 引擎正在处理…（按 Esc 可打断）'
                  : pendingQuotes.length > 0
                    ? '继续输入你的问题，与引用一起发送（Enter 发送，Shift+Enter 换行）…'
                    : '输入消息，或 /new 新会话 /resume 继续 /compact 压缩'
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
                if (e.key === 'Escape' && isRunning) {
                  void store.stop();
                }
              }}
              disabled={isRunning || !currentId}
            />
            <IconButton color="primary" onClick={send} disabled={isRunning || !currentId || (!input.trim() && pendingQuotes.length === 0)}>
              <SendIcon />
            </IconButton>
          </Stack>
        </Box>
      </Paper>
    </Box>
  );
}
