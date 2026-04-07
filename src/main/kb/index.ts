import { EventEmitter } from 'events';
import type { BrowserWindow } from 'electron';
import type { SqliteStore } from '../sqliteStore';
import { KBStore } from './store';
import { KBIndexer, containsTriggerWord, callEmbeddingPublic } from './indexer';
import { KBWatcher } from './watcher';
import type { KBFolder, KBSearchResult, KBStats, KBIndexProgress } from './types';

export class KBManager extends EventEmitter {
  private store: SqliteStore;
  private kbStore: KBStore;
  private indexer: KBIndexer;
  private watcher: KBWatcher;
  private windows: Set<BrowserWindow> = new Set();

  constructor(store: SqliteStore, userDataPath: string) {
    super();
    this.store = store;
    this.kbStore = new KBStore(userDataPath);
    this.indexer = new KBIndexer(store, this.kbStore);
    this.watcher = new KBWatcher(this.indexer);

    this.indexer.on('progress', (progress: KBIndexProgress) => {
      for (const win of this.windows) {
        if (!win.isDestroyed()) {
          win.webContents.send('kb:onIndexProgress', progress);
        }
      }
    });
  }

  async init(): Promise<void> {
    await this.kbStore.init();
    const folders = this.store.listKBFolders();
    for (const folder of folders) {
      this.watcher.watch(folder.id, folder.path);
    }
    console.log(`[KBManager] initialized with ${folders.length} watched folder(s)`);
  }

  registerWindow(win: BrowserWindow): void {
    this.windows.add(win);
    win.on('closed', () => this.windows.delete(win));
  }

  // ── Folder management ──────────────────────────────────────────────────────

  addFolder(folderPath: string): KBFolder {
    const id = this.store.addKBFolder(folderPath);
    this.watcher.watch(id, folderPath);
    console.log(`[KBManager] added folder ${folderPath}`);
    return { id, path: folderPath, created_at: Date.now() };
  }

  removeFolder(folderId: number): void {
    void this.watcher.unwatch(folderId);
    // Cancel any queued-but-not-yet-started items for this folder
    this.indexer.cancelFolder(folderId);
    // Enqueue LanceDB chunk deletion for docs already indexed
    const docs = this.store.listKBDocsByFolder(folderId);
    for (const doc of docs) {
      this.indexer.enqueue(doc.file_path, folderId, 'delete');
    }
    this.store.removeKBFolder(folderId);
    console.log(`[KBManager] removed folder id=${folderId}`);
  }

  clearFolderIndex(folderId: number): void {
    const docs = this.store.listKBDocsByFolder(folderId);
    for (const doc of docs) {
      this.indexer.enqueue(doc.file_path, folderId, 'delete');
    }
    this.store.clearKBDocsByFolder(folderId);
    console.log(`[KBManager] cleared index for folder id=${folderId}`);
  }

  listFolders(): KBFolder[] {
    const folders = this.store.listKBFolders();
    return folders.map((f) => {
      const docs = this.store.listKBDocsByFolder(f.id);
      const indexingCount = docs.filter((d) => d.status === 'indexing' || d.status === 'pending').length;
      return {
        ...f,
        doc_count: docs.length,
        status: (indexingCount > 0 || this.indexer.running ? 'indexing' : 'idle') as 'idle' | 'indexing',
      };
    });
  }

  // ── Rebuild ────────────────────────────────────────────────────────────────

  async rebuild(): Promise<void> {
    const folders = this.store.listKBFolders();
    await this.kbStore.deleteTable();
    await this.kbStore.init();
    for (const folder of folders) {
      this.store.clearKBDocsByFolder(folder.id);
      // Re-watch triggers initial scan via chokidar ignoreInitial:false
      await this.watcher.unwatch(folder.id);
      this.watcher.watch(folder.id, folder.path);
    }
    console.log('[KBManager] full rebuild triggered');
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getStats(): KBStats {
    const stats = this.store.getKBStats();
    const error_files = this.store.listKBErrorDocs();
    return { ...stats, error_files };
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async search(query: string, topK?: number): Promise<KBSearchResult[]> {
    const appConfig = this.store.get<{ cloud?: { deviceId?: string } }>('app_config');
    const deviceId = appConfig?.cloud?.deviceId?.trim() ?? '';
    if (!deviceId) return [];

    const isEmpty = await this.kbStore.isEmpty();
    if (isEmpty) return [];

    const k = topK ?? Number(this.store.get<string>('kb:top_k') ?? '5');
    const [queryVector] = await callEmbeddingPublic([query], deviceId);
    return this.kbStore.search(queryVector, k);
  }

  // ── Scope summary ──────────────────────────────────────────────────────────

  getScope(): string {
    return this.store.get<string>('kb:scope') ?? '';
  }

  async generateScope(): Promise<string> {
    const appConfig = this.store.get<{ cloud?: { deviceId?: string } }>('app_config');
    const deviceId = appConfig?.cloud?.deviceId?.trim() ?? '';
    if (!deviceId) return '';

    const samples = await this.kbStore.sampleChunks(20);
    if (samples.length === 0) return '';

    const context = samples.map((t, i) => `[片段${i + 1}] ${t}`).join('\n\n');
    const prompt = `以下是知识库中随机抽取的文档片段，请根据这些内容，用一到两句话概括这个知识库涵盖的主题和领域。只输出概括内容，不要有前缀或解释。\n\n${context}`;

    try {
      const fetch = (await import('electron')).net.fetch;
      const resp = await fetch('http://1.14.96.63:3000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          stream: false,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!resp.ok) return '';
      const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
      const scope = json.choices?.[0]?.message?.content?.trim() ?? '';
      if (scope) this.store.set('kb:scope', scope);
      return scope;
    } catch (err) {
      console.error('[KBManager] scope generation failed:', err);
      return '';
    }
  }

  // ── Trigger word detection ──────────────────────────────────────────────────

  hasTriggerWord(message: string): boolean {
    const raw = this.store.get<string>('kb:trigger_words') ?? '知识库';
    const words = raw.split(',').map((w: string) => w.trim()).filter(Boolean);
    return containsTriggerWord(message, words);
  }

  async destroy(): Promise<void> {
    await this.watcher.unwatchAll();
  }
}
