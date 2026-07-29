import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { debounceWithMaxWait } from '../util/async.js';
import { ensureDir, writeFileAtomic } from '../util/fs.js';

const require = createRequire(import.meta.url);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Index over agents of every known board, including closed ones, so a room
-- can address an agent whose project is not currently open. The board folder
-- stays the source of truth; this is a cache.
CREATE TABLE IF NOT EXISTS agent_index (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT NOT NULL,
  home_board_id TEXT NOT NULL,
  board_path TEXT NOT NULL,
  board_name TEXT NOT NULL DEFAULT '',
  avatar_color TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);

-- Search uses a lowercased copy of the body rather than FTS5: the sql.js WASM
-- build ships without the FTS5 extension, and at chat volume a LIKE scan over
-- this column is not worth a native dependency to avoid.
CREATE TABLE IF NOT EXISTS message_search (
  message_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  body_lower TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_search_room ON message_search(room_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  coalesce_key TEXT NOT NULL DEFAULT '',
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

-- Durable per-agent queue. Survives a restart so a mention is never lost
-- because the app closed between the message and the agent's next turn.
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_agent ON inbox(agent_id, delivered, created_at);
`;

export type Row = Record<string, unknown>;

/**
 * App-level store. Rooms, the agent directory and notifications cross project
 * boundaries, so they cannot live inside any one board folder.
 *
 * Backed by sql.js (SQLite compiled to WebAssembly) rather than a native
 * binding: it keeps `pnpm install` free of a C++ toolchain on every machine,
 * and at our data volume the whole database is a few megabytes.
 */
export class AppDatabase {
  private saver: ReturnType<typeof debounceWithMaxWait>;

  private constructor(
    private readonly db: Database,
    readonly file: string
  ) {
    this.saver = debounceWithMaxWait(() => this.persist(), 500, 4000);
  }

  static async open(file: string): Promise<AppDatabase> {
    const SQL: SqlJsStatic = await initSqlJs({
      locateFile: (name) => require.resolve(`sql.js/dist/${name}`)
    });
    await ensureDir(path.dirname(file));
    let db: Database;
    try {
      const bytes = await fs.readFile(file);
      db = new SQL.Database(bytes);
    } catch {
      db = new SQL.Database();
    }
    db.run(SCHEMA);
    return new AppDatabase(db, file);
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as never);
    this.saver.schedule();
  }

  all<T extends Row = Row>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as never);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      return out;
    } finally {
      stmt.free();
    }
  }

  get<T extends Row = Row>(sql: string, params: unknown[] = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  getKv<T>(key: string, fallback: T): T {
    const row = this.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key]);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  setKv(key: string, value: unknown): void {
    this.run('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      key,
      JSON.stringify(value)
    ]);
  }

  private async persist(): Promise<void> {
    const data = this.db.export();
    await writeFileAtomic(this.file, data);
  }

  async flush(): Promise<void> {
    await this.saver.flush();
  }

  async close(): Promise<void> {
    await this.saver.flush();
    this.db.close();
  }
}
