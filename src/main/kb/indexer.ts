import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { MarkdownTextSplitter } from '@langchain/textsplitters';
import * as XLSX from 'xlsx';
import type { SqliteStore } from '../sqliteStore';
import type { KBStore } from './store';
import type { KBChunkRecord } from './store';
import type { KBIndexProgress } from './types';
import { KB_SUPPORTED_EXTENSIONS } from './types';

const CHUNK_SIZE = 500;           // tokens ≈ chars for CJK
const CHUNK_OVERLAP = 100;
const ROWS_PER_CHUNK = 5;         // Excel rows per chunk (keep chunks within embedding token limits)
const EMBED_BATCH_SIZE = 16;      // embedding batch size
const MAX_CHUNK_CHARS = 2000;     // Hard cap per chunk before sending to embedding API
const KB_SERVER_URL = 'http://1.14.96.63:3000'; // LLM relay server

// ── Pure helpers (exported for testing) ─────────────────────────────────────

export async function chunkMarkdown(text: string): Promise<string[]> {
  const splitter = new MarkdownTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });
  const docs = await splitter.createDocuments([text]);
  return docs.map((d) => d.pageContent).filter((c) => c.trim().length > 0);
}

export function chunkExcel(
  rows: string[][],
  sheetName: string,
  rowsPerChunk: number = ROWS_PER_CHUNK
): string[] {
  if (rows.length < 2) return []; // need at least header + 1 data row
  const header = rows[0];
  const dataRows = rows.slice(1);
  const chunks: string[] = [];

  for (let i = 0; i < dataRows.length; i += rowsPerChunk) {
    const batch = dataRows.slice(i, i + rowsPerChunk);
    const lines = batch
      .map((row) => header.map((h, idx) => `${h}: ${row[idx] ?? ''}`).join(', '))
      .filter((line) => line.replace(/[:,\s]/g, '').length > 0); // skip all-empty rows
    if (lines.length > 0) {
      chunks.push(`[Sheet: ${sheetName}]\n` + lines.join('\n'));
    }
  }
  return chunks;
}

export function containsTriggerWord(message: string, triggerWords: string[]): boolean {
  const lower = message.toLowerCase();
  return triggerWords.some((word) => lower.includes(word.toLowerCase()));
}

function fileHash(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── Local document parsers ───────────────────────────────────────────────────

/** Extract plain text from a PPTX file by reading slide XMLs from the ZIP. */
async function parsePptx(filePath: string): Promise<string> {
  // Use node-stream-zip for random-access reads — handles large PPTX files
  // with embedded videos without loading the entire archive into memory.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const StreamZip = require('node-stream-zip') as { async: new (opts: { file: string }) => NodeStreamZipAsync };

  interface NodeStreamZipAsync {
    entries(): Promise<Record<string, unknown>>;
    entryData(name: string): Promise<Buffer>;
    close(): Promise<void>;
  }

  const zip = new StreamZip.async({ file: filePath });
  try {
    const entries = await zip.entries();
    const slideNames = Object.keys(entries)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const n = (s: string) => parseInt(s.match(/(\d+)\.xml$/)?.[1] ?? '0', 10);
        return n(a) - n(b);
      });

    const slideTexts: string[] = [];
    for (const name of slideNames) {
      const xml = (await zip.entryData(name)).toString('utf-8');
      const parts = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => m[1]);
      const text = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (text) slideTexts.push(text);
    }

    return slideTexts.join('\n\n');
  } finally {
    await zip.close();
  }
}

/** Extract plain text from a DOCX file by reading word/document.xml from the ZIP. */
async function parseDocx(filePath: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const StreamZip = require('node-stream-zip') as { async: new (opts: { file: string }) => { entryData(name: string): Promise<Buffer>; close(): Promise<void> } };
  const zip = new StreamZip.async({ file: filePath });
  try {
    const xml = (await zip.entryData('word/document.xml')).toString('utf-8');
    const withBreaks = xml.replace(/<w:p[ >]/g, '\n<w:p>');
    const parts = [...withBreaks.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
    return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
  } finally {
    await zip.close();
  }
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff']);
const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/png', tiff: 'image/png',
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Describe an image via Server A → Zhipu GLM-4V. */
async function describeImageWithZhipu(filePath: string, deviceId: string): Promise<string> {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${Math.round(stat.size / 1024)}KB > 4096KB limit)`);
  }

  const fetch = (await import('electron')).net.fetch;
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mimeType = IMAGE_MIME[ext] ?? 'image/jpeg';
  const imageBase64 = fs.readFileSync(filePath).toString('base64');

  const resp = await fetch(`${KB_SERVER_URL}/api/kb/describe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, imageBase64, mimeType }),
  });

  if (!resp.ok) {
    throw new Error(`KB describe error ${resp.status}: ${await resp.text()}`);
  }

  const json = await resp.json() as { description?: string };
  return json.description ?? '';
}

/** Extract plain text from a PDF file. */
async function parsePdf(filePath: string): Promise<string> {
  // pdf-parse v2: class-based API, accepts a local file path via `url`
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PDFParse } = require('pdf-parse') as { PDFParse: new (opts: { url: string }) => { getText(): Promise<{ text: string }> } };
  const parser = new PDFParse({ url: filePath });
  const result = await parser.getText();
  return result.text;
}

async function callEmbeddingBatch(texts: string[], deviceId: string): Promise<number[][]> {
  const fetch = (await import('electron')).net.fetch;

  const response = await fetch(`${KB_SERVER_URL}/api/kb/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, texts }),
  });

  if (!response.ok) {
    throw new Error(`KB embed error ${response.status}: ${await response.text()}`);
  }

  const json = await response.json() as { data: Array<{ embedding: number[] }> };
  return json.data.map((item) => item.embedding);
}

/** Call embedding API for a batch; on failure, fall back to one-by-one to skip bad chunks. */
async function callEmbedding(texts: string[], deviceId: string): Promise<(number[] | null)[]> {
  const safeTexts = texts.map((t) => t.length > MAX_CHUNK_CHARS ? t.slice(0, MAX_CHUNK_CHARS) : t);

  try {
    return await callEmbeddingBatch(safeTexts, deviceId);
  } catch (batchError) {
    console.warn(`[KBIndexer] batch embedding failed, retrying individually: ${batchError instanceof Error ? batchError.message : batchError}`);
    const results: (number[] | null)[] = [];
    for (let i = 0; i < safeTexts.length; i++) {
      try {
        const [vec] = await callEmbeddingBatch([safeTexts[i]], deviceId);
        results.push(vec);
      } catch (singleError) {
        console.warn(`[KBIndexer] skipping chunk ${i} (${safeTexts[i].length} chars): ${singleError instanceof Error ? singleError.message : singleError}`);
        results.push(null);
      }
    }
    return results;
  }
}

// ── Excel parser ─────────────────────────────────────────────────────────────

function parseExcelToChunks(filePath: string): string[] {
  const workbook = XLSX.read(fs.readFileSync(filePath), { cellDates: true });
  const allChunks: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      defval: '',
      raw: false,
    }) as string[][];

    const chunks = chunkExcel(rows, sheetName);
    allChunks.push(...chunks);
  }

  return allChunks;
}

// ── KBIndexer ────────────────────────────────────────────────────────────────

export class KBIndexer extends EventEmitter {
  private store: SqliteStore;
  private kbStore: KBStore;
  private isRunning = false;
  private queue: Array<{ filePath: string; folderId: number; action: 'upsert' | 'delete' }> = [];

  constructor(store: SqliteStore, kbStore: KBStore) {
    super();
    this.store = store;
    this.kbStore = kbStore;
  }

  enqueue(filePath: string, folderId: number, action: 'upsert' | 'delete'): void {
    // Deduplicate: replace existing entry for same path
    this.queue = this.queue.filter((q) => q.filePath !== filePath);
    this.queue.push({ filePath, folderId, action });
    if (!this.isRunning) {
      void this.processQueue();
    }
  }

  /** Cancel all pending queue items for a folder (call before removing folder). */
  cancelFolder(folderId: number): void {
    this.queue = this.queue.filter((q) => q.folderId !== folderId);
  }

  private async processQueue(): Promise<void> {
    this.isRunning = true;
    const errors: string[] = [];
    let done = 0;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      // Total is always recalculated: completed + current + remaining
      const total = done + 1 + this.queue.length;

      this.emit('progress', {
        total,
        done,
        current_file: item.filePath,
        errors,
      } satisfies KBIndexProgress);

      if (item.action === 'delete') {
        await this.kbStore.deleteByFilePath(item.filePath);
        this.store.deleteKBDoc(item.filePath);
      } else {
        await this.indexFile(item.filePath, item.folderId, errors);
      }

      done++;
      await new Promise<void>((resolve) => setImmediate(resolve)); // yield to event loop
    }

    this.emit('progress', {
      total: done,
      done,
      current_file: '',
      errors,
    } satisfies KBIndexProgress);

    this.isRunning = false;
  }

  private async indexFile(filePath: string, folderId: number, errors: string[]): Promise<void> {
    const appConfig = this.store.get<{ cloud?: { deviceId?: string } }>('app_config');
    const deviceId = appConfig?.cloud?.deviceId?.trim() ?? '';

    if (!deviceId) {
      const msg = `[KB] skipping ${path.basename(filePath)}: cloud service not registered`;
      console.warn(msg);
      errors.push(msg);
      this.store.upsertKBDoc({ folder_id: folderId, file_path: filePath, status: 'error', error_msg: 'Cloud service not registered' });
      return;
    }

    let hash: string;
    try {
      hash = fileHash(filePath);
    } catch {
      this.store.upsertKBDoc({ folder_id: folderId, file_path: filePath, status: 'error', error_msg: 'Cannot read file' });
      errors.push(filePath);
      return;
    }

    const existing = this.store.getKBDoc(filePath);
    if (existing?.file_hash === hash && existing.status === 'done') {
      return; // unchanged
    }

    this.store.upsertKBDoc({ folder_id: folderId, file_path: filePath, file_hash: hash, status: 'indexing' });

    try {
      const rawChunks = await this.extractChunks(filePath, deviceId);
      const chunks = rawChunks.filter((c) => c.trim().length > 0);
      if (!chunks.length) {
        this.store.upsertKBDoc({ folder_id: folderId, file_path: filePath, file_hash: hash, status: 'done', chunk_count: 0 });
        return;
      }

      const allVectors: (number[] | null)[] = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
        const vectors = await callEmbedding(batch, deviceId);
        allVectors.push(...vectors);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      const records: KBChunkRecord[] = chunks
        .map((text, idx) => ({ text, idx, vector: allVectors[idx] }))
        .filter((item): item is { text: string; idx: number; vector: number[] } => item.vector !== null)
        .map(({ text, idx, vector }) => ({
          id: `${filePath}::${idx}`,
          file_path: filePath,
          chunk_index: idx,
          text,
          vector,
        }));

      await this.kbStore.upsertChunks(records);
      this.store.upsertKBDoc({ folder_id: folderId, file_path: filePath, file_hash: hash, status: 'done', chunk_count: chunks.length });

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[KBIndexer] failed to index ${filePath}:`, error);
      this.store.upsertKBDoc({ folder_id: folderId, file_path: filePath, file_hash: hash, status: 'error', error_msg: msg });
      errors.push(`${path.basename(filePath)}: ${msg}`);
    }
  }

  private async extractChunks(filePath: string, deviceId: string): Promise<string[]> {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.xlsx' || ext === '.xls') {
      return parseExcelToChunks(filePath);
    }

    if (ext === '.md') {
      const text = fs.readFileSync(filePath, 'utf-8');
      return chunkMarkdown(text);
    }

    if (ext === '.pptx') {
      const text = await parsePptx(filePath);
      return chunkMarkdown(text);
    }

    if (ext === '.docx') {
      const text = await parseDocx(filePath);
      return chunkMarkdown(text);
    }

    if (ext === '.pdf') {
      const text = await parsePdf(filePath);
      return chunkMarkdown(text);
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      const description = await describeImageWithZhipu(filePath, deviceId);
      if (!description.trim()) return [];
      const fileName = path.basename(filePath);
      return [`[图片：${fileName}]\n${description}`];
    }

    return [];
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get running(): boolean {
    return this.isRunning;
  }
}

export const callEmbeddingPublic = callEmbeddingBatch;
