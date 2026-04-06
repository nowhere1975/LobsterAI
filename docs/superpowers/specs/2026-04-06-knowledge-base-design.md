# UdiskAI 知识库模块设计文档

**日期**：2026-04-06  
**范围**：一期 — 本地文档区 + LanceDB 向量索引 + Cowork 集成

---

## 背景与目标

UdiskAI 是 Windows U 盘便携 AI 办公助手，定位政府/企业用户，数据完全本地化。知识库模块允许用户将本地文档纳入语义检索，在 Cowork 对话中显式引用知识库内容获得基于文档的回答。

**核心约束**：
- 数据随 U 盘走，不涉及云端同步
- 单知识库，不支持多知识库切换
- 一期目标文档规模 < 500 份

---

## 一期范围

| 功能 | 是否一期 |
|------|---------|
| 本地文档区（多文件夹，自动监控） | ✅ |
| 支持 PDF / Word / PPT / 图片 / Excel / Markdown | ✅ |
| LanceDB 向量索引 | ✅ |
| 知识库管理 UI | ✅ |
| Cowork 触发词检索集成 | ✅ |
| 重要文件区（手动管理） | ❌ 二期 |
| 单网页抓取（添加网页到知识库） | ❌ 二期 |
| 网页订阅区（整站定期爬取） | ❌ 三期 |
| Embedding 单独计费 | ❌ 二期 |

---

## 架构总览

### 进程分工

```
Renderer                        Main Process
──────────────────────────      ────────────────────────────────
KBManagePage.tsx                src/main/kb/
  管理文件夹、查看索引状态      ├── index.ts      (KBManager - 对外接口)
  触发重建、查看失败文件        ├── indexer.ts    (重计算: chunk/embed/write)
                                ├── store.ts      (LanceDB 查询封装)
                                └── watcher.ts    (chokidar 文件夹监控)

CoworkView.tsx                  src/main/libs/agentEngine/
  用户输入含触发词              └── coworkRunner.ts
                                      调用 KBManager.search() 注入 context
```

### 模块边界设计原则

`indexer.ts` 承载所有重计算逻辑（chunking、API 调用、LanceDB 写入），`index.ts` 只暴露公共接口。未来升级为 Worker Thread（方案 B）或独立进程（方案 C）时，仅需替换 `indexer.ts` 的运行方式，`index.ts` 接口和所有 IPC channel 保持不变，Renderer 零改动。

### 数据存储

| 数据 | 存储位置 |
|------|---------|
| 向量索引 | `data/kb.lance`（LanceDB，随 U 盘） |
| 文件夹配置 | SQLite `kb_folders` 表 |
| 索引元数据 | SQLite `kb_docs` 表 |
| 触发词、Top-K 配置 | SQLite `kv` 表（`kb:*` 前缀） |

---

## 文件类型支持

| 文件类型 | 处理方式 |
|---------|---------|
| PDF | MinerU API |
| Word (.docx) | MinerU API |
| PPT (.pptx) | MinerU API |
| 图片 (.jpg/.png 等，含 OCR） | MinerU API |
| Excel (.xlsx) | 本地 xlsx 库（自行处理） |
| Markdown (.md) | 直接读取，无需外部 API |

**MinerU 风险**：当前免费试用，正式定价未公布。短期直接使用，后续视定价决策是否切换 Docling 自部署方案。

---

## 索引管道

```
文件夹变更（chokidar）或用户手动触发重建
  ↓
watcher.ts 检测新增/修改文件
  ↓
indexer.ts：查 kb_docs 表 file hash
  → 未变化：跳过
  → 已变化/新文件：进入处理队列
  ↓
按文件类型分发：
  MinerU API（PDF/Word/PPT/图片）→ 返回 Markdown
  xlsx 本地库（Excel）→ 结构化文本，表头跟每块数据
  ↓
切块（@langchain/textsplitters）
  PDF/Word/PPT：MinerU 均返回 Markdown，统一用 MarkdownTextSplitter，~500 token，100 token overlap
  Excel：自行实现，每 sheet 独立，表头前置每块，合并单元格展开
  每处理完一个文档执行 await setImmediate()，主进程不阻塞
  ↓
Embedding（智谱 embedding-3 API）批量调用
  ↓
LanceDB 写入（data/kb.lance）
  ↓
更新 kb_docs（hash、分块数、状态、更新时间）
```

### 删除/重命名处理

- 文件删除：从 LanceDB 删除对应向量，从 `kb_docs` 删除记录
- 文件重命名：视为删除旧路径 + 新增新路径

### 错误处理

- MinerU / Embedding API 失败：该文件标记 `status=error`，不阻塞队列
- 复杂 Excel（多级表头、大量合并单元格）降级处理，UI 提示"复杂格式效果可能有限"

---

## 数据模型

### SQLite 新增表

**`kb_folders`**
```sql
CREATE TABLE kb_folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
```

**`kb_docs`**
```sql
CREATE TABLE kb_docs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id   INTEGER NOT NULL REFERENCES kb_folders(id),
  file_path   TEXT NOT NULL UNIQUE,
  file_hash   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending/indexing/done/error
  error_msg   TEXT,
  chunk_count INTEGER,
  updated_at  INTEGER
);
```

### kv 表新增键

| Key | 默认值 | 说明 |
|-----|--------|------|
| `kb:trigger_words` | `"知识库"` | 逗号分隔，支持多个触发词 |
| `kb:top_k` | `"5"` | 检索召回分块数 |

---

## IPC Channels

| Channel | 方向 | 说明 |
|---------|------|------|
| `kb:addFolder` | R→M | 添加监控文件夹 |
| `kb:removeFolder` | R→M | 移除文件夹（保留索引） |
| `kb:clearFolderIndex` | R→M | 清除某文件夹的向量索引 |
| `kb:listFolders` | R→M | 获取文件夹列表及状态 |
| `kb:rebuild` | R→M | 触发全量重建 |
| `kb:getStats` | R→M | 获取文档总数、分块数、失败文件列表 |
| `kb:onIndexProgress` | M→R | 索引进度推送（事件），payload: `{ total: number, done: number, current_file: string, errors: string[] }` |

---

## 知识库管理 UI

### 页面入口

左侧导航栏新增"知识库"图标，与"对话"、"设置"并列。

### 页面结构

```
┌─────────────────────────────────────────────┐
│  知识库                          [重建索引]  │
├─────────────────────────────────────────────┤
│  监控文件夹                      [+ 添加]   │
│  ┌─────────────────────────────────────────┐│
│  │ 📁 D:\Documents\政策文件               ││
│  │    423 份文档 · 最后同步 10分钟前  [×] ││
│  │ 📁 D:\工作\2026                        ││
│  │    87 份文档 · 索引中…          [×]   ││
│  └─────────────────────────────────────────┘│
├─────────────────────────────────────────────┤
│  索引状态                                   │
│  共 510 份文档 · 4,823 个分块               │
│  ⚠ 3 份文件处理失败  [查看详情]            │
├─────────────────────────────────────────────┤
│  触发词设置                                 │
│  [可编辑输入框，逗号分隔，默认"知识库"]     │
└─────────────────────────────────────────────┘
```

### 关键交互

- **添加文件夹**：调用 Electron `dialog.showOpenDialog`，选择文件夹后立即开始扫描
- **删除文件夹**：移除监控，保留已建索引；单独提供"清除该文件夹索引"选项，避免误操作
- **重建索引**：全量重新处理，进度通过 `kb:onIndexProgress` 实时推送
- **失败文件**：展开可查看具体文件名和错误原因

---

## Cowork 集成

### 触发逻辑

`coworkRunner.ts` 在构造 prompt 前检测用户消息是否包含任一触发词。命中则：

1. 用用户消息做向量检索，召回 Top-K 分块（默认 K=5）
2. 将召回内容拼入 system prompt 末尾：

```
--- 知识库相关内容 ---
[来源：政策文件/2026财政预算.pdf，第3页]
...召回文本...

[来源：工作/合同模板.docx]
...召回文本...
--- 知识库内容结束 ---
```

3. 未命中触发词：正常对话流程，零开销

### 界面感知

用户消息气泡下方显示小标签（可折叠展开查看具体来源）：

```
🔍 已检索知识库 · 5 个相关片段
```

### 边界情况

- **KB 为空**：触发词命中但无索引内容，提示用户先完成索引
- **检索无结果**：余弦相似度低于阈值（默认 0.5），不注入，正常对话

---

## 开发优先级（三期规划）

| 阶段 | 内容 |
|------|------|
| 一期 | 本地文档区（PDF/Word/PPT/图片/Excel/Markdown）+ LanceDB + 管理 UI + Cowork 集成 |
| 二期 | 单网页抓取 + 重要文件区（手动管理 UI）+ Embedding 计费接入 |
| 三期 | 网页订阅区（整站定期爬取）|

### 单网页抓取设计（二期）

实现思路极简，无需独立的"网页收藏区"：

1. KB 管理页新增"添加网页"入口，用户粘贴 URL
2. 调用 Firecrawl API 抓取，返回干净 Markdown
3. 将 Markdown 内容以 `{域名}-{页面标题}.md` 文件名保存到用户指定的 KB 文件夹
4. chokidar 自动检测到新文件，走现有索引管道，无需任何额外逻辑

本质上单网页抓取 = **fetch URL → 写 .md 到 KB 文件夹**，完全复用索引管道。

---

## 未来架构升级路径

一期在主进程单线程运行（方案 A），但模块边界按可迁移方式设计：

- **→ 方案 B（Worker Thread）**：将 `indexer.ts` 移入 Worker，接口层和 IPC 不变
- **→ 方案 C（独立进程）**：进一步将 Worker 提升为子进程，同样对外透明

触发时机：文档量超过 500 份，或用户报告索引期间明显卡顿。
