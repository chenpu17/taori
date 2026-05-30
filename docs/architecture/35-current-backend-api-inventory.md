# 35 · 当前后端接口清单

> **状态：** current snapshot  
> **日期：** 2026-05-28  
> **来源：** 代码路由声明（`apps/sidecar/src/server.ts`、`apps/sidecar/src/routes/*.ts`、`apps/desktop/src-tauri/src/{control,automation}.rs`）  
> **用途：** 给产品、前端、后端和测试提供“当前真实后端接口”索引。旧版设计合同仍见 [08-api-contracts.md](./08-api-contracts.md)，但该文档已明确存在历史偏差。

## 1. 边界与通用规则

### 1.1 Sidecar 业务 API

Sidecar 是主要业务后端，默认由 Desktop 托管并监听 `127.0.0.1:{port}`；standalone npm 模式可显式改为远程监听。

- `/health`：免鉴权探活。
- `/v1/*`：业务 REST/SSE API，默认要求 `Authorization: Bearer <token>`。
- standalone browser 模式下，浏览器页面也可通过 HttpOnly cookie 访问同源 API；脚本和自动化仍使用 Bearer Token。
- `/v1/chat`、`/v1/runs/:id/continue`、`/v1/runs/:id/recover`、`/v1/quick-compare`、`/v1/quick-compare/:id/retry`、`/v1/roundtable/:id/round`、`/v1/roundtable/:id/round/:round/participant/:index/retry`、`/v1/roundtable/:id/summarize` 为流式或可能流式接口，采用 Vercel AI SDK Data Stream Protocol。

### 1.2 响应包装现状

当前响应包装并未完全统一：

- M1 早期资源多返回裸对象，例如 `{ providers }`、`{ models }`、`{ conversations }`。
- M2+ 新接口多返回 `{ ok, data }`。
- 文件下载 / 导出接口可能直接返回 markdown、CSV、JSON 字符串或附件响应。

前端调用时应以具体路径的 client helper 为准，不要假设全局统一包装。

### 1.3 Desktop 本地通道

Desktop 侧存在两个本地 HTTP 服务，不属于普通业务 API：

- Control channel：Sidecar 调 Desktop，用于 Keychain 等 OS 能力。
- Automation server：测试 / 自动化辅助入口。

这些接口的授权与监听语义见 [03-process-and-ipc.md](./03-process-and-ipc.md) 与 `apps/desktop/MODULE.md`。

## 2. Sidecar API

### 2.1 Health / Selfcheck / Diagnostics

| Method | Path | 说明 | 鉴权 |
|---|---|---|---|
| `GET` | `/health` | Sidecar 探活、版本、uptime、control channel 粗诊断 | 否 |
| `GET` | `/v1/selfcheck` | 应用内自检；`include_keychain=1` 时执行 Keychain probe | 是 |
| `GET` | `/v1/diagnostics/runtime` | 运行时资源诊断 | 是 |
| `GET` | `/v1/diagnostics/real-provider/latest` | 读取最近一次 `pnpm verify:real` 本地产物 | 是 |

### 2.2 Standalone Browser

仅 standalone + browser UI 场景使用。

| Method | Path | 说明 | 鉴权 |
|---|---|---|---|
| `GET` | `/api/standalone-auth/session` | 查询浏览器 cookie 会话状态 | 特例 |
| `POST` | `/api/standalone-auth/login` | 用 standalone password 换取 HttpOnly cookie | 特例 |
| `POST` | `/api/standalone-auth/logout` | 清除 cookie 会话 | 特例 |
| `GET` | `/` | standalone 登录页或 Web UI 入口 | cookie / 页面特例 |
| `GET` | `/app` | standalone Web UI | cookie |
| `GET` | `/*` | standalone 静态资源 / SPA fallback | cookie / 静态资源特例 |

### 2.3 Chat / Run Recovery

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/v1/chat` | 创建或延续聊天回合，持久化用户/助手消息，流式返回模型输出；支持附件、Persona、能力路由、预算确认 |
| `POST` | `/v1/runs/:id/continue` | 对 `incomplete` 助手消息续写，创建 continue 子 run |
| `GET` | `/v1/runs/:id/resume-state` | 查询 run 的可恢复状态与推荐动作 |
| `POST` | `/v1/runs/:id/recover` | 执行 retry / switch_model / compact_context / skip_tool 等恢复动作 |

### 2.4 Providers

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/v1/providers` | 列出 Provider；不返回明文 API Key |
| `GET` | `/v1/providers/key-status` | 查询 provider key 是否可用；Keychain 模式需 `confirm_keychain=1` |
| `POST` | `/v1/providers/test` | 临时测试 provider 配置，或用 `{ provider_id }` 测试已保存 Provider |
| `POST` | `/v1/providers` | 创建 Provider，并把 API Key 写入 keystore |
| `PATCH` | `/v1/providers/:id` | 更新 Provider / API Key |
| `DELETE` | `/v1/providers/:id` | 删除 Provider、Key，并删除其下模型 |
| `DELETE` | `/v1/providers/:id/key` | 只撤销该 Provider 的 Key，不删除 Provider 行 |
| `GET` | `/v1/providers/:id/discover` | 发现 Provider 可用模型 |

### 2.5 Models / Catalog

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/v1/models` | 列出模型 |
| `GET` | `/v1/models/health` | 最近 24h 模型健康聚合 |
| `POST` | `/v1/models/recommendations` | 按任务、能力、健康度和价格推荐模型 |
| `POST` | `/v1/models` | 创建模型 |
| `PATCH` | `/v1/models/:id` | 更新模型配置、价格、能力、thinking 等 |
| `POST` | `/v1/models/:id/default` | 设置某能力的默认模型 |
| `POST` | `/v1/models/:id/reset-health` | 清除自动降级、失败计数与临时停用；不改变手动启停 |
| `DELETE` | `/v1/models/:id` | 删除模型 |
| `POST` | `/v1/models/reorder` | 重排某能力的 fallback 顺序 |
| `POST` | `/v1/models/:id/test` | 对单模型执行可用性探测 |
| `POST` | `/v1/catalog/sync` | 同步 Provider catalog / pricing / capability；可按 `provider_id` 限定 |

### 2.6 Conversations / Messages / Files

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/v1/conversations` | 列出会话；支持 `q` 搜索；默认隐藏 0-message 孤儿会话，`include_empty=1` 可显式包含 |
| `GET` | `/v1/conversations/:id/profile` | 会话上下文画像：当前模型、Persona、工具、附件、成本 |
| `GET` | `/v1/conversations/:id/messages` | 列出消息；返回附件元信息和历史 cost annotations，不返回原始 base64 |
| `GET` | `/v1/conversations/:id/run-events` | 查询会话 run event 时间线 |
| `GET` | `/v1/conversations/:id/runs` | 查询会话 run 摘要列表 |
| `GET` | `/v1/conversations/:id/export` | 导出会话 markdown；可包含 timeline summary |
| `PATCH` | `/v1/conversations/:id` | 更新标题、归档、置顶、标签 |
| `POST` | `/v1/conversations/:id/messages` | 追加非流式 system 消息 |
| `DELETE` | `/v1/conversations/:id` | 删除会话 |
| `PATCH` | `/v1/conversations/:id/messages/:msgId` | 编辑用户消息并截断其后的消息 |
| `POST` | `/v1/conversations/:id/messages/:msgId/branch` | 从指定消息分支出新会话 |
| `GET` | `/v1/files/:id/data` | 读取文件字节并以 base64 返回，主要用于懒加载本地生成图片 |
| `POST` | `/v1/files/search` | 对已落盘文件做轻量 RAG 搜索 |

### 2.7 Costs

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/v1/costs/realtime` | 底部状态栏 / 会话实时成本；可传 `conversation_id` |
| `GET` | `/v1/costs/calls` | 最近模型/工具调用；可按 `cost_record_id` 精确查询 |
| `GET` | `/v1/costs/avg-output` | 指定 `model_id` 的滚动平均输出 token |
| `GET` | `/v1/costs/breakdown` | 成本聚合；支持 `scope`、`conversation_id`、`group_by` |
| `GET` | `/v1/costs/export` | 导出成本报表 CSV / JSON |

### 2.8 Tools / MCP

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/v1/tools` | 列出 Capability Bus 工具 |
| `GET` | `/v1/tools/health` | 最近 24h 工具调用健康聚合 |
| `GET` | `/v1/tools/effective` | 查询会话级工具启用后的有效工具列表 |
| `PUT` | `/v1/tools/:name/enabled` | 设置全局工具启用状态 |
| `PUT` | `/v1/tools/:name/session-enabled` | 设置会话级工具启用覆盖 |
| `POST` | `/v1/tools/invoke` | 直接调用工具并记录工具调用成本 |
| `GET` | `/v1/mcp/servers` | 列出 MCP server |
| `POST` | `/v1/mcp/servers` | 创建 MCP server |
| `PATCH` | `/v1/mcp/servers/:id` | 更新 MCP server，并处理工具注册 / session 重置 |
| `DELETE` | `/v1/mcp/servers/:id` | 删除 MCP server，并注销工具 |
| `POST` | `/v1/mcp/servers/:id/refresh` | 刷新 server 工具清单 |
| `GET` | `/v1/mcp/servers/:id/runtime` | 查询 MCP runtime 状态、日志与已注册工具 |
| `POST` | `/v1/mcp/servers/:id/restart` | 重启 MCP session 并刷新工具 |

### 2.9 Prompt Templates / Personas / Workflow Recipes

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/v1/prompt-templates` | 列出 Prompt 模板 |
| `POST` | `/v1/prompt-templates` | 创建 Prompt 模板 |
| `PATCH` | `/v1/prompt-templates/:id` | 更新 Prompt 模板 |
| `DELETE` | `/v1/prompt-templates/:id` | 删除 Prompt 模板 |
| `GET` | `/v1/personas` | 列出 Persona；首次为空时会种子内置 Persona |
| `POST` | `/v1/personas` | 创建 Persona |
| `PATCH` | `/v1/personas/:id` | 更新 Persona |
| `DELETE` | `/v1/personas/:id` | 删除 Persona |
| `GET` | `/v1/workflow-recipes` | 列出 Workflow Recipe |
| `POST` | `/v1/workflow-recipes` | 创建 Workflow Recipe |
| `PATCH` | `/v1/workflow-recipes/:id` | 更新 Workflow Recipe |
| `DELETE` | `/v1/workflow-recipes/:id` | 删除 Workflow Recipe |
| `POST` | `/v1/workflow-recipes/import` | 导入 Recipe spec |
| `GET` | `/v1/workflow-recipes/:id/export` | 导出 `.taori-recipe.json` |
| `POST` | `/v1/workflow-recipes/:id/apply-preview` | 渲染变量、Persona、工具策略等执行预览 |

### 2.10 Memories

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/v1/memories` | 读取 scoped key/value memory |
| `GET` | `/v1/memories/effective` | 按 session/global 优先级读取有效值 |
| `PUT` | `/v1/memories` | 写入 scoped key/value memory |
| `DELETE` | `/v1/memories` | 删除 scoped key/value memory |
| `GET` | `/v1/structured-memories` | 列出结构化记忆；支持 disabled/deleted 过滤 |
| `PATCH` | `/v1/structured-memories/:id` | 启用 / 禁用结构化记忆 |
| `DELETE` | `/v1/structured-memories/:id` | 软删除结构化记忆 |

### 2.11 Quick Compare

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/v1/quick-compare` | 启动多模型快速对比，流式返回各候选输出 |
| `GET` | `/v1/quick-compare/:id` | 查询对比 run 和 outputs |
| `POST` | `/v1/quick-compare/:id/outputs/:outputId/adopt` | 采纳某个候选回答为会话 assistant 消息 |
| `POST` | `/v1/quick-compare/:id/retry` | 重试某个候选输出，可能流式返回 |

### 2.12 Roundtable

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/v1/roundtable` | 创建圆桌；执行话题分析、参与者选择与成本估算 |
| `GET` | `/v1/roundtable/:id` | 查询圆桌详情、消息与累计成本 |
| `GET` | `/v1/roundtable/:id/history` | 查询同一来源会话下的历史圆桌摘要 |
| `POST` | `/v1/roundtable/:id/template` | 将已完成圆桌总结保存为 Prompt 模板 |
| `POST` | `/v1/roundtable/:id/cancel` | 取消未终态圆桌 |
| `PUT` | `/v1/roundtable/:id/participants` | 第 1 轮前替换参与者列表 |
| `POST` | `/v1/roundtable/:id/loopback` | 把圆桌总结回填为原会话 assistant 消息 |
| `GET` | `/v1/conversations/:id/roundtable` | 查询会话关联的最近圆桌 |
| `POST` | `/v1/roundtable/:id/round` | 启动下一轮圆桌，流式返回参与者输出 |
| `GET` | `/v1/roundtable/:id/participant/:index/retry-candidates` | 查询单个参与者重试候选模型 |
| `PUT` | `/v1/roundtable/:id/round/:round/participant/:index/retry` | 重试单个参与者某轮输出 |
| `POST` | `/v1/roundtable/:id/summarize` | 生成圆桌总结，流式返回 |
| `GET` | `/v1/roundtable/:id/export` | 导出圆桌 markdown |

### 2.13 Deep Research

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/v1/research/sessions` | 列出研究会话 |
| `POST` | `/v1/research/sessions` | 创建研究会话；可能进入 scoping 或异步 planning |
| `GET` | `/v1/research/sessions/:id` | 查询研究详情（session、tasks、sources、claims 等） |
| `GET` | `/v1/research/sessions/:id/tasks` | 查询研究任务列表 |
| `GET` | `/v1/research/sessions/:id/sources` | 查询研究来源列表 |
| `GET` | `/v1/research/sessions/:id/claims` | 查询引用校验后的 claims |
| `POST` | `/v1/research/sessions/:id/plan/revise` | 通过反馈修订 / 生成研究计划 |
| `POST` | `/v1/research/sessions/:id/start` | 确认计划并启动研究 runner |
| `POST` | `/v1/research/sessions/:id/pause` | 暂停研究 |
| `POST` | `/v1/research/sessions/:id/resume` | 恢复研究或重试失败 planning/search |
| `POST` | `/v1/research/sessions/:id/cancel` | 取消研究 |
| `POST` | `/v1/research/sessions/:id/export` | 导出研究结果 |

### 2.14 Admin / Backup

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/v1/admin/clear-all-data` | 清空本地业务数据、文件与 keystore refs |
| `GET` | `/v1/admin/export-data` | 导出备份包；不导出明文 API Key |
| `POST` | `/v1/admin/import-data` | 按策略导入备份包并处理 ID / 冲突 |

## 3. Desktop Local APIs

### 3.1 Control Channel

文件：`apps/desktop/src-tauri/src/control.rs`。Sidecar 用该通道调用 Desktop OS 能力。

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/health` | Control channel 探活 |
| `POST` | `/v1/keychain/write` | 写入 OS Keychain |
| `POST` | `/v1/keychain/read` | 读取 OS Keychain |
| `POST` | `/v1/keychain/delete` | 删除 OS Keychain 条目 |

### 3.2 Automation Server

文件：`apps/desktop/src-tauri/src/automation.rs`。主要供测试与外部自动化使用。

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/health` | Automation server 探活 |
| `POST` | `/v1/clipboard/text` | 设置系统剪贴板文本 |
| `POST` | `/v1/eval` | 执行自动化 eval 请求 |
| `POST` | `/v1/desktop-action/:action` | 触发 Desktop action |
| `POST` | `/v1/result/:id` | 回传自动化结果 |

## 4. 维护规则

1. 新增、删除或改名后端接口时，同步更新本文档。
2. 若变更影响公共请求/响应、鉴权、状态归属或部署语义，同时更新相关 `MODULE.md` 与 `docs/modules/inventory.md`。
3. 若只是内部实现拆分，不改变路径和合同，只需在对应模块合同“当前合同变化”中按需记录。
4. 盘点脚本可用以下只读命令复核 Sidecar 路由：

```bash
node - <<'NODE'
const fs=require('fs'); const path=require('path');
const dir='apps/sidecar/src/routes';
for (const file of fs.readdirSync(dir).filter(f=>f.endsWith('.ts')).sort()) {
  const s=fs.readFileSync(path.join(dir,file),'utf8');
  const re=/app\.(get|post|put|patch|delete)(?:<[^]*?>)?\(\s*['`]([^'`]+)['`]/g;
  let m, rows=[]; while ((m=re.exec(s))) rows.push(`${m[1].toUpperCase()} ${m[2]}`);
  if (rows.length) console.log(`\n${file}\n`+rows.join('\n'));
}
NODE
```
