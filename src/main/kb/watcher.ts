import chokidar, { type FSWatcher } from 'chokidar';
import path from 'path';
import { KB_SUPPORTED_EXTENSIONS } from './types';
import type { KBIndexer } from './indexer';

interface WatchedFolder {
  folderId: number;
  folderPath: string;
  watcher: FSWatcher;
}

export class KBWatcher {
  private watched = new Map<number, WatchedFolder>(); // folderId → entry
  private indexer: KBIndexer;

  constructor(indexer: KBIndexer) {
    this.indexer = indexer;
  }

  watch(folderId: number, folderPath: string): void {
    if (this.watched.has(folderId)) return;

    const watcher = chokidar.watch(folderPath, {
      persistent: true,
      ignoreInitial: false,
      depth: 10,
      ignored: /(^|[/\\])\../,  // ignore dotfiles
    });

    watcher
      .on('add', (filePath) => this.onFileChange(filePath, folderId, 'upsert'))
      .on('change', (filePath) => this.onFileChange(filePath, folderId, 'upsert'))
      .on('unlink', (filePath) => this.onFileChange(filePath, folderId, 'delete'));

    this.watched.set(folderId, { folderId, folderPath, watcher });
    console.log(`[KBWatcher] watching folder ${folderPath}`);
  }

  async unwatch(folderId: number): Promise<void> {
    const entry = this.watched.get(folderId);
    if (!entry) return;
    await entry.watcher.close();
    this.watched.delete(folderId);
    console.log(`[KBWatcher] stopped watching folder ${entry.folderPath}`);
  }

  async unwatchAll(): Promise<void> {
    for (const folderId of this.watched.keys()) {
      await this.unwatch(folderId);
    }
  }

  private onFileChange(filePath: string, folderId: number, action: 'upsert' | 'delete'): void {
    const ext = path.extname(filePath).toLowerCase();
    if (!KB_SUPPORTED_EXTENSIONS.has(ext)) return;
    this.indexer.enqueue(filePath, folderId, action);
  }
}
