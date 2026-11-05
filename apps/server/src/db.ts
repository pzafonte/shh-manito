import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    auth_hash TEXT NOT NULL,
    reveal_at INTEGER NOT NULL,
    time_zone TEXT NOT NULL,
    mail_times TEXT NOT NULL,
    delete_at INTEGER NOT NULL,
    next_seq INTEGER NOT NULL DEFAULT 1,
    entry_count INTEGER NOT NULL DEFAULT 0,
    byte_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS entries (
    round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('group', 'sealed')),
    body BLOB NOT NULL,
    visible_at INTEGER,
    PRIMARY KEY (round_id, seq)
  ) WITHOUT ROWID;

  -- A held entry has no sequence number until the postman comes. Nothing here
  -- records when it was posted, so send time cannot be read back later.
  CREATE TABLE IF NOT EXISTS held (
    id INTEGER PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    body BLOB NOT NULL,
    visible_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS held_due ON held (round_id, visible_at);

  CREATE TABLE IF NOT EXISTS backups (
    handle TEXT PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    blob BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS backups_round ON backups (round_id);
`;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Deleted rounds are overwritten rather than left in free pages.
  db.pragma('secure_delete = ON');
  db.exec(SCHEMA);
  return db;
}
