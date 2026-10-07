import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                        TEXT PRIMARY KEY,
  username                  TEXT NOT NULL UNIQUE,
  is_admin                  INTEGER NOT NULL DEFAULT 0,
  kdf_salt                  TEXT NOT NULL,
  kdf_params                TEXT NOT NULL,
  auth_salt                 TEXT NOT NULL,
  auth_hash                 TEXT NOT NULL,
  wrapped_user_key          TEXT NOT NULL,
  recovery_salt             TEXT NOT NULL,
  recovery_hash             TEXT NOT NULL,
  wrapped_user_key_recovery TEXT NOT NULL,
  created_at                TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS vaults (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enc_meta    TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vaults_user ON vaults(user_id);

-- Deleting a folder cascades to its subfolders and their notes.
CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
  enc_meta   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS folders_vault ON folders(vault_id);
CREATE INDEX IF NOT EXISTS folders_parent ON folders(parent_id);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  folder_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
  enc_meta   TEXT NOT NULL,
  enc_body   TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_vault ON notes(vault_id, updated_at);
CREATE INDEX IF NOT EXISTS notes_folder ON notes(folder_id);

CREATE TABLE IF NOT EXISTS note_vectors (
  note_id           TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  vault_id          TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  model             TEXT NOT NULL,
  enc_vec           TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_vectors_vault ON note_vectors(vault_id);
`;

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  db.exec('PRAGMA user_version = 1');
  return db;
}

/** Runs fn inside a write transaction; rolls back if it throws. fn must be synchronous. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = (): string => new Date().toISOString();

/**
 * Next updated_at for a row: never equal to or before the previous value, so
 * optimistic-concurrency checks still work for two writes in the same millisecond.
 */
export function bumpTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

// Row shapes as stored.
export interface UserRow {
  id: string;
  username: string;
  is_admin: number;
  kdf_salt: string;
  kdf_params: string;
  auth_salt: string;
  auth_hash: string;
  wrapped_user_key: string;
  recovery_salt: string;
  recovery_hash: string;
  wrapped_user_key_recovery: string;
  created_at: string;
}

export interface VaultRow {
  id: string;
  user_id: string;
  enc_meta: string;
  wrapped_key: string;
  created_at: string;
  updated_at: string;
}

export interface FolderRow {
  id: string;
  vault_id: string;
  parent_id: string | null;
  enc_meta: string;
  created_at: string;
  updated_at: string;
}

export interface NoteRow {
  id: string;
  vault_id: string;
  folder_id: string | null;
  enc_meta: string;
  enc_body: string;
  size: number;
  created_at: string;
  updated_at: string;
}

export interface NoteVectorRow {
  note_id: string;
  vault_id: string;
  model: string;
  enc_vec: string;
  source_updated_at: string;
  updated_at: string;
}
