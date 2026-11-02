import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { IndexEncryption } from './encryption.js';
import type { CodeChunk, IndexMeta } from '../semantic/searchEngine.js';

/**
 * Where the search index lives. The default is SQLite (`.codebase/index.sqlite`, via Node's built-in node:sqlite):
 * a refresh rewrites only the changed files' rows, and a long-running process keeps the chunks in memory and
 * patches them in place on its own writes, so it never re-reads the whole index. The JSON file
 * (`.codebase/embeddings.json`) remains for encrypted indexes and for Node versions without node:sqlite.
 */

export interface StoreSnapshot {
  chunks: CodeChunk[];
  meta: IndexMeta | undefined;
}

export interface FileUpdate {
  // Repo-relative POSIX path
  rel: string;
  // New chunks for the file, or null when it was deleted or is no longer indexable
  chunks: CodeChunk[] | null;
  stat?: { mtimeMs: number; size: number };
}

export interface ChunkStore {
  readonly kind: 'sqlite' | 'json';
  readonly paths: string[];
  /** The whole index; `unreadable` when a store exists but cannot be read or decrypted. */
  read(): { snapshot: StoreSnapshot | null; unreadable: boolean };
  replaceAll(chunks: CodeChunk[], meta: IndexMeta): void;
  updateFiles(updates: FileUpdate[], refreshedAt: string): void;
  /** PageRank scores by repo-relative path, stored with the index (null when none are stored). */
  readScores(): Map<string, number> | null;
  writeScores(scores: Map<string, number>): void;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): Array<Record<string, unknown>>; get(...params: unknown[]): Record<string, unknown> | undefined };
  close(): void;
}

// Bump when the table layout changes; an index with another version is rebuilt
const SCHEMA_VERSION = 1;

let sqliteModule: { DatabaseSync: new (file: string) => SqliteDatabase } | null | undefined;
function sqlite(): { DatabaseSync: new (file: string) => SqliteDatabase } | null {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = createRequire(import.meta.url)('node:sqlite');
    } catch {
      // Node without node:sqlite (before 22.5, or 22.x without --experimental-sqlite)
      sqliteModule = null;
    }
  }
  return sqliteModule ?? null;
}

const toRel = (repoPath: string, filePath: string) => path.relative(repoPath, filePath).replace(/\\/g, '/');

export class ChunkStores {
  private static sqliteStores = new Map<string, SqliteChunkStore>();

  /** The store for this repo: JSON when the index is encrypted or node:sqlite is missing, otherwise SQLite. */
  public static forRepo(repoPath: string, encrypt = false): ChunkStore {
    const root = path.resolve(repoPath);
    if (encrypt || JsonChunkStore.encryptionWanted(root) || !sqlite() || process.env.CODEBASE_TRAINER_STORE === 'json') {
      return new JsonChunkStore(root, encrypt);
    }
    let store = this.sqliteStores.get(root);
    if (!store) {
      store = new SqliteChunkStore(root);
      this.sqliteStores.set(root, store);
    }
    return store;
  }

  /** Total bytes of index files on disk for this repo. */
  public static sizeBytes(repoPath: string): number {
    return ['index.sqlite', 'index.sqlite-wal', 'embeddings.json']
      .map(f => path.join(repoPath, '.codebase', f))
      .reduce((sum, f) => sum + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
  }

  /** Drops the in-memory copies (connections are never held open). */
  public static closeAll(): void {
    this.sqliteStores.forEach(store => store.close());
    this.sqliteStores.clear();
  }
}

class JsonChunkStore implements ChunkStore {
  public readonly kind = 'json' as const;
  public readonly paths: string[];
  private readonly file: string;

  constructor(private readonly repoPath: string, private readonly encrypt: boolean) {
    this.file = path.join(repoPath, '.codebase', 'embeddings.json');
    this.paths = [this.file];
  }

  public static encryptionWanted(repoPath: string): boolean {
    return Boolean(process.env.CODEBASE_ENCRYPTION_KEY) || fs.existsSync(path.join(repoPath, '.codebase', '.master.key'));
  }

  public read(): { snapshot: StoreSnapshot | null; unreadable: boolean } {
    if (!fs.existsSync(this.file)) return { snapshot: null, unreadable: false };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const data = IndexEncryption.isEncrypted(parsed) ? JSON.parse(IndexEncryption.decrypt(parsed, this.repoPath)) : parsed;
      return { snapshot: { chunks: data.chunks || [], meta: data.meta }, unreadable: false };
    } catch {
      return { snapshot: null, unreadable: true };
    }
  }

  public replaceAll(chunks: CodeChunk[], meta: IndexMeta): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const payload = JSON.stringify({ meta, chunks }, null, 2);
    const shouldEncrypt = this.encrypt || JsonChunkStore.encryptionWanted(this.repoPath);
    fs.writeFileSync(this.file, shouldEncrypt ? JSON.stringify(IndexEncryption.encrypt(payload, this.repoPath), null, 2) : payload, 'utf8');
  }

  public updateFiles(updates: FileUpdate[], refreshedAt: string): void {
    const current = this.read().snapshot;
    const changed = new Set(updates.map(u => u.rel));
    const meta: IndexMeta = current?.meta ?? { builtAt: refreshedAt, refreshedAt, files: {} };
    const chunks = (current?.chunks ?? []).filter(c => !changed.has(toRel(this.repoPath, c.filePath)));
    updates.forEach(u => {
      if (u.chunks && u.stat) {
        chunks.push(...u.chunks);
        meta.files[u.rel] = u.stat;
      } else {
        delete meta.files[u.rel];
      }
    });
    this.replaceAll(chunks, { ...meta, refreshedAt });
  }

  // Not persisted: the JSON store is the fallback for encrypted indexes, which recompute scores per process
  public readScores(): Map<string, number> | null {
    return null;
  }

  public writeScores(): void {
    // See readScores
  }
}

class SqliteChunkStore implements ChunkStore {
  public readonly kind = 'sqlite' as const;
  public readonly paths: string[];
  private readonly file: string;
  // This process's copy of the index, valid while the database generation matches
  private cache: { generation: number; snapshot: StoreSnapshot } | null = null;

  constructor(private readonly repoPath: string) {
    this.file = path.join(repoPath, '.codebase', 'index.sqlite');
    this.paths = [this.file];
  }

  public close(): void {
    this.cache = null;
  }

  public read(): { snapshot: StoreSnapshot | null; unreadable: boolean } {
    if (!fs.existsSync(this.file)) {
      this.cache = null;
      return { snapshot: null, unreadable: false };
    }
    try {
      return this.withDb(db => this.readFrom(db));
    } catch {
      this.cache = null;
      return { snapshot: null, unreadable: true };
    }
  }

  private readFrom(db: SqliteDatabase): { snapshot: StoreSnapshot | null; unreadable: boolean } {
    {
      const generation = this.generation(db);
      if (this.cache && this.cache.generation === generation) return { snapshot: this.cache.snapshot, unreadable: false };
      if (Number(this.metaValue(db, 'schema')) !== SCHEMA_VERSION) return { snapshot: null, unreadable: false };

      const files: IndexMeta['files'] = {};
      db.prepare('SELECT path, mtime, size FROM files').all().forEach(row => {
        files[String(row.path)] = { mtimeMs: Number(row.mtime), size: Number(row.size) };
      });
      const chunks = db.prepare('SELECT id, file, start_line, end_line, content, tokens, symbols, embedding FROM chunks ORDER BY rowid').all().map(row => this.toChunk(row));
      const meta: IndexMeta = {
        builtAt: String(this.metaValue(db, 'builtAt') ?? ''),
        refreshedAt: String(this.metaValue(db, 'refreshedAt') ?? ''),
        files,
        tokenizer: Number(this.metaValue(db, 'tokenizer')),
        chunker: this.metaValue(db, 'chunker') ?? undefined
      };
      this.cache = { generation, snapshot: { chunks, meta } };
      return { snapshot: this.cache.snapshot, unreadable: false };
    }
  }

  public replaceAll(chunks: CodeChunk[], meta: IndexMeta): void {
    // A fresh file: faster than deleting every row, and it drops whatever an older layout left behind
    this.cache = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    ['', '-wal', '-shm', '-journal'].forEach(suffix => fs.rmSync(this.file + suffix, { force: true }));
    this.withDb(db => this.transaction(db, () => {
      const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      setMeta.run('schema', String(SCHEMA_VERSION));
      setMeta.run('builtAt', meta.builtAt);
      setMeta.run('refreshedAt', meta.refreshedAt);
      setMeta.run('tokenizer', String(meta.tokenizer ?? ''));
      setMeta.run('chunker', String(meta.chunker ?? ''));
      setMeta.run('generation', '1');
      const insertFile = db.prepare('INSERT INTO files (path, mtime, size) VALUES (?, ?, ?)');
      Object.entries(meta.files).forEach(([rel, stat]) => insertFile.run(rel, stat.mtimeMs, stat.size));
      const insertChunk = this.insertChunk(db);
      chunks.forEach(c => insertChunk(c));
    }));
    this.cache = { generation: 1, snapshot: { chunks, meta } };
    // An index from before the SQLite store is now redundant
    fs.rmSync(path.join(this.repoPath, '.codebase', 'embeddings.json'), { force: true });
  }

  public updateFiles(updates: FileUpdate[], refreshedAt: string): void {
    // Bring the in-memory copy up to date first, so it can be patched instead of re-read after the write
    const before = this.read().snapshot;
    let generation = 0;
    this.withDb(db => this.transaction(db, () => {
      const deleteChunks = db.prepare('DELETE FROM chunks WHERE file = ?');
      const deleteFile = db.prepare('DELETE FROM files WHERE path = ?');
      const upsertFile = db.prepare('INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?, ?, ?)');
      const insertChunk = this.insertChunk(db);
      updates.forEach(u => {
        deleteChunks.run(u.rel);
        if (u.chunks && u.stat) {
          upsertFile.run(u.rel, u.stat.mtimeMs, u.stat.size);
          u.chunks.forEach(c => insertChunk(c));
        } else {
          deleteFile.run(u.rel);
        }
      });
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('refreshedAt', refreshedAt);
      generation = this.generation(db) + 1;
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('generation', String(generation));
    }));

    if (before?.meta) {
      const changed = new Set(updates.map(u => u.rel));
      const chunks = before.chunks.filter(c => !changed.has(toRel(this.repoPath, c.filePath)));
      const files = { ...before.meta.files };
      updates.forEach(u => {
        if (u.chunks && u.stat) {
          chunks.push(...u.chunks);
          files[u.rel] = u.stat;
        } else {
          delete files[u.rel];
        }
      });
      this.cache = { generation, snapshot: { chunks, meta: { ...before.meta, files, refreshedAt } } };
    } else {
      this.cache = null;
    }
  }

  public readScores(): Map<string, number> | null {
    if (!fs.existsSync(this.file)) return null;
    try {
      const rows = this.withDb(db => db.prepare('SELECT path, score FROM pagerank').all());
      return rows.length > 0 ? new Map(rows.map(r => [String(r.path), Number(r.score)])) : null;
    } catch {
      return null;
    }
  }

  public writeScores(scores: Map<string, number>): void {
    this.withDb(db => this.transaction(db, () => {
      db.exec('DELETE FROM pagerank');
      const insert = db.prepare('INSERT INTO pagerank (path, score) VALUES (?, ?)');
      scores.forEach((score, rel) => insert.run(rel, score));
    }));
  }

  // A connection per operation: an open handle would lock the file on Windows, so .codebase/ could not be deleted
  private withDb<T>(fn: (db: SqliteDatabase) => T): T {
    const db = this.open();
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  private open(): SqliteDatabase {
    const { DatabaseSync } = sqlite()!;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, file TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        content TEXT NOT NULL, tokens TEXT NOT NULL, symbols TEXT NOT NULL, embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS chunks_by_file ON chunks (file);
      CREATE TABLE IF NOT EXISTS pagerank (path TEXT PRIMARY KEY, score REAL NOT NULL);
    `);
    return db;
  }

  private transaction(db: SqliteDatabase, fn: () => void): void {
    db.exec('BEGIN');
    try {
      fn();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  private metaValue(db: SqliteDatabase, key: string): string | null {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? String(row.value) : null;
  }

  private generation(db: SqliteDatabase): number {
    return Number(this.metaValue(db, 'generation') ?? 0);
  }

  // Paths are stored relative to the repo, so a moved checkout keeps its index
  private insertChunk(db: SqliteDatabase): (c: CodeChunk) => void {
    const statement = db.prepare('INSERT OR REPLACE INTO chunks (id, file, start_line, end_line, content, tokens, symbols, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    return c => {
      const rel = toRel(this.repoPath, c.filePath);
      statement.run(
        `${rel}#L${c.startLine}-L${c.endLine}`, rel, c.startLine, c.endLine, c.content,
        (c.tokens ?? []).join(' '), JSON.stringify(c.symbols ?? []),
        c.embedding ? Buffer.from(new Float32Array(c.embedding).buffer) : null
      );
    };
  }

  private toChunk(row: Record<string, unknown>): CodeChunk {
    const filePath = path.join(this.repoPath, String(row.file));
    const tokens = String(row.tokens);
    const blob = row.embedding as Uint8Array | null;
    return {
      id: `${filePath}#L${row.start_line}-L${row.end_line}`,
      filePath,
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      content: String(row.content),
      tokens: tokens ? tokens.split(' ') : [],
      symbols: JSON.parse(String(row.symbols)),
      embedding: blob ? Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)) : undefined
    };
  }
}
