import React, { useEffect, useState, useCallback } from 'react';
import { i18nService } from '../../services/i18n';
import { kbService, type KBFolder, type KBStats, type KBIndexProgress, type KBConfig, type KBDoc } from '../../services/kb';
import FolderIcon from '../icons/FolderIcon';
import TrashIcon from '../icons/TrashIcon';

const INITIAL_FILES_SHOWN = 10;

const KBManagePage: React.FC = () => {
  const t = (key: string, vars?: Record<string, string | number>) => {
    let s = i18nService.t(key);
    if (vars) Object.entries(vars).forEach(([k, v]) => { s = s.replace(`{${k}}`, String(v)); });
    return s;
  };

  const [folders, setFolders] = useState<KBFolder[]>([]);
  const [stats, setStats] = useState<KBStats>({ total_docs: 0, done_docs: 0, error_docs: 0, total_chunks: 0, error_files: [] });
  const [config, setConfig] = useState<KBConfig>({ trigger_words: '知识库', top_k: '5' });
  const [progress, setProgress] = useState<KBIndexProgress | null>(null);
  const [scope, setScope] = useState('');
  const [scopeGenerating, setScopeGenerating] = useState(false);
  const [folderDocsMap, setFolderDocsMap] = useState<Record<number, KBDoc[]>>({});
  const [expandedAll, setExpandedAll] = useState<Set<number>>(new Set());
  const [showClearConfirm, setShowClearConfirm] = useState<number | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<number | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);

  const refresh = useCallback(async () => {
    const [f, s, c] = await Promise.all([kbService.listFolders(), kbService.getStats(), kbService.getConfig()]);
    setFolders(f);
    setStats(s);
    setConfig(c);
    const docsMap: Record<number, KBDoc[]> = {};
    await Promise.all(f.map(async (folder) => {
      docsMap[folder.id] = await kbService.listDocs(folder.id);
    }));
    setFolderDocsMap(docsMap);
  }, []);

  useEffect(() => {
    void refresh();
    void kbService.getScope().then(setScope);
    const unsub = kbService.onIndexProgress((p) => {
      setProgress(p);
      if (p.done === p.total && p.total > 0 && p.current_file === '') {
        void refresh();
        setProgress(null);
      }
    });
    return unsub;
  }, [refresh]);

  const handleAddFolder = async () => {
    const folderPath = await kbService.selectFolder();
    if (!folderPath) return;
    await kbService.addFolder(folderPath);
    await refresh();
  };

  const handleRemoveFolder = async (folderId: number) => {
    await kbService.removeFolder(folderId);
    setShowDeleteConfirm(null);
    await refresh();
  };

  const handleClearIndex = async (folderId: number) => {
    await kbService.clearFolderIndex(folderId);
    setShowClearConfirm(null);
    await refresh();
  };

  const handleRebuild = async () => {
    setIsRebuilding(true);
    await kbService.rebuild();
    setIsRebuilding(false);
    await refresh();
  };

  const handleSaveConfig = async (partial: Partial<KBConfig>) => {
    setConfig((prev) => ({ ...prev, ...partial }));
    await kbService.setConfig(partial);
  };

  const handleGenerateScope = async () => {
    setScopeGenerating(true);
    const result = await kbService.generateScope();
    if (result) setScope(result);
    setScopeGenerating(false);
  };

  const toggleExpandAll = (folderId: number) => {
    setExpandedAll((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const isIndexing = folders.some((f) => f.status === 'indexing') || (progress !== null && progress.current_file !== '');

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col p-6 max-w-2xl mx-auto gap-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {t('knowledgeBase')}
          </h1>
          <button
            onClick={() => void handleRebuild()}
            disabled={isRebuilding}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors disabled:opacity-50"
          >
            {isRebuilding ? '…' : t('kbRebuild')}
          </button>
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-3 gap-3">
          <div className="dark:bg-claude-darkSurface bg-claude-surface rounded-xl border dark:border-claude-darkBorder border-claude-border px-4 py-3">
            <div className="text-2xl font-bold dark:text-claude-darkText text-claude-text">
              {stats.total_docs}
            </div>
            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">
              {t('kbStatDocs')}
            </div>
          </div>
          <div className="dark:bg-claude-darkSurface bg-claude-surface rounded-xl border dark:border-claude-darkBorder border-claude-border px-4 py-3">
            <div className="text-2xl font-bold dark:text-claude-darkText text-claude-text">
              {stats.total_chunks.toLocaleString()}
            </div>
            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">
              {t('kbStatChunks')}
            </div>
          </div>
          <div className="dark:bg-claude-darkSurface bg-claude-surface rounded-xl border dark:border-claude-darkBorder border-claude-border px-4 py-3">
            <div className="text-2xl font-bold">
              <span className="text-green-500">{stats.done_docs}</span>
              <span className="text-base font-normal dark:text-claude-darkTextSecondary text-claude-textSecondary mx-1">/</span>
              {stats.error_docs > 0
                ? <span className="text-orange-400">{stats.error_docs}</span>
                : <span className="text-base dark:text-claude-darkTextSecondary text-claude-textSecondary">0</span>
              }
            </div>
            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">
              {t('kbStatSuccessFail')}
            </div>
          </div>
        </div>

        {/* Indexing progress bar */}
        {isIndexing && progress && (
          <div className="dark:bg-claude-darkSurface bg-claude-surface rounded-xl border dark:border-claude-darkBorder border-claude-border px-4 py-3">
            <div className="flex justify-between text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
              <span className="truncate max-w-xs">
                {progress.current_file ? progress.current_file.split(/[/\\]/).pop() : '等待中…'}
              </span>
              <span>{progress.done} / {progress.total}</span>
            </div>
            <div className="w-full bg-claude-border dark:bg-claude-darkBorder rounded-full h-1.5">
              <div
                className="bg-claude-accent h-1.5 rounded-full transition-all"
                style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}

        {/* Knowledge Scope */}
        <div className="dark:bg-claude-darkSurface bg-claude-surface rounded-xl border dark:border-claude-darkBorder border-claude-border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b dark:border-claude-darkBorder border-claude-border">
            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {t('kbScope')}
            </span>
            <button
              onClick={() => void handleGenerateScope()}
              disabled={scopeGenerating || stats.total_docs === 0}
              className="px-2 py-1 text-xs font-medium rounded-lg bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20 transition-colors disabled:opacity-40"
            >
              {scopeGenerating ? t('kbScopeGenerating') : scope ? t('kbScopeRefresh') : t('kbScopeGenerate')}
            </button>
          </div>
          <div className="px-4 py-3 border-l-2 border-claude-accent">
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary leading-relaxed">
              {scope || t('kbScopeEmpty')}
            </p>
          </div>
        </div>

        {/* Watched Folders */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {t('kbWatchedFolders')}
            </span>
            <button
              onClick={() => void handleAddFolder()}
              className="px-3 py-1 text-xs font-medium rounded-lg bg-claude-accent text-white hover:bg-claude-accentHover transition-colors"
            >
              + {t('kbAddFolder')}
            </button>
          </div>

          {folders.length === 0 ? (
            <div className="dark:bg-claude-darkSurface bg-claude-surface rounded-xl border dark:border-claude-darkBorder border-claude-border px-4 py-8 text-sm text-center dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {t('kbEmptyHint')}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {folders.map((folder) => {
                const docs = folderDocsMap[folder.id] ?? [];
                const isExpanded = expandedAll.has(folder.id);
                const shown = isExpanded ? docs : docs.slice(0, INITIAL_FILES_SHOWN);
                const hasMore = docs.length > INITIAL_FILES_SHOWN;

                return (
                  <div key={folder.id} className="dark:bg-claude-darkSurface bg-claude-surface rounded-xl border dark:border-claude-darkBorder border-claude-border overflow-hidden">
                    {/* Folder header */}
                    <div className="flex items-start gap-3 px-4 py-3 border-b dark:border-claude-darkBorder border-claude-border">
                      <FolderIcon className="h-5 w-5 mt-0.5 shrink-0 text-claude-accent opacity-80" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                          {folder.path}
                        </div>
                        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">
                          {folder.doc_count ?? 0} {t('kbStatDocs')} ·{' '}
                          {folder.status === 'indexing'
                            ? <span className="text-yellow-500">{t('kbStatusIndexing')}</span>
                            : <span>{t('kbStatusIdle')}</span>
                          }
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {showClearConfirm === folder.id ? (
                          <div className="flex items-center gap-2 text-xs">
                            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{t('kbClearIndexConfirm')}</span>
                            <button onClick={() => void handleClearIndex(folder.id)} className="text-red-500 font-medium">确认</button>
                            <button onClick={() => setShowClearConfirm(null)} className="dark:text-claude-darkTextSecondary text-claude-textSecondary">取消</button>
                          </div>
                        ) : showDeleteConfirm === folder.id ? (
                          <div className="flex items-center gap-2 text-xs">
                            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{t('kbDeleteFolderConfirm')}</span>
                            <button onClick={() => void handleRemoveFolder(folder.id)} className="text-red-500 font-medium">确认</button>
                            <button onClick={() => setShowDeleteConfirm(null)} className="dark:text-claude-darkTextSecondary text-claude-textSecondary">取消</button>
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={() => setShowClearConfirm(folder.id)}
                              className="px-2 py-1 text-xs rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                            >
                              {t('kbClearIndex')}
                            </button>
                            <button
                              onClick={() => setShowDeleteConfirm(showDeleteConfirm === folder.id ? null : folder.id)}
                              className="p-1 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-500 transition-colors"
                            >
                              <TrashIcon className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* File list */}
                    {docs.length > 0 && (
                      <>
                        {shown.map((doc) => (
                          <div
                            key={doc.id}
                            className="flex items-center gap-3 px-4 py-2 border-b dark:border-claude-darkBorder border-claude-border"
                          >
                            <span className={`shrink-0 w-2 h-2 rounded-full ${
                              doc.status === 'done' ? 'bg-green-500' :
                              doc.status === 'error' ? 'bg-orange-400' : 'bg-yellow-400'
                            }`} />
                            <span
                              className="flex-1 text-xs dark:text-claude-darkText text-claude-text truncate"
                              title={doc.file_path}
                            >
                              {doc.file_path.split(/[/\\]/).pop()}
                            </span>
                            {doc.status === 'done' && (
                              <span className="shrink-0 text-xs px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted dark:text-claude-darkTextSecondary text-claude-textSecondary">
                                {t('kbChunkCount', { n: doc.chunk_count ?? 0 })}
                              </span>
                            )}
                            {doc.status === 'error' && (
                              <span className="shrink-0 text-xs text-orange-400" title={doc.error_msg ?? ''}>
                                失败
                              </span>
                            )}
                            {doc.status !== 'done' && doc.status !== 'error' && (
                              <span className="shrink-0 text-xs text-yellow-400">处理中</span>
                            )}
                          </div>
                        ))}
                        {hasMore && (
                          <button
                            onClick={() => toggleExpandAll(folder.id)}
                            className="w-full px-4 py-2.5 text-xs text-center dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                          >
                            {isExpanded ? t('kbCollapse') : t('kbShowAll', { n: docs.length })}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Trigger Words */}
        <section className="dark:bg-claude-darkSurface bg-claude-surface rounded-xl border dark:border-claude-darkBorder border-claude-border px-4 py-3 space-y-2">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {t('kbTriggerWords')}
          </div>
          <input
            type="text"
            value={config.trigger_words}
            onChange={(e) => void handleSaveConfig({ trigger_words: e.target.value })}
            className="w-full px-3 py-2 text-sm rounded-lg dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-1 focus:ring-claude-accent"
          />
          <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {t('kbTriggerWordsHint')}
          </p>
        </section>

      </div>
    </div>
  );
};

export default KBManagePage;
