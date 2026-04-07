export interface KBFolder {
  id: number;
  path: string;
  created_at: number;
  doc_count?: number;
  status?: 'idle' | 'indexing';
}

export interface KBStats {
  total_docs: number;
  done_docs: number;
  error_docs: number;
  total_chunks: number;
  error_files: Array<{ file_path: string; error_msg: string | null }>;
}

export interface KBIndexProgress {
  total: number;
  done: number;
  current_file: string;
  errors: string[];
}

export interface KBConfig {
  trigger_words: string;
  top_k: string;
  mineru_key: string;
  zhipu_key: string;
}

export const kbService = {
  async addFolder(folderPath: string): Promise<KBFolder> {
    return window.electron.kb.addFolder(folderPath);
  },

  async removeFolder(folderId: number): Promise<void> {
    return window.electron.kb.removeFolder(folderId);
  },

  async clearFolderIndex(folderId: number): Promise<void> {
    return window.electron.kb.clearFolderIndex(folderId);
  },

  async listFolders(): Promise<KBFolder[]> {
    return window.electron.kb.listFolders();
  },

  async rebuild(): Promise<void> {
    return window.electron.kb.rebuild();
  },

  async getStats(): Promise<KBStats> {
    return window.electron.kb.getStats();
  },

  async selectFolder(): Promise<string | null> {
    return window.electron.kb.selectFolder();
  },

  async getConfig(): Promise<KBConfig> {
    return window.electron.kb.getConfig();
  },

  async setConfig(config: Partial<KBConfig>): Promise<void> {
    return window.electron.kb.setConfig(config as Record<string, string>);
  },

  onIndexProgress(callback: (progress: KBIndexProgress) => void): () => void {
    return window.electron.kb.onIndexProgress(callback);
  },
};
