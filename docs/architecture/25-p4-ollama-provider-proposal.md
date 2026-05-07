# 25 · P4 Ollama Provider 架构提案

## 当前问题

`ProviderType` 已包含 `ollama`，Onboarding 默认 base URL 为 `http://127.0.0.1:11434/v1`，但 `apps/sidecar/src/providers/registry.ts` 对 `ollama` 没有专用分支。`testProvider` 默认走 OpenAI probe，`listProviderModels` 默认返回空数组，导致本地模型入口不完整。

## 目标

新增 `apps/sidecar/src/providers/ollama.ts`，实现：

- `testOllama(baseUrl)`
- `listOllamaModels(baseUrl)`
- 可选 `normalizeOllamaBaseUrl(baseUrl)`

并在 provider registry 中接入 `ollama` 分支。

## 接口策略

Ollama 同时提供原生 API 与 OpenAI-compatible API：

- 原生：`GET /api/tags`
- OpenAI-compatible：`GET /v1/models`、`POST /v1/chat/completions`

建议：

1. **test/discover 优先使用原生 `/api/tags`**：返回信息更贴近本地模型，且无需 API Key。
2. **chat 继续走现有 OpenAI-compatible 上游路径**：避免重写 streaming 编排。
3. base URL 允许用户填：
   - `http://127.0.0.1:11434`
   - `http://127.0.0.1:11434/v1`
   helper 自动推导原生 API root。

## Provider adapter

```ts
export async function testOllama(baseUrl: string): Promise<ProviderTestResult>
export async function listOllamaModels(baseUrl: string): Promise<DiscoveredModel[]>
```

`testOllama`：

- 请求 `${apiRoot}/api/tags`
- 200 且 `models` 为数组 → ok
- sample_count = models.length
- 连接失败/超时 → `network`
- 其他状态 → `provider`

`listOllamaModels`：

- 把 `/api/tags` 的 `models[].name` 转为 `DiscoveredModel`。
- `provider_model_id` / `model_name` 使用 Ollama model name，例如 `qwen2.5:7b`。
- `display_name` 保留原名。
- `capability` 默认 `chat`，embedding/vision 用名称启发式。
- `price_per_1m_input_tokens` / `price_per_1m_output_tokens` 为 0。
- `supports_tools` 默认 false。
- `supports_vision` 仅名称启发式 true。

## Chat 调用

现有 provider 调用层如果依赖 OpenAI-compatible base URL，保存 provider 时继续使用 `/v1` URL。若用户输入 root URL，Sidecar 在构造 OpenAI provider 时应确保 chat base URL 指向 `/v1`。

需要检查并补齐：

- provider create/update 是否允许空 API Key。
- keychain 写入是否能接受空 key 或跳过写入。
- OpenAI-compatible client 是否允许 Ollama 无 Authorization header；如果 SDK 必须要 key，可使用非敏感占位值 `ollama-local`，但不得提示用户输入真实 key。

## Web 变化

- Onboarding 中 Ollama provider 的 API Key 输入应隐藏或标记“无需 Key”。
- Model Center provider card 显示“本地”标签。
- Discover 失败时提示：
  - “未连接到 Ollama，请先运行 `ollama serve`。”
  - “确认 base URL 为 http://127.0.0.1:11434 或 /v1。”

## 测试

- provider adapter 单测：
  - `/api/tags` 成功。
  - root URL 与 `/v1` URL 都能解析。
  - 连接失败分类为 network。
  - embedding/vision 名称启发式。
- route 测试：
  - `POST /v1/providers/test` 对 `ollama` 不要求 API Key。
  - `GET /v1/providers/:id/discover` 返回本地模型。
- Web E2E：
  - Onboarding 选择 Ollama 时无需填写 Key。
  - discover 后可导入本地模型。

## 风险

- Ollama 模型能力无法完全从名称判断；必须允许用户编辑能力。
- 本地模型速度差异很大；推荐系统应把历史 first token 纳入排序。
- 如果把 root URL 与 `/v1` URL 混用，test 成功但 chat 失败；base URL normalization 必须统一。
