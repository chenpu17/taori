# 32. 托管搜索工具与默认搜索提案

## 背景

现有工具页把内置工具、MCP 原始表单、搏查桥接预设堆在一起，普通用户需要理解 `npx mcp-remote`、`command/args/env` 等底层细节，心智负担过高；同时系统没有“默认搜索工具”语义，普通聊天、Quick Compare 与 Roundtable 的联网检索入口不一致。

## 目标

1. 把搏查远程 SSE 搜索收敛成产品化入口，用户只输入 API Key。
2. 保留自定义 stdio/bridge 能力，但下沉到高级区，不污染常用路径。
3. 增加全局“默认搜索工具”，并让聊天、Quick Compare、Roundtable 三条链路保持一致。

## 方案

### 1. 托管远程搜索桥接

- `mcp_servers` 仍沿用现有表结构，不新增 transport 枚举。
- 对“搏查搜索”使用受控占位配置（managed server 语义），只在 Renderer 保存 API Key。
- Sidecar 在运行时把该配置解析成内部 proxy 启动参数，再复用现有 MCP stdio client。
- 普通用户不再接触 `npx mcp-remote` / `--header` 等桥接细节。

### 2. 默认搜索工具

- 复用 `memories(scope='global', key='default_search_tool')` 存储偏好。
- `src/chat/upstream-tools.ts` 统一识别 search-like tool，并在工具目录生成前只保留一个首选搜索工具。
- Quick Compare 与 Roundtable 显式读取同一记忆键，保证工具暴露行为一致。
- 若首选工具不可用，回退到 `builtin.web_search`；若内置搜索也不可用，则回退到当前首个可用搜索工具。

### 3. 工具页分层

- 搜索工具：默认搜索选择器、内置网页搜索状态、搏查搜索托管接入。
- 其他内置工具：保留 file / web fetch / image generate 等开关与健康条。
- 高级 MCP Bridge：本地 stdio、自定义 bridge、runtime/logs、编辑/删除。

## 合同影响

- `apps/web/MODULE.md`：工具页结构与搜索配置入口更新。
- `apps/sidecar/MODULE.md`：托管桥接与 `default_search_tool` 记忆键更新。
- `docs/modules/inventory.md`：补充本提案对应的模块协作变化。

## 非目标

- 不引入通用远程 MCP transport schema。
- 不修改现有 `mcp_servers` SQL 结构。
- 不把默认搜索扩展到文件检索或其他非联网工具。
