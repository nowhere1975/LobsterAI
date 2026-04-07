import * as lancedb from '@lancedb/lancedb';
import path from 'path';
import type { KBSearchResult } from './types';

const TABLE_NAME = 'kb_chunks';
const EMBEDDING_DIM = 2048; // Zhipu embedding-3 default dimensions
const SIMILARITY_THRESHOLD = 0.5;

export interface KBChunkRecord {
  id: string;         // `${file_path}::${chunk_index}`
  file_path: string;
  chunk_index: number;
  text: string;
  vector: number[];
}

export class KBStore {
  private dbPath: string;
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;

  constructor(userDataPath: string) {
    this.dbPath = path.join(userDataPath, 'kb.lance');
  }

  async init(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
    const tableNames = await this.db.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    }
    // Table created lazily on first write
  }

  async upsertChunks(chunks: KBChunkRecord[]): Promise<void> {
    if (!this.db) throw new Error('[KBStore] not initialized');
    if (!chunks.length) return;

    if (!this.table) {
      this.table = await this.db.createTable(TABLE_NAME, chunks as unknown as Record<string, unknown>[], { mode: 'overwrite' });
    } else {
      // Delete existing chunks for this file first
      const filePath = chunks[0].file_path;
      try {
        await this.table.delete(`file_path = '${filePath.replace(/'/g, "''")}'`);
      } catch {
        // Table may be empty, ignore
      }
      await this.table.add(chunks as unknown as Record<string, unknown>[]);
    }
  }

  async deleteByFilePath(filePath: string): Promise<void> {
    if (!this.table) return;
    try {
      await this.table.delete(`file_path = '${filePath.replace(/'/g, "''")}'`);
    } catch {
      // ignore if table is empty
    }
  }

  async search(queryVector: number[], topK: number): Promise<KBSearchResult[]> {
    if (!this.table) return [];
    try {
      const results = await this.table
        .vectorSearch(queryVector)
        .distanceType('cosine')
        .limit(topK)
        .toArray();

      return results
        .map((row: Record<string, unknown>) => ({
          file_path: row['file_path'] as string,
          chunk_index: row['chunk_index'] as number,
          text: row['text'] as string,
          score: 1 - (row['_distance'] as number), // cosine distance → similarity
        }))
        .filter((r) => r.score >= SIMILARITY_THRESHOLD);
    } catch {
      return [];
    }
  }

  async sampleChunks(n: number): Promise<string[]> {
    if (!this.table) return [];
    try {
      // Load all text chunks (skip vector column to keep memory low)
      const rows = await this.table.query().select(['file_path', 'text']).toArray();
      // Fisher-Yates shuffle for true random sampling across all files
      for (let i = rows.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rows[i], rows[j]] = [rows[j], rows[i]];
      }
      // Deduplicate by file to ensure diversity across documents
      const seen = new Set<string>();
      const diverse: string[] = [];
      for (const r of rows) {
        const fp = r['file_path'] as string;
        if (!seen.has(fp)) {
          seen.add(fp);
          diverse.push(r['text'] as string);
          if (diverse.length >= n) break;
        }
      }
      // If not enough unique files, fill up with remaining shuffled chunks
      if (diverse.length < n) {
        for (const r of rows) {
          if (diverse.length >= n) break;
          const text = r['text'] as string;
          if (!diverse.includes(text)) diverse.push(text);
        }
      }
      return diverse;
    } catch {
      return [];
    }
  }

  async isEmpty(): Promise<boolean> {
    if (!this.table) return true;
    try {
      const rows = await this.table.countRows();
      return rows === 0;
    } catch {
      return true;
    }
  }

  async deleteTable(): Promise<void> {
    if (!this.db || !this.table) return;
    await this.db.dropTable(TABLE_NAME);
    this.table = null;
  }
}

// Suppress unused warning — EMBEDDING_DIM is kept for documentation purposes
void EMBEDDING_DIM;
