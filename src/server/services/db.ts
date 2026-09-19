import { Database } from 'bun:sqlite'
import path from 'path'
import os from 'os'
import fs from 'fs'

const dataDir = path.join(os.homedir(), '.claude-agent')
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

const dbPath = path.join(dataDir, 'agent.sqlite')
export const db = new Database(dbPath)

// Initialize schema
db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    workDir TEXT NOT NULL,
    permissionMode TEXT DEFAULT 'ask',
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
`)

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    thinking TEXT,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE
  );
`)

export interface SessionRecord {
  id: string
  title: string | null
  workDir: string
  permissionMode: string
  createdAt: number
  updatedAt: number
}

export const sessionDb = {
  create(id: string, workDir: string, title = 'New Session', permissionMode = 'ask'): SessionRecord {
    const now = Date.now()
    const stmt = db.prepare(`
      INSERT INTO sessions (id, title, workDir, permissionMode, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    stmt.run(id, title, workDir, permissionMode, now, now)
    return { id, title, workDir, permissionMode, createdAt: now, updatedAt: now }
  },

  get(id: string): SessionRecord | null {
    const stmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`)
    return (stmt.get(id) as SessionRecord) || null
  },

  list(): SessionRecord[] {
    const stmt = db.prepare(`SELECT * FROM sessions ORDER BY updatedAt DESC`)
    return stmt.all() as SessionRecord[]
  },

  updateTitle(id: string, title: string): void {
    const stmt = db.prepare(`UPDATE sessions SET title = ?, updatedAt = ? WHERE id = ?`)
    stmt.run(title, Date.now(), id)
  },

  delete(id: string): void {
    const stmt = db.prepare(`DELETE FROM sessions WHERE id = ?`)
    stmt.run(id)
  }
}
