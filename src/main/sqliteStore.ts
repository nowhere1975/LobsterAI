import { app } from 'electron';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { DB_FILENAME } from './appConstants';

type ChangePayload<T = unknown> = {
  key: string;
  newValue: T | undefined;
  oldValue: T | undefined;
};

const USER_MEMORIES_MIGRATION_KEY = 'userMemories.migration.v1.completed';

// Pre-read the sql.js WASM binary from disk.
// Using fs.readFileSync (which handles non-ASCII paths via Windows wide-char APIs)
// and passing the buffer directly to initSqlJs bypasses Emscripten's file loading,
// which can fail or hang when the install path contains Chinese characters on Windows.
function loadWasmBinary(): ArrayBuffer {
  const wasmPath = app.isPackaged
    ? path.join(
        process.resourcesPath,
        'app.asar.unpacked/node_modules/sql.js/dist/sql-wasm.wasm'
      )
    : path.join(app.getAppPath(), 'node_modules/sql.js/dist/sql-wasm.wasm');
  const buf = fs.readFileSync(wasmPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export class SqliteStore {
  private db: Database;
  private dbPath: string;
  private emitter = new EventEmitter();
  private static sqlPromise: Promise<SqlJsStatic> | null = null;

  private constructor(db: Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(userDataPath?: string): Promise<SqliteStore> {
    const basePath = userDataPath ?? app.getPath('userData');
    const dbPath = path.join(basePath, DB_FILENAME);

    // Initialize SQL.js with WASM file path (cached promise for reuse)
    if (!SqliteStore.sqlPromise) {
      const wasmBinary = loadWasmBinary();
      SqliteStore.sqlPromise = initSqlJs({
        wasmBinary,
      });
    }
    const SQL = await SqliteStore.sqlPromise;

    // Load existing database or create new one
    let db: Database;
    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    const store = new SqliteStore(db, dbPath);
    store.initializeTables(basePath);
    return store;
  }

  private initializeTables(basePath: string) {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Create cowork tables
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        pinned INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        execution_mode TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cowork_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        sequence INTEGER,
        FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_id ON cowork_messages(session_id);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cowork_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.75,
        is_explicit INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'created',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_memory_sources (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        session_id TEXT,
        message_id TEXT,
        role TEXT NOT NULL DEFAULT 'system',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES user_memories(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_memories_status_updated_at
      ON user_memories(status, updated_at DESC);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_memories_fingerprint
      ON user_memories(fingerprint);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_memory_sources_session_id
      ON user_memory_sources(session_id, is_active);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_memory_sources_memory_id
      ON user_memory_sources(memory_id, is_active);
    `);

    // Create MCP servers table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS kb_folders (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        path       TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS kb_docs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_id   INTEGER NOT NULL REFERENCES kb_folders(id),
        file_path   TEXT NOT NULL UNIQUE,
        file_hash   TEXT,
        status      TEXT NOT NULL DEFAULT 'pending',
        error_msg   TEXT,
        chunk_count INTEGER,
        updated_at  INTEGER
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_kb_docs_folder_id ON kb_docs(folder_id);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_kb_docs_file_path ON kb_docs(file_path);
    `);

    // Migrations - safely add columns if they don't exist
    try {
      // Check if execution_mode column exists
      const colsResult = this.db.exec("PRAGMA table_info(cowork_sessions);");
      const columns = colsResult[0]?.values.map((row) => row[1]) || [];

      if (!columns.includes('execution_mode')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN execution_mode TEXT;');
        this.save();
      }

      if (!columns.includes('pinned')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;');
        this.save();
      }

      if (!columns.includes('active_skill_ids')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN active_skill_ids TEXT;');
        this.save();
      }

      // Migration: Add sequence column to cowork_messages
      const msgColsResult = this.db.exec("PRAGMA table_info(cowork_messages);");
      const msgColumns = msgColsResult[0]?.values.map((row) => row[1]) || [];

      if (!msgColumns.includes('sequence')) {
        this.db.run('ALTER TABLE cowork_messages ADD COLUMN sequence INTEGER');

        // 为现有消息按 created_at 和 ROWID 分配序列号
        this.db.run(`
          WITH numbered AS (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY session_id
              ORDER BY created_at ASC, ROWID ASC
            ) as seq
            FROM cowork_messages
          )
          UPDATE cowork_messages
          SET sequence = (SELECT seq FROM numbered WHERE numbered.id = cowork_messages.id)
        `);

        this.save();
      }
    } catch {
      // Column already exists or migration not needed.
    }

    try {
      this.db.run('UPDATE cowork_sessions SET pinned = 0 WHERE pinned IS NULL;');
    } catch {
      // Column might not exist yet.
    }

    try {
      this.db.run(`UPDATE cowork_sessions SET execution_mode = 'local' WHERE execution_mode = 'container';`);
      this.db.run(`
        UPDATE cowork_config
        SET value = 'local'
        WHERE key = 'executionMode' AND value = 'container';
      `);
    } catch (error) {
      console.warn('Failed to migrate cowork execution mode:', error);
    }

    this.migrateLegacyMemoryFileToUserMemories();
    this.migrateFromElectronStore(basePath);
    this.save();
  }

  save() {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  onDidChange<T = unknown>(key: string, callback: (newValue: T | undefined, oldValue: T | undefined) => void) {
    const handler = (payload: ChangePayload<T>) => {
      if (payload.key !== key) return;
      callback(payload.newValue, payload.oldValue);
    };
    this.emitter.on('change', handler);
    return () => this.emitter.off('change', handler);
  }

  get<T = unknown>(key: string): T | undefined {
    const result = this.db.exec('SELECT value FROM kv WHERE key = ?', [key]);
    if (!result[0]?.values[0]) return undefined;
    const value = result[0].values[0][0] as string;
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      console.warn(`Failed to parse store value for ${key}`, error);
      return undefined;
    }
  }

  set<T = unknown>(key: string, value: T): void {
    const oldValue = this.get<T>(key);
    const now = Date.now();
    this.db.run(`
      INSERT INTO kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `, [key, JSON.stringify(value), now]);
    this.save();
    this.emitter.emit('change', { key, newValue: value, oldValue } as ChangePayload<T>);
  }

  delete(key: string): void {
    const oldValue = this.get(key);
    this.db.run('DELETE FROM kv WHERE key = ?', [key]);
    this.save();
    this.emitter.emit('change', { key, newValue: undefined, oldValue } as ChangePayload);
  }

  // Expose database for cowork operations
  getDatabase(): Database {
    return this.db;
  }

  // Expose save method for external use (e.g., CoworkStore)
  getSaveFunction(): () => void {
    return () => this.save();
  }

  private tryReadLegacyMemoryText(): string {
    const candidates = [
      path.join(process.cwd(), 'MEMORY.md'),
      path.join(app.getAppPath(), 'MEMORY.md'),
      path.join(process.cwd(), 'memory.md'),
      path.join(app.getAppPath(), 'memory.md'),
    ];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return fs.readFileSync(candidate, 'utf8');
        }
      } catch {
        // Skip unreadable candidates.
      }
    }
    return '';
  }

  private parseLegacyMemoryEntries(raw: string): string[] {
    const normalized = raw.replace(/```[\s\S]*?```/g, ' ');
    const lines = normalized.split(/\r?\n/);
    const entries: string[] = [];
    const seen = new Set<string>();

    for (const line of lines) {
      const match = line.trim().match(/^-+\s*(?:\[[^\]]+\]\s*)?(.+)$/);
      if (!match?.[1]) continue;
      const text = match[1].replace(/\s+/g, ' ').trim();
      if (!text || text.length < 6) continue;
      if (/^\(empty\)$/i.test(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(text.length > 360 ? `${text.slice(0, 359)}…` : text);
    }

    return entries.slice(0, 200);
  }

  private memoryFingerprint(text: string): string {
    const normalized = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return crypto.createHash('sha1').update(normalized).digest('hex');
  }

  private migrateLegacyMemoryFileToUserMemories(): void {
    if (this.get<string>(USER_MEMORIES_MIGRATION_KEY) === '1') {
      return;
    }

    const content = this.tryReadLegacyMemoryText();
    if (!content.trim()) {
      this.set(USER_MEMORIES_MIGRATION_KEY, '1');
      return;
    }

    const entries = this.parseLegacyMemoryEntries(content);
    if (entries.length === 0) {
      this.set(USER_MEMORIES_MIGRATION_KEY, '1');
      return;
    }

    const now = Date.now();
    this.db.run('BEGIN TRANSACTION;');
    try {
      for (const text of entries) {
        const fingerprint = this.memoryFingerprint(text);
        const existing = this.db.exec(
          `SELECT id FROM user_memories WHERE fingerprint = ? AND status != 'deleted' LIMIT 1`,
          [fingerprint]
        );
        if (existing[0]?.values?.[0]?.[0]) {
          continue;
        }

        const memoryId = crypto.randomUUID();
        this.db.run(`
          INSERT INTO user_memories (
            id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
          ) VALUES (?, ?, ?, ?, 1, 'created', ?, ?, NULL)
        `, [memoryId, text, fingerprint, 0.9, now, now]);

        this.db.run(`
          INSERT INTO user_memory_sources (id, memory_id, session_id, message_id, role, is_active, created_at)
          VALUES (?, ?, NULL, NULL, 'system', 1, ?)
        `, [crypto.randomUUID(), memoryId, now]);
      }

      this.db.run('COMMIT;');
    } catch (error) {
      this.db.run('ROLLBACK;');
      console.warn('Failed to migrate legacy MEMORY.md entries:', error);
    }

    this.set(USER_MEMORIES_MIGRATION_KEY, '1');
  }

  // ── KB Folders ──────────────────────────────────────────────────────────

  addKBFolder(folderPath: string): number {
    this.db.run(
      `INSERT OR IGNORE INTO kb_folders (path, created_at) VALUES (?, ?)`,
      [folderPath, Date.now()]
    );
    const rows = this.db.exec(
      `SELECT id FROM kb_folders WHERE path = ?`,
      [folderPath]
    );
    const id = rows[0]?.values[0]?.[0] as number;
    this.save();
    return id;
  }

  removeKBFolder(folderId: number): void {
    this.db.run(`DELETE FROM kb_docs WHERE folder_id = ?`, [folderId]);
    this.db.run(`DELETE FROM kb_folders WHERE id = ?`, [folderId]);
    this.save();
  }

  listKBFolders(): Array<{ id: number; path: string; created_at: number }> {
    const rows = this.db.exec(`SELECT id, path, created_at FROM kb_folders ORDER BY created_at ASC`);
    if (!rows.length) return [];
    return rows[0].values.map(([id, path, created_at]) => ({
      id: id as number,
      path: path as string,
      created_at: created_at as number,
    }));
  }

  // ── KB Docs ──────────────────────────────────────────────────────────────

  upsertKBDoc(doc: {
    folder_id: number;
    file_path: string;
    file_hash?: string;
    status: string;
    error_msg?: string;
    chunk_count?: number;
  }): void {
    this.db.run(
      `INSERT INTO kb_docs (folder_id, file_path, file_hash, status, error_msg, chunk_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         file_hash = excluded.file_hash,
         status = excluded.status,
         error_msg = excluded.error_msg,
         chunk_count = excluded.chunk_count,
         updated_at = excluded.updated_at`,
      [
        doc.folder_id,
        doc.file_path,
        doc.file_hash ?? null,
        doc.status,
        doc.error_msg ?? null,
        doc.chunk_count ?? null,
        Date.now(),
      ]
    );
    this.save();
  }

  getKBDoc(filePath: string): { id: number; folder_id: number; file_path: string; file_hash: string | null; status: string; error_msg: string | null; chunk_count: number | null } | null {
    const rows = this.db.exec(
      `SELECT id, folder_id, file_path, file_hash, status, error_msg, chunk_count FROM kb_docs WHERE file_path = ?`,
      [filePath]
    );
    if (!rows.length || !rows[0].values.length) return null;
    const [id, folder_id, file_path, file_hash, status, error_msg, chunk_count] = rows[0].values[0];
    return { id: id as number, folder_id: folder_id as number, file_path: file_path as string, file_hash: file_hash as string | null, status: status as string, error_msg: error_msg as string | null, chunk_count: chunk_count as number | null };
  }

  deleteKBDoc(filePath: string): void {
    this.db.run(`DELETE FROM kb_docs WHERE file_path = ?`, [filePath]);
    this.save();
  }

  listKBDocsByFolder(folderId: number): Array<{ id: number; file_path: string; file_hash: string | null; status: string; error_msg: string | null; chunk_count: number | null }> {
    const rows = this.db.exec(
      `SELECT id, file_path, file_hash, status, error_msg, chunk_count FROM kb_docs WHERE folder_id = ? ORDER BY file_path ASC`,
      [folderId]
    );
    if (!rows.length) return [];
    return rows[0].values.map(([id, file_path, file_hash, status, error_msg, chunk_count]) => ({
      id: id as number,
      file_path: file_path as string,
      file_hash: file_hash as string | null,
      status: status as string,
      error_msg: error_msg as string | null,
      chunk_count: chunk_count as number | null,
    }));
  }

  getKBStats(): { total_docs: number; done_docs: number; error_docs: number; total_chunks: number } {
    const rows = this.db.exec(`
      SELECT
        COUNT(*) as total_docs,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done_docs,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_docs,
        COALESCE(SUM(chunk_count), 0) as total_chunks
      FROM kb_docs
    `);
    if (!rows.length || !rows[0].values.length) return { total_docs: 0, done_docs: 0, error_docs: 0, total_chunks: 0 };
    const [total_docs, done_docs, error_docs, total_chunks] = rows[0].values[0];
    return {
      total_docs: total_docs as number,
      done_docs: done_docs as number,
      error_docs: error_docs as number,
      total_chunks: total_chunks as number,
    };
  }

  listKBErrorDocs(): Array<{ file_path: string; error_msg: string | null }> {
    const rows = this.db.exec(
      `SELECT file_path, error_msg FROM kb_docs WHERE status = 'error' ORDER BY file_path ASC`
    );
    if (!rows.length) return [];
    return rows[0].values.map(([file_path, error_msg]) => ({
      file_path: file_path as string,
      error_msg: error_msg as string | null,
    }));
  }

  clearKBDocsByFolder(folderId: number): void {
    this.db.run(`DELETE FROM kb_docs WHERE folder_id = ?`, [folderId]);
    this.save();
  }

  private migrateFromElectronStore(userDataPath: string) {
    const result = this.db.exec('SELECT COUNT(*) as count FROM kv');
    const count = result[0]?.values[0]?.[0] as number;
    if (count > 0) return;

    const legacyPath = path.join(userDataPath, 'config.json');
    if (!fs.existsSync(legacyPath)) return;

    try {
      const raw = fs.readFileSync(legacyPath, 'utf8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (!data || typeof data !== 'object') return;

      const entries = Object.entries(data);
      if (!entries.length) return;

      const now = Date.now();
      this.db.run('BEGIN TRANSACTION;');
      try {
        entries.forEach(([key, value]) => {
          this.db.run(`
            INSERT INTO kv (key, value, updated_at)
            VALUES (?, ?, ?)
          `, [key, JSON.stringify(value), now]);
        });
        this.db.run('COMMIT;');
        this.save();
        console.info(`Migrated ${entries.length} entries from electron-store.`);
      } catch (error) {
        this.db.run('ROLLBACK;');
        throw error;
      }
    } catch (error) {
      console.warn('Failed to migrate electron-store data:', error);
    }
  }
}
