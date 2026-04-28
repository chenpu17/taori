# 05 · 安全设计

## 安全模型

本产品是**本地工具 + BYOK**形态，安全边界相对清晰：

- 不收集用户数据上传云端
- API Key 由用户自带，由本产品负责安全存取
- 攻击面主要是：本机其他进程、被恶意网页诱导调用本地 Sidecar、本地数据被物理盗取

## API Key 存储

| 项目 | 决策 |
|---|---|
| 存储位置 | **OS Keychain**（macOS Keychain / Windows Credential Manager / Linux Secret Service）|
| 实现方式 | Tauri 通过 [`keyring`](https://crates.io/crates/keyring) crate 封装；Sidecar 通过 [Sidecar↔Tauri Rust 控制通道](./03-process-and-ipc.md#sidecar--tauri-rust-控制通道m0-第一验收点)（M0 默认方案 A：仅 127.0.0.1 + 独立 Bearer Token 的 Rust 本地 HTTP）调用读写。**Renderer 永不直接接触 Keychain。** |
| 数据库中存什么 | 仅存 `api_key_ref`（Keychain 中的引用键），**绝不存明文** |
| 内存生命周期 | Sidecar 启动时按需从 Keychain 加载到内存，进程退出即销毁 |

## Sidecar 通信安全

- Sidecar 只绑定 `127.0.0.1:0`（系统分配空闲端口），**外部网络不可达**
- 启动时生成 32 字节随机 Bearer Token，仅 Tauri Rust 与 Sidecar 之间传递
- Renderer 通过 `invoke('sidecar_endpoint')` 一次性拿到 `{port, token}`
- 每次 HTTP 请求验证 `Authorization: Bearer <token>`
- Token 不写盘，进程退出即失效

### 防止本机其他进程调用 Sidecar

Token + 随机端口 + 仅 127.0.0.1 已经能阻挡绝大部分攻击。第二阶段可考虑：
- 给 Sidecar 接收的请求加 Origin 白名单
- 用 Unix Domain Socket（macOS/Linux）/ Named Pipe（Windows）替代 TCP，避开端口暴露

## 本地数据加密

| 阶段 | 决策 |
|---|---|
| MVP（M1–M3）| 对话历史明文存 SQLite，**不加密** |
| 第二阶段 | 引入 SQLCipher，主密钥派生自用户登录密码 / OS Keychain |

> 决策依据：MVP 用户群是单用户桌面场景，物理盗取风险低；优先把"看得见的产品价值"做出来。**API Key 永远加密**，对话历史短期不加密可接受。

## 网络出站

- 所有 LLM 调用都从 Sidecar 进程出站
- 用户可在配置中查看每个 provider 的 `base_url`，支持改成代理或自托管反向代理
- 本产品自身**不**做任何遥测/埋点上报（M1–M3）；第二阶段如做匿名遥测，必须默认关闭并独立开关

## 文件访问

- 文件拖入由 Tauri Rust 通过 Tauri allowlist 严格控制可读路径范围
- Sidecar 不直接读用户文件系统；所有文件由 Rust 读完转 base64 后通过 IPC 传递
- 这条边界保证：即使 Sidecar 被攻破，也不能读取任意本地文件

## 失败时的安全语义

- 调用失败时**不在错误提示中暴露 API Key 或完整 URL 参数**（防止用户截图分享时泄露）
- 日志（Pino）默认脱敏 `Authorization` / `api_key` 字段

## 攻击面盘点

| 风险 | 缓解 |
|---|---|
| 本机其他进程访问 Sidecar | Bearer Token + 127.0.0.1 + 随机端口 |
| API Key 泄漏 | Keychain 存储 + 不写日志 + Renderer 仅短暂持有用户输入的明文，**不持久化、不日志、不外发到非本机端点**；落 Sidecar 后立即转写 Keychain |
| 恶意 provider URL（用户配置错） | 列入 base_url 显式提示 + 第二阶段加签名校验 |
| 对话历史泄漏（物理盗取） | 第二阶段 SQLCipher |
| 供应链攻击（依赖被投毒） | pnpm `audit` + lockfile 锁定 + 关键依赖人工 review |
| 渲染层 XSS（用户输入或 LLM 输出注入） | React 默认转义 + Markdown 渲染白名单 + CSP |

## CSP（Content Security Policy）

Tauri 配置严格 CSP：
- `default-src 'self'`
- `connect-src 'self' http://127.0.0.1:*`（仅允许连本地 Sidecar）
- `script-src 'self'`（禁止 inline script）
- LLM 输出走 Markdown 渲染器的安全管道，禁止 raw HTML
