# P4 Ollama Provider · 特性到模块映射

## 涉及模块

| 模块 | 变化 | 责任边界 |
|---|---|---|
| `packages/shared` | 可能补充 local provider 元数据字段 | Provider type 已存在；首版尽量少改 shared |
| `apps/sidecar` | 新增 Ollama provider adapter；registry 分支；允许 no-key provider test/discover/chat | 本地服务探测、模型发现、上游调用适配 |
| `apps/web` | Onboarding/Model Center 对 Ollama 做无需 Key、本地标签、错误提示 | 用户配置与可见反馈 |
| `apps/desktop` | 无首版变化 | 不负责启动 Ollama |

## 依赖方向

```text
apps/web
  -> apps/sidecar providers routes
apps/sidecar
  -> local Ollama HTTP 127.0.0.1:11434
  -> existing OpenAI-compatible chat path
```

## 状态归属

- Provider/model 配置仍归 Sidecar SQLite。
- Ollama 运行状态归用户本机服务；Taori 只探测，不托管。
- API Key 对 Ollama 为空或占位，不写入敏感凭据。

## 合同变化

- `ollama` 从“枚举存在”升级为真实 provider。
- `POST /v1/providers/test` 与 provider create/update 需允许 `type='ollama'` 时无 API Key。
- Discover 返回本地模型列表。

## 风险

- 本地服务不可达是常态，错误提示必须可操作。
- 空 API Key 可能冲击当前 provider schema/keychain 假设，需用 `ollama` 分支隔离。
- OpenAI-compatible `/v1` 与原生 `/api` base URL 需要统一 normalization。
