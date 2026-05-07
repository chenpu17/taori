# P2 · 轻量 RAG 预备层 · 特性到模块映射

Status: draft  
Owner: Taori  
Date: 2026-05-06

## 1. 特性边界

- 只做本地文件 chunk + SQLite FTS/BM25。
- 不默认引入外部 embedding。
- 不把跨会话历史默认纳入检索；后续通过显式 `@项目` / `@会话` 打开。

## 2. 模块映射

| 模块 | 改动类型 | 职责 |
|---|---|---|
| `packages/shared` | contract | FileChunk、FileSearchRequest、FileSearchResult schema/type；context source 扩展 |
| `apps/sidecar/src/db/*` | state | 新增 `file_chunks`、`file_chunk_fts`、repo；维护 chunk 与 FTS 同步 |
| `apps/sidecar/src/bus/builtins/file_read.ts` | compatibility | 保留全文读取；抽取逻辑下沉为可复用 extractor |
| `apps/sidecar/src/bus/builtins/file_search.ts` | new capability | 按 query 返回 top snippets，作为长文件默认工具 |
| `apps/sidecar/src/chat/*` | collaboration | 构建上下文时检索片段并注入，记录 Run Timeline |
| `apps/sidecar/src/routes/conversations.ts` / files route | contract | 新增 `POST /v1/files/search`；展示索引状态 |
| `apps/web/src/App.tsx` | UX | 附件索引状态、引用片段展示、工具痕迹显示搜索结果 |
| `apps/web/src/api.ts` | contract consumer | files search API client |
| `docs/product` / `docs/architecture` | governance | 记录 RAG 范围、不做项、状态归属和 embedding 预留 |

## 3. 状态归属

| 状态 | Owner | 说明 |
|---|---|---|
| extracted text | `apps/sidecar` | 继续缓存于 `files.extracted_text` |
| chunk/index | `apps/sidecar` | `file_chunks` 与 `file_chunk_fts` 是检索真相 |
| retrieval snippets | `apps/sidecar` | 每次请求按 query 计算，不由 Renderer 拼接 |
| citation display | `apps/web` | 展示 Sidecar 返回的 file/chunk 引用 |
| embedding provider | future sidecar | 首版仅预留接口，不启用 |

## 4. 依赖方向

- `apps/web` → `apps/sidecar`：查询索引状态和搜索结果。
- `apps/sidecar/chat` → `apps/sidecar/files`：检索 top K snippets。
- `apps/sidecar/bus` → `apps/sidecar/files`：`file_search` 调用 repo，不直接读任意路径。
- `apps/sidecar` → `packages/shared`：使用共享 schema 校验请求/响应。

## 5. 验证责任

| 验证 | Owner | 通过标准 |
|---|---|---|
| Sidecar unit | `apps/sidecar` | chunker、FTS search、delete sync、file_search tool |
| Web E2E | `apps/web` | 长文件提问只注入片段，引用片段可见 |
| Privacy review | `apps/sidecar` | 无 embedding key 时不外发文件内容 |
| Browser RC | scripts | 实现后执行 `pnpm verify:browser-rc` |

