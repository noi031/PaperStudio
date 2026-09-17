// agent_sessions / agent_messages 仓储：AI 助手页的会话与消息持久化。
import { randomUUID } from 'node:crypto';
import type { Db } from './db';

export interface AgentSession {
  id: string;
  title: string;
  /** 会话标识：原 dsh 引擎会话 id，现作为 EchoCap sub-agent 的 context_path 种子
   *  （列名 dsh_session_id 保留，避免旧库迁移）。 */
  dshSessionId: string;
  contextJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  role: string;
  kind: string;
  content: string;
  createdAt: number;
}

interface SessionRow {
  id: string;
  title: string;
  dsh_session_id: string;
  context_json: string;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  kind: string;
  content: string;
  created_at: number;
}

function mapSession(r: SessionRow): AgentSession {
  return {
    id: r.id,
    title: r.title,
    dshSessionId: r.dsh_session_id,
    contextJson: r.context_json,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapMessage(r: MessageRow): AgentMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    kind: r.kind,
    content: r.content,
    createdAt: r.created_at,
  };
}

export class AgentRepo {
  constructor(private readonly db: Db) {}

  listSessions(): AgentSession[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC')
      .all() as SessionRow[];
    return rows.map(mapSession);
  }

  getSession(id: string): AgentSession | undefined {
    const r = this.db.raw.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return r ? mapSession(r) : undefined;
  }

  createSession(title: string, dshSessionId: string, contextJson: string): AgentSession {
    const now = Date.now();
    const id = randomUUID();
    this.db.raw
      .prepare(
        'INSERT INTO agent_sessions (id, title, dsh_session_id, context_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, title, dshSessionId, contextJson, now, now);
    return this.getSession(id)!;
  }

  renameSession(id: string, title: string): void {
    this.db.raw
      .prepare('UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), id);
  }

  /**
   * 代理宿主（重新）启动后调用：所有既有会话的 dshSessionId（sub-agent context 种子）已失效，
   * 新引擎用旧 id prompt 会命中持久化里的「已销毁 agent」→ 报错无回复。
   * 统一轮换为新 UUID，让下次 prompt 走「新建会话」路径。
   */
  rotateAllDshSessionIds(): void {
    const rows = this.db.raw.prepare('SELECT id FROM agent_sessions').all() as Array<{ id: string }>;
    const stmt = this.db.raw.prepare('UPDATE agent_sessions SET dsh_session_id = ?, updated_at = ? WHERE id = ?');
    for (const r of rows) stmt.run(randomUUID(), Date.now(), r.id);
  }

  /** 轮换单个会话的 dshSessionId（Esc 打断后：旧回合仍占着原 dsh 会话，换新 id 立即可回复）。 */
  rotateDshSessionId(id: string): void {
    this.db.raw
      .prepare('UPDATE agent_sessions SET dsh_session_id = ?, updated_at = ? WHERE id = ?')
      .run(randomUUID(), Date.now(), id);
  }

  touchSession(id: string): void {
    this.db.raw.prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  deleteSession(id: string): void {
    this.db.raw.prepare('DELETE FROM agent_sessions WHERE id = ?').run(id);
    this.db.raw.prepare('DELETE FROM agent_messages WHERE session_id = ?').run(id);
  }

  listMessages(sessionId: string): AgentMessage[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(sessionId) as MessageRow[];
    return rows.map(mapMessage);
  }

  appendMessage(sessionId: string, role: string, kind: string, content: string): AgentMessage {
    const id = randomUUID();
    const now = Date.now();
    this.db.raw
      .prepare('INSERT INTO agent_messages (id, session_id, role, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, role, kind, content, now);
    this.touchSession(sessionId);
    return { id, sessionId, role, kind, content, createdAt: now };
  }

  deleteMessages(sessionId: string): void {
    this.db.raw.prepare('DELETE FROM agent_messages WHERE session_id = ?').run(sessionId);
  }
}
