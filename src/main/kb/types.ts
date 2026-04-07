export interface KBFolder {
  id: number;
  path: string;
  created_at: number;
  doc_count?: number;
  status?: 'idle' | 'indexing';
  last_sync?: number;
}

export interface KBDoc {
  id: number;
  folder_id: number;
  file_path: string;
  file_hash: string | null;
  status: 'pending' | 'indexing' | 'done' | 'error';
  error_msg: string | null;
  chunk_count: number | null;
  updated_at?: number;
}

export interface KBSearchResult {
  file_path: string;
  chunk_index: number;
  text: string;
  score: number;
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

export const KB_SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.docx', '.pptx',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff',
  '.xlsx', '.xls',
  '.md',
]);
