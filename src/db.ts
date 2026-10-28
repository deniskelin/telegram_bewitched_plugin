/**
 * SQLite store: message history (+FTS), topic registry, answer-button
 * questions, messages waiting for an offline session, small key/value state.
 */

import { Database } from 'bun:sqlite'
import { chmodSync } from 'fs'

export type Direction = 'in' | 'out'

export type MessageRow = {
  id: number
  chat_id: string
  thread_id: number | null
  message_id: number
  direction: Direction
  from_id: string | null
  from_name: string | null
  date: number
  text: string
  kind: string
  file_id: string | null
  reply_to: number | null
  quote: string | null
  forward: string | null
}

export type TopicRow = {
  chat_id: string
  thread_id: number
  name: string
  kind: 'project' | 'session' | 'manual'
  project_key: string | null
  status: 'active' | 'archived'
  created_at: number
  last_activity_at: number
}

export type QuestionRow = {
  id: string
  chat_id: string
  thread_id: number | null
  message_id: number | null
  text: string
  options: string
  multi: number
  chosen: string
  project_key: string | null
  session_id: string | null
  created_at: number
  expires_at: number | null
  closed: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  thread_id INTEGER,
  message_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  from_id TEXT,
  from_name TEXT,
  date INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'text',
  file_id TEXT,
  reply_to INTEGER,
  quote TEXT,
  forward TEXT,
  UNIQUE (chat_id, message_id, direction)
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, thread_id, date);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (text, content='messages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS topics (
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_key TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, thread_id)
);
CREATE INDEX IF NOT EXISTS topics_project ON topics (chat_id, project_key);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  thread_id INTEGER,
  message_id INTEGER,
  text TEXT NOT NULL,
  options TEXT NOT NULL,
  multi INTEGER NOT NULL DEFAULT 0,
  chosen TEXT NOT NULL DEFAULT '[]',
  project_key TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  closed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pending (
  id INTEGER PRIMARY KEY,
  project_key TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export class Store {
  readonly db: Database

  constructor(file: string) {
    this.db = new Database(file, { create: true })
    if (file !== ':memory:') {
      try {
        chmodSync(file, 0o600)
      } catch {}
    }
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;')
    this.db.exec(SCHEMA)
  }

  // --- kv ---

  get(key: string): string | null {
    const r = this.db.query<{ value: string }, [string]>('SELECT value FROM kv WHERE key = ?').get(key)
    return r?.value ?? null
  }

  set(key: string, value: string | null): void {
    if (value == null) this.db.query('DELETE FROM kv WHERE key = ?').run(key)
    else this.db.query('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  keys(prefix: string): string[] {
    return this.db.query<{ key: string }, [string]>("SELECT key FROM kv WHERE key LIKE ? || '%'").all(prefix).map(r => r.key)
  }

  // --- messages ---

  addMessage(m: Omit<MessageRow, 'id'>): void {
    this.db.query(`INSERT OR IGNORE INTO messages
      (chat_id, thread_id, message_id, direction, from_id, from_name, date, text, kind, file_id, reply_to, quote, forward)
      VALUES ($chat_id, $thread_id, $message_id, $direction, $from_id, $from_name, $date, $text, $kind, $file_id, $reply_to, $quote, $forward)`)
      .run({
        $chat_id: m.chat_id, $thread_id: m.thread_id, $message_id: m.message_id, $direction: m.direction,
        $from_id: m.from_id, $from_name: m.from_name, $date: m.date, $text: m.text, $kind: m.kind,
        $file_id: m.file_id, $reply_to: m.reply_to, $quote: m.quote, $forward: m.forward,
      })
  }

  updateMessageText(chatId: string, messageId: number, text: string): void {
    this.db.query('UPDATE messages SET text = ? WHERE chat_id = ? AND message_id = ?').run(text, chatId, messageId)
  }

  getMessage(chatId: string, messageId: number): MessageRow | null {
    return this.db.query<MessageRow, [string, number]>('SELECT * FROM messages WHERE chat_id = ? AND message_id = ? ORDER BY direction LIMIT 1').get(chatId, messageId)
  }

  history(chatId: string, threadId: number | null, limit: number, beforeMessageId?: number): MessageRow[] {
    const rows = this.db.query<MessageRow, [string, number | null, number | null, number, number]>(`
      SELECT * FROM messages
      WHERE chat_id = ?1 AND (thread_id IS ?2 OR (?2 IS NULL AND thread_id IS NULL))
        AND (?3 IS NULL OR message_id < ?3)
      ORDER BY date DESC, id DESC LIMIT ?4 OFFSET ?5`).all(chatId, threadId, beforeMessageId ?? null, limit, 0)
    return rows.reverse()
  }

  search(query: string, limit: number, chatId?: string, threadId?: number | null): MessageRow[] {
    // FTS5 syntax errors on stray quotes/operators — quote each term.
    const fts = query.split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`).join(' ')
    if (!fts) return []
    return this.db.query<MessageRow, [string, string | null, number | null, number]>(`
      SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
      WHERE messages_fts MATCH ?1
        AND (?2 IS NULL OR m.chat_id = ?2)
        AND (?3 IS NULL OR m.thread_id = ?3)
      ORDER BY m.date DESC LIMIT ?4`).all(fts, chatId ?? null, threadId ?? null, limit)
  }

  forgetThread(chatId: string, threadId: number | null): number {
    return this.db.query('DELETE FROM messages WHERE chat_id = ?1 AND thread_id IS ?2').run(chatId, threadId).changes
  }

  pruneHistory(maxDays: number): void {
    if (maxDays <= 0) return
    this.db.query('DELETE FROM messages WHERE date < ?').run(Math.floor(Date.now() / 1000) - maxDays * 86400)
  }

  // --- topics ---

  upsertTopic(t: TopicRow): void {
    this.db.query(`INSERT INTO topics (chat_id, thread_id, name, kind, project_key, status, created_at, last_activity_at)
      VALUES ($chat_id, $thread_id, $name, $kind, $project_key, $status, $created_at, $last_activity_at)
      ON CONFLICT (chat_id, thread_id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
        project_key = COALESCE(excluded.project_key, topics.project_key), status = excluded.status,
        last_activity_at = excluded.last_activity_at`)
      .run({
        $chat_id: t.chat_id, $thread_id: t.thread_id, $name: t.name, $kind: t.kind, $project_key: t.project_key,
        $status: t.status, $created_at: t.created_at, $last_activity_at: t.last_activity_at,
      })
  }

  topic(chatId: string, threadId: number): TopicRow | null {
    return this.db.query<TopicRow, [string, number]>('SELECT * FROM topics WHERE chat_id = ? AND thread_id = ?').get(chatId, threadId)
  }

  topicForProject(chatId: string, projectKey: string): TopicRow | null {
    return this.db.query<TopicRow, [string, string]>(`SELECT * FROM topics WHERE chat_id = ? AND project_key = ?
      ORDER BY status = 'active' DESC, last_activity_at DESC LIMIT 1`).get(chatId, projectKey)
  }

  topicByName(chatId: string, name: string): TopicRow | null {
    const n = name.trim().replace(/^#/, '').toLowerCase()
    const all = this.topics(chatId)
    return all.find(t => t.name.toLowerCase() === n)
      ?? all.find(t => String(t.thread_id) === n)
      ?? all.find(t => t.name.toLowerCase().replace(/^🗄\s*/, '') === n)
      ?? null
  }

  topics(chatId: string): TopicRow[] {
    return this.db.query<TopicRow, [string]>('SELECT * FROM topics WHERE chat_id = ? ORDER BY status, last_activity_at DESC').all(chatId)
  }

  touchTopic(chatId: string, threadId: number): void {
    this.db.query('UPDATE topics SET last_activity_at = ? WHERE chat_id = ? AND thread_id = ?').run(Date.now(), chatId, threadId)
  }

  setTopicStatus(chatId: string, threadId: number, status: TopicRow['status'], name?: string): void {
    this.db.query('UPDATE topics SET status = ?, name = COALESCE(?, name) WHERE chat_id = ? AND thread_id = ?').run(status, name ?? null, chatId, threadId)
  }

  deleteTopic(chatId: string, threadId: number): void {
    this.db.query('DELETE FROM topics WHERE chat_id = ? AND thread_id = ?').run(chatId, threadId)
  }

  // --- questions ---

  addQuestion(q: QuestionRow): void {
    this.db.query(`INSERT INTO questions (id, chat_id, thread_id, message_id, text, options, multi, chosen, project_key, session_id, created_at, expires_at, closed)
      VALUES ($id, $chat_id, $thread_id, $message_id, $text, $options, $multi, $chosen, $project_key, $session_id, $created_at, $expires_at, $closed)`)
      .run({
        $id: q.id, $chat_id: q.chat_id, $thread_id: q.thread_id, $message_id: q.message_id, $text: q.text, $options: q.options,
        $multi: q.multi, $chosen: q.chosen, $project_key: q.project_key, $session_id: q.session_id,
        $created_at: q.created_at, $expires_at: q.expires_at, $closed: q.closed,
      })
  }

  question(id: string): QuestionRow | null {
    return this.db.query<QuestionRow, [string]>('SELECT * FROM questions WHERE id = ?').get(id)
  }

  questionByMessage(chatId: string, messageId: number): QuestionRow | null {
    return this.db.query<QuestionRow, [string, number]>('SELECT * FROM questions WHERE chat_id = ? AND message_id = ?').get(chatId, messageId)
  }

  updateQuestion(id: string, patch: Partial<Pick<QuestionRow, 'message_id' | 'chosen' | 'closed'>>): void {
    const q = this.question(id)
    if (!q) return
    this.db.query('UPDATE questions SET message_id = ?, chosen = ?, closed = ? WHERE id = ?')
      .run(patch.message_id ?? q.message_id, patch.chosen ?? q.chosen, patch.closed ?? q.closed, id)
  }

  expiredQuestions(now = Date.now()): QuestionRow[] {
    return this.db.query<QuestionRow, [number]>('SELECT * FROM questions WHERE closed = 0 AND expires_at IS NOT NULL AND expires_at < ?').all(now)
  }

  // --- pending (offline delivery) ---

  addPending(projectKey: string, content: string, meta: Record<string, string>): void {
    this.db.query('INSERT INTO pending (project_key, content, meta, created_at) VALUES (?, ?, ?, ?)').run(projectKey, content, JSON.stringify(meta), Date.now())
  }

  pendingCount(projectKey: string, ttlH: number): number {
    const cutoff = Date.now() - ttlH * 3600_000
    return this.db.query<{ n: number }, [string, number]>('SELECT COUNT(*) AS n FROM pending WHERE project_key = ? AND created_at >= ?').get(projectKey, cutoff)?.n ?? 0
  }

  takePending(projectKey: string, ttlH: number): { content: string; meta: Record<string, string>; created_at: number }[] {
    const cutoff = Date.now() - ttlH * 3600_000
    const rows = this.db.query<{ id: number; content: string; meta: string; created_at: number }, [string, number]>(
      'SELECT * FROM pending WHERE project_key = ? AND created_at >= ? ORDER BY id').all(projectKey, cutoff)
    this.db.query('DELETE FROM pending WHERE project_key = ? OR created_at < ?').run(projectKey, cutoff)
    return rows.map(r => ({ content: r.content, meta: JSON.parse(r.meta), created_at: r.created_at }))
  }

  close(): void {
    this.db.close()
  }
}
