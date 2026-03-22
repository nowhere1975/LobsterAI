/**
 * MEMORY.md file-based memory management for cowork sessions.
 *
 * Reads and writes the curated long-term memory file that is indexed by
 * the cowork agent. The file may contain mixed content (headings, prose,
 * bullet lists). Only top-level bullet lines (`- text`) are treated as
 * memory entries. Non-bullet content is preserved on writes.
 */

import crypto from 'crypto';
import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TAG = '[CoworkMemory]';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoworkMemoryEntry {
  /** SHA-1 of the normalised text – stable across reads. */
  id: string;
  /** Raw text without the leading "- ". */
  text: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const DEFAULT_COWORK_WORKSPACE = path.join(os.homedir(), 'lobsterai', 'project');

/**
 * Resolve the MEMORY.md path from the user-configured working directory.
 * Falls back to `~/lobsterai/project/MEMORY.md` when unset.
 */
export function resolveMemoryFilePath(workingDirectory: string | undefined): string {
  const dir = (workingDirectory || '').trim();
  return path.join(dir || DEFAULT_COWORK_WORKSPACE, 'MEMORY.md');
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

function normalizeForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fingerprint(text: string): string {
  return crypto.createHash('sha1').update(normalizeForFingerprint(text)).digest('hex');
}

// ---------------------------------------------------------------------------
// Bullet-line detection (single dash only: "- text")
// ---------------------------------------------------------------------------

/** Match a top-level Markdown bullet: exactly one `-` followed by whitespace. */
const BULLET_RE = /^-\s+(.+)$/;

function isBulletLine(line: string): boolean {
  return BULLET_RE.test(line.trim());
}

// ---------------------------------------------------------------------------
// Parsing & serialisation
// ---------------------------------------------------------------------------

const HEADER = '# User Memories';

/**
 * Parse a MEMORY.md file into entries.
 *
 * Recognises lines starting with `- ` (single dash + space).
 * Code blocks are stripped before parsing to avoid false positives.
 */
export function parseMemoryMd(content: string): CoworkMemoryEntry[] {
  const stripped = content.replace(/```[\s\S]*?```/g, ' ');
  const lines = stripped.split(/\r?\n/);
  const entries: CoworkMemoryEntry[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const match = line.trim().match(BULLET_RE);
    if (!match?.[1]) continue;
    const text = match[1].replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2) continue;

    const fp = fingerprint(text);
    if (seen.has(fp)) continue;
    seen.add(fp);
    entries.push({ id: fp, text });
  }

  return entries;
}

/**
 * Serialise entries back to MEMORY.md format (standalone, no existing content).
 */
export function serializeMemoryMd(entries: CoworkMemoryEntry[]): string {
  if (entries.length === 0) return `${HEADER}\n`;
  const lines = entries.map((e) => `- ${e.text}`);
  return `${HEADER}\n\n${lines.join('\n')}\n`;
}

/**
 * Build updated MEMORY.md content by surgically replacing bullet lines
 * while preserving all non-bullet content (headings, prose, sections).
 */
function rebuildMemoryMd(
  originalContent: string,
  entries: CoworkMemoryEntry[],
): string {
  if (!originalContent.trim()) {
    return serializeMemoryMd(entries);
  }

  const lines = originalContent.split(/\r?\n/);
  const result: string[] = [];
  let bulletBlockInserted = false;
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }
    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    if (isBulletLine(line)) {
      if (!bulletBlockInserted) {
        bulletBlockInserted = true;
        for (const e of entries) {
          result.push(`- ${e.text}`);
        }
      }
      continue;
    }

    result.push(line);
  }

  if (!bulletBlockInserted && entries.length > 0) {
    result.push('');
    for (const e of entries) {
      result.push(`- ${e.text}`);
    }
  }

  const text = result.join('\n');
  return text.endsWith('\n') ? text : text + '\n';
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readFileOrEmpty(filePath: string): string {
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return fs.readFileSync(filePath, 'utf8');
    }
  } catch (error) {
    console.warn(`${TAG} Failed to read file ${filePath}:`, error instanceof Error ? error.message : error);
  }
  return '';
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export function readMemoryEntries(filePath: string): CoworkMemoryEntry[] {
  return parseMemoryMd(readFileOrEmpty(filePath));
}

export function writeMemoryEntries(filePath: string, entries: CoworkMemoryEntry[]): void {
  ensureDir(filePath);
  const original = readFileOrEmpty(filePath);
  fs.writeFileSync(filePath, rebuildMemoryMd(original, entries), 'utf8');
  console.log(`${TAG} writeMemoryEntries: wrote ${entries.length} entries to ${filePath}`);
}

export function addMemoryEntry(filePath: string, text: string): CoworkMemoryEntry {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Memory text is required');

  const entries = readMemoryEntries(filePath);
  const entry: CoworkMemoryEntry = { id: fingerprint(trimmed), text: trimmed };

  if (entries.some((e) => e.id === entry.id)) {
    console.log(`${TAG} addMemoryEntry: duplicate skipped (id=${entry.id.slice(0, 8)}…)`);
    return entry;
  }

  entries.push(entry);
  writeMemoryEntries(filePath, entries);
  console.log(`${TAG} addMemoryEntry: added "${trimmed.slice(0, 40)}…" (id=${entry.id.slice(0, 8)}…)`);
  return entry;
}

export function updateMemoryEntry(
  filePath: string,
  id: string,
  newText: string,
): CoworkMemoryEntry | null {
  const trimmed = newText.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Memory text is required');

  const entries = readMemoryEntries(filePath);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) {
    console.warn(`${TAG} updateMemoryEntry: entry not found (id=${id.slice(0, 8)}…)`);
    return null;
  }

  const updated: CoworkMemoryEntry = { id: fingerprint(trimmed), text: trimmed };
  const oldText = entries[idx].text;
  entries[idx] = updated;
  writeMemoryEntries(filePath, entries);
  console.log(`${TAG} updateMemoryEntry: "${oldText.slice(0, 30)}…" → "${trimmed.slice(0, 30)}…"`);
  return updated;
}

export function deleteMemoryEntry(filePath: string, id: string): boolean {
  const entries = readMemoryEntries(filePath);
  const target = entries.find((e) => e.id === id);
  const filtered = entries.filter((e) => e.id !== id);
  if (filtered.length === entries.length) {
    console.warn(`${TAG} deleteMemoryEntry: entry not found (id=${id.slice(0, 8)}…)`);
    return false;
  }

  writeMemoryEntries(filePath, filtered);
  console.log(`${TAG} deleteMemoryEntry: removed "${target?.text.slice(0, 40)}…" (${entries.length} → ${filtered.length})`);
  return true;
}

export function searchMemoryEntries(
  filePath: string,
  query: string,
): CoworkMemoryEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return readMemoryEntries(filePath);
  const all = readMemoryEntries(filePath);
  const results = all.filter((e) => e.text.toLowerCase().includes(q));
  console.log(`${TAG} searchMemoryEntries: query="${q}" → ${results.length}/${all.length} matched`);
  return results;
}

// ---------------------------------------------------------------------------
// SQLite → MEMORY.md migration (lazy, one-time)
// ---------------------------------------------------------------------------

export interface MigrationDataSource {
  isMigrationDone(): boolean;
  markMigrationDone(): void;
  getActiveMemoryTexts(): string[];
}

/**
 * Migrate old SQLite user_memories to MEMORY.md.
 * Returns the number of entries migrated (0 if already done or nothing to migrate).
 */
export function migrateSqliteToMemoryMd(
  filePath: string,
  source: MigrationDataSource,
): number {
  if (source.isMigrationDone()) return 0;

  console.log(`${TAG} Migration: starting SQLite → MEMORY.md migration (target: ${filePath})`);

  const texts = source.getActiveMemoryTexts();
  if (texts.length === 0) {
    console.log(`${TAG} Migration: no active SQLite memories found, marking done`);
    source.markMigrationDone();
    return 0;
  }

  console.log(`${TAG} Migration: found ${texts.length} active SQLite memories to migrate`);

  try {
    const existing = readMemoryEntries(filePath);
    const existingIds = new Set(existing.map((e) => e.id));
    console.log(`${TAG} Migration: MEMORY.md has ${existing.length} existing entries`);

    let added = 0;
    let skipped = 0;
    for (const raw of texts) {
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!text || text.length < 2) continue;
      const id = fingerprint(text);
      if (existingIds.has(id)) {
        skipped++;
        continue;
      }
      existing.push({ id, text });
      existingIds.add(id);
      added++;
    }

    if (added > 0) {
      writeMemoryEntries(filePath, existing);
    }

    console.log(`${TAG} Migration: completed — added=${added}, skipped(duplicate)=${skipped}, total=${existing.length}`);
    source.markMigrationDone();
    return added;
  } catch (error) {
    console.error(`${TAG} Migration: FAILED —`, error instanceof Error ? error.message : error);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap file management (IDENTITY.md, USER.md, SOUL.md)
// ---------------------------------------------------------------------------

const DEFAULT_IDENTITY_ZH = '你的名字是 LobsterAI，一个由网易有道开发的全场景个人助理 Agent。你 7×24 小时在线，能够自主处理日常生产力任务，包括数据分析、PPT 制作、视频生成、文档撰写、信息搜索、邮件工作流、定时任务等。你和用户共享同一个工作空间，协同完成用户的目标。';
const DEFAULT_IDENTITY_EN = 'Your name is LobsterAI, a full-scenario personal assistant agent developed by NetEase Youdao. You are available 24/7 and can autonomously handle everyday productivity tasks, including data analysis, PPT creation, video generation, document writing, information search, email workflows, scheduled jobs, and more. You and the user share the same workspace, collaborating to achieve the user\'s goals.';

function getDefaultIdentity(): string {
  try {
    const locale = app.getLocale();
    return locale.startsWith('zh') ? DEFAULT_IDENTITY_ZH : DEFAULT_IDENTITY_EN;
  } catch {
    return DEFAULT_IDENTITY_EN;
  }
}

const BOOTSTRAP_ALLOWLIST = new Set(['IDENTITY.md', 'USER.md', 'SOUL.md']);

function validateBootstrapFilename(filename: string): void {
  if (!BOOTSTRAP_ALLOWLIST.has(filename)) {
    throw new Error(`Invalid bootstrap filename: ${filename}. Allowed: ${[...BOOTSTRAP_ALLOWLIST].join(', ')}`);
  }
}

export function resolveBootstrapFilePath(workingDirectory: string | undefined, filename: string): string {
  validateBootstrapFilename(filename);
  const dir = (workingDirectory || '').trim();
  return path.join(dir || DEFAULT_COWORK_WORKSPACE, filename);
}

export function readBootstrapFile(workingDirectory: string | undefined, filename: string): string {
  const filePath = resolveBootstrapFilePath(workingDirectory, filename);
  return readFileOrEmpty(filePath);
}

export function writeBootstrapFile(workingDirectory: string | undefined, filename: string, content: string): void {
  const filePath = resolveBootstrapFilePath(workingDirectory, filename);
  ensureDir(filePath);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`${TAG} writeBootstrapFile: wrote ${filename} (${content.length} chars) to ${filePath}`);
}

export function ensureDefaultIdentity(workingDirectory: string | undefined): void {
  const filePath = resolveBootstrapFilePath(workingDirectory, 'IDENTITY.md');
  const existing = readFileOrEmpty(filePath);
  if (existing.trim()) return;
  const defaultContent = getDefaultIdentity();
  ensureDir(filePath);
  fs.writeFileSync(filePath, defaultContent, 'utf8');
  console.log(`${TAG} ensureDefaultIdentity: wrote default IDENTITY.md to ${filePath}`);
}

// ---------------------------------------------------------------------------
// Workspace change sync
// ---------------------------------------------------------------------------

export function syncMemoryFileOnWorkspaceChange(
  oldWorkingDirectory: string | undefined,
  newWorkingDirectory: string | undefined,
): { synced: boolean; error?: string } {
  const oldPath = resolveMemoryFilePath(oldWorkingDirectory);
  const newPath = resolveMemoryFilePath(newWorkingDirectory);

  if (oldPath === newPath) {
    console.log(`${TAG} Workspace sync: same path, skipping`);
    return { synced: false };
  }

  console.log(`${TAG} Workspace sync: ${oldPath} → ${newPath}`);

  try {
    const oldContent = readFileOrEmpty(oldPath);
    if (!oldContent.trim()) {
      console.log(`${TAG} Workspace sync: old MEMORY.md empty or missing, skipping`);
      return { synced: false };
    }

    const oldEntries = parseMemoryMd(oldContent);
    if (oldEntries.length === 0) {
      console.log(`${TAG} Workspace sync: old MEMORY.md has no entries, skipping`);
      return { synced: false };
    }

    const newEntries = readMemoryEntries(newPath);
    const newIds = new Set(newEntries.map((e) => e.id));

    let added = 0;
    for (const entry of oldEntries) {
      if (newIds.has(entry.id)) continue;
      newEntries.push(entry);
      newIds.add(entry.id);
      added++;
    }

    if (added > 0) {
      writeMemoryEntries(newPath, newEntries);
    }

    console.log(`${TAG} Workspace sync: done — copied ${added} new entries (old=${oldEntries.length}, new total=${newEntries.length})`);
    return { synced: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${TAG} Workspace sync: FAILED —`, message);
    return { synced: false, error: message };
  }
}
