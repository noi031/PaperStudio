// SQLite 适配层：优先 better-sqlite3，不可用时回退 Node 内置 node:sqlite。
//
// 为什么需要它：
//  - Electron 桌面版一直用 better-sqlite3（原生模块，需与 Electron 的 V8 ABI 匹配）；
//  - Echo App Web 版跑在平台 Node 上，若版本与编译期不同，原生模块会直接加载失败；
//  - node:sqlite 自 Node 22.5 起内置，无原生依赖，可作为等价回退（同样支持 FTS5/WAL/事务）。
// 两者对外暴露同一套同步 API：prepare / exec / pragma / transaction / close，
// 因此 db.ts 与各 Repo 无需感知底层驱动。
export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(statement: string): void;
  /** 返回一个执行包裹函数：原 better-sqlite3 的用法 `db.transaction(fn)()`。 */
  transaction<T>(fn: () => T): () => T;
  close(): void;
  /** 实际生效的驱动（便于诊断与测试断言）。 */
  readonly driver: 'better-sqlite3' | 'node:sqlite';
}

type BetterSqliteCtor = new (filename: string) => {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(statement: string): unknown;
  transaction<T>(fn: () => T): () => T;
  close(): void;
};

function loadBetterSqlite(): BetterSqliteCtor | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('better-sqlite3') as BetterSqliteCtor | { default?: BetterSqliteCtor };
    const ctor = (typeof mod === 'function' ? mod : mod.default) as BetterSqliteCtor | undefined;
    if (!ctor) return null;
    // 构造一次探测：原生模块 ABI 不匹配时会在 new 阶段抛错。
    const probe = new ctor(':memory:');
    probe.close();
    return ctor;
  } catch {
    return null;
  }
}

interface NodeSqliteDb {
  prepare(sql: string): { run(...p: unknown[]): SqliteRunResult; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
  exec(sql: string): void;
  close(): void;
}

function openNodeSqlite(filename: string): SqliteDb {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (f: string) => NodeSqliteDb };
  const db = new DatabaseSync(filename);
  return {
    driver: 'node:sqlite',
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    pragma: (statement) => {
      db.exec(`PRAGMA ${statement}`);
    },
    transaction: <T,>(fn: () => T) => () => {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* 事务已回滚 */
        }
        throw err;
      }
    },
    close: () => db.close(),
  };
}

export function openSqlite(filename: string): SqliteDb {
  const BetterSqlite = loadBetterSqlite();
  if (BetterSqlite) {
    const db = new BetterSqlite(filename);
    return {
      driver: 'better-sqlite3',
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      pragma: (statement) => {
        db.pragma(statement);
      },
      transaction: <T,>(fn: () => T) => db.transaction(fn),
      close: () => db.close(),
    };
  }
  return openNodeSqlite(filename);
}
