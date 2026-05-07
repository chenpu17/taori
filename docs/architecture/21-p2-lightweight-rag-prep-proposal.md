# 21 · P2 轻量 RAG 预备层变更提案

Status: draft  
Owner: Taori  
Date: 2026-05-06  
Scope: file chunks / SQLite FTS / snippet retrieval / future local embeddings

## 1. 特性到模块映射

| 特性 | `packages/shared` | `apps/sidecar` | `apps/web` | 数据 |
|---|---|---|---|---|
| 文件 chunk | 新增 chunk/search schema | 抽取文本后 chunk + index | 附件索引状态展示 | 新增 `file_chunks` |
| SQLite FTS/BM25 | search result schema | FTS5 查询、BM25 排序、conversation/file 过滤 | 引用片段展示 | 新增 `file_chunk_fts` |
| file_search 工具 | tool schema | Capability Bus 注册 `builtin.file_search` | 工具痕迹显示检索结果 | 复用 chunks/FTS |
| 上下文片段注入 | context source schema 扩展 | build context 时检索 top K snippets | Run Timeline 展示检索片段 | `run_events` payload |

## 2. 当前基础

现有实现已经具备：

- `files` 表：`conversation_id`、`message_id`、`original_path`、`mime_type`、`size_bytes`、`extracted_text`。
- `builtin.file_read`：按 `file_id` 读取文本/PDF，最多返回 200,000 chars，并缓存到 `files.extracted_text`。
- chat 请求准备阶段可解析 PDF 附件。
- tool trace / run timeline 已能展示工具调用。

主要缺口：

- `file_read` 返回整段文本，长文件会拖垮上下文。
- 没有 chunk 表，无法引用局部片段。
- 没有 FTS/BM25，本地搜索只能靠模型读全文。
- 附件注入逻辑仍偏“灌上下文”，不是“按问题检索”。

## 3. 数据模型

新增普通表：

```ts
file_chunks {
  id: string;
  file_id: string;
  conversation_id: string | null;
  message_id: string | null;
  chunk_index: number;
  content: string;
  token_count: number | null;
  char_start: number;
  char_end: number;
  content_hash: string;
  created_at: number;
}
```

新增 FTS5 虚拟表：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS file_chunk_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  file_id UNINDEXED,
  conversation_id UNINDEXED,
  tokenize = 'unicode61'
);
```

索引：

- `file_chunks(file_id, chunk_index)` unique。
- `file_chunks(conversation_id, file_id)`。
- `file_chunks(content_hash)` 用于避免重复写入。

删除策略：

- `file_chunks.file_id` 跟随 `files` 删除级联。
- FTS 由 repo 同步维护；不依赖 SQLite trigger，降低迁移复杂度。

## 4. Chunk 策略

首版 deterministic chunk：

- 目标大小：约 800 tokens。
- overlap：约 120 tokens。
- 先按段落/标题切分，再按 token 上限合并。
- 单 chunk 最大硬限制：1,200 tokens。
- 使用 `@taori/shared` token helper 估算 token。

保留字段：

- `char_start` / `char_end`：用于 UI 高亮和未来导出。
- `content_hash`：用于重复索引保护。

## 5. 检索接口

新增：

```http
POST /v1/files/search
```

请求：

```ts
{
  query: string;
  conversation_id?: string;
  file_ids?: string[];
  limit?: number;              // 默认 6，最大 20
  include_content?: boolean;   // 默认 true
}
```

响应：

```ts
{
  ok: true;
  data: {
    results: Array<{
      chunk_id: string;
      file_id: string;
      conversation_id: string | null;
      chunk_index: number;
      content: string;
      score: number;
      char_start: number;
      char_end: number;
    }>;
  };
}
```

排序：

1. SQLite `bm25(file_chunk_fts)`。
2. 当前会话 chunk 加权提升。
3. 最近上传文件小幅提升。
4. 去重：同一文件相邻 chunk 最多保留 2 个，避免 top K 被同一段淹没。

## 6. 工具与上下文注入

### 6.1 新工具

新增 `builtin.file_search`：

```ts
input: {
  query: string;
  file_ids?: string[];
  limit?: number;
}

output: {
  results: Array<{
    file_id: string;
    chunk_id: string;
    snippet: string;
    chunk_index: number;
  }>
}
```

暴露条件：

- 当前会话存在可检索 chunks。
- 模型支持 tools。
- 会话工具策略未禁用 file capability。

### 6.2 Chat context 注入

当用户请求含附件或会话存在 indexed files：

1. 用最后一条 user message 作为 query。
2. 检索 top K chunks。
3. 构造 system message：

```text
以下是与用户问题相关的本地文件片段。回答时只在确有依据时引用它们。
[file_id=..., chunk=3] ...
```

4. Run Timeline 写 `file.search` 或 `context.file_chunks` 事件，payload 保存 chunk ids、file ids、score，不保存全文。

控制：

- 默认 top K = 6。
- 总注入预算默认不超过当前模型 context window 的 20%，且不超过 4,000 tokens。
- 如果问题与文件无关或 FTS 无结果，不注入。

## 7. 兼容策略

- `builtin.file_read` 保留，继续服务“读完整文件”场景。
- 旧 `files.extracted_text` 继续作为抽取缓存。
- 已有文件在首次检索或首次打开会话时懒索引，不要求迁移时一次性扫全库。
- 无 FTS5 支持时启动自检应失败并提示，因为 SQLite FTS5 是该能力前提。

## 8. 未来 embedding 接口预留

不在首版实现 embedding，但预留：

```ts
interface EmbeddingProvider {
  embedTexts(texts: string[]): Promise<number[][]>;
  dimensions: number;
  modelName: string;
  localOnly: boolean;
}
```

未来新增：

- `file_chunk_embeddings(chunk_id, provider, model, vector_blob, created_at)`。
- 本地 provider 优先：Ollama `nomic-embed-text`、`bge-m3`、`qwen3-embedding`。
- 用户可设置“只本地模型处理文件检索/记忆压缩”。

## 9. 开发顺序

1. Shared：定义 file chunk/search result schema。
2. Sidecar DB：新增 `file_chunks` 与 `file_chunk_fts`，repo 支持 index/search/delete。
3. Sidecar extraction：把 `file_read` 的抽取逻辑抽成 shared extractor，chunker 复用。
4. Sidecar route：`POST /v1/files/search`。
5. Capability Bus：新增 `builtin.file_search`。
6. Chat context：对附件/会话文件注入 top K snippets。
7. Web：附件索引状态、引用片段 UI、tool trace 展示检索结果。
8. Tests：chunker、FTS search、file_search tool、chat context injection。

## 10. 风险

- FTS 对中英文混合检索效果有限：首版接受 BM25 基线，后续用本地 embedding 改善语义召回。
- chunk 注入可能误召回：必须限制 top K 和 token budget，并在回答中标明“依据片段”。
- 大文件索引耗时：采用懒索引和进度提示，不阻塞普通聊天。
- 隐私风险：默认本地 FTS；任何外部 embedding 必须显式开启。

## 11. 验证计划

- Unit:
  - chunker overlap、hash、token cap。
  - FTS 查询能按 query 返回相关 chunk。
  - delete file 后 chunk/fts 同步删除。
- Route:
  - `POST /v1/files/search` 支持 conversation/file filter、limit cap、空结果。
- Tool:
  - `builtin.file_search` 返回 snippet，不返回全文。
- Chat:
  - 长文本附件不会整段注入；只注入 top K chunks。
  - Run Timeline 记录 file chunk context source。
- Type gates:
  - `pnpm build:shared`
  - `pnpm --filter @taori/sidecar typecheck`
  - `pnpm --filter @taori/web typecheck`

