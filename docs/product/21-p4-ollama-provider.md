# 21 · P4 Ollama 真接入

## 背景

Taori 已在 Provider 类型和 Onboarding 中出现 Ollama，但 Sidecar 目前没有专门的 Ollama provider adapter；测试与发现仍走通用 OpenAI-compatible 逻辑或空实现。这会让“本地模型、低成本、隐私优先”的入口看起来存在，实际体验却不稳定。

## 用户价值

- **隐私优先**：敏感项目可以优先走本地模型，不把内容发到外部 provider。
- **低成本试错**：普通总结、改写、记忆压缩、轻量代码问答可用本地模型承担。
- **可发现**：Taori 能自动列出本机 Ollama 已拉取模型，而不是要求用户手输 model name。
- **可解释**：模型中心能明确显示本地模型能力、上下文长度未知/估计、价格为 0。

## 首版范围

### 必须支持

1. `ollama` provider 无需 API Key。
2. Provider test 调用 `GET /api/tags` 或 `/v1/models` 判断本地服务是否可达。
3. Discover 自动导入本地模型列表。
4. Chat 调用走 Ollama OpenAI-compatible `/v1/chat/completions`。
5. 模型默认价格为 0，provider 标记为 local。
6. Onboarding/Model Center 明确提示需要本机 Ollama 正在运行。

### 暂不支持

- 自动安装 Ollama。
- 自动 pull 模型。
- 多机远程 Ollama 管理。
- 精确能力识别（vision/tools/json）全自动判断。
- embedding 模型首版可发现但不默认用于 RAG。

## 默认模型建议

自动发现后可按名称启发式标记：

- chat：`llama*`、`qwen*`、`deepseek*`、`mistral*`、`gemma*`
- embedding：包含 `embed`、`embedding`、`nomic-embed`
- multimodal：包含 `vl`、`vision`、`llava`

启发式必须可由用户在模型编辑器里覆盖。

## 体验原则

- 本地 provider 失败要给出可操作提示：`ollama serve`、检查 `http://127.0.0.1:11434`。
- 不把本地模型神化：推荐时要显示“更隐私/更便宜，但质量和速度取决于本机”。
- 本地模型默认不支持 tools，除非用户手动打开或后续探测确认。
- 记忆抽取/语义压缩的“本地优先模式”后续可优先选择 Ollama chat 模型。

## 验收

- 未运行 Ollama 时，provider test 返回明确错误。
- 运行 Ollama 且至少有一个模型时，discover 返回模型列表。
- 导入模型后普通 chat 能流式回答。
- 成本记录为 0 或接近 0，不计入远程 token 单价。
