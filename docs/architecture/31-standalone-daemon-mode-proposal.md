# 31 · Standalone Sidecar Daemon 模式提案

Status: draft
Owner: Chenpu
Date: 2026-05-08
Scope: `apps/sidecar` + `apps/web` + `packages/npm` + `docs/modules/inventory.md`

## 1. 问题

当前 npm 发布的 `@chenpu17/taori` 虽然已经支持前台 CLI 与 daemon 方式运行，但对浏览器用户仍不友好：

- 浏览器直接访问只会看到 `Missing or invalid bearer token`
- 普通用户需要手工处理 Bearer Token，心智过高
- standalone 没有同源登录页，也没有最小可用 Web UI 入口

这对两类场景都不友好：

- **远程服务器 / browser-first 部署**：希望 sidecar 常驻后台，并能监听 `0.0.0.0`
- **本机长期运行**：希望像一个轻量本地服务一样启动、查看状态、优雅停止
- **浏览器最终用户**：希望打开地址后先看到登录框，而不是 API 401 JSON

## 2. 影响范围

- 模块：
  - `apps/sidecar`
  - `apps/web`
- 包装 / 分发：
  - `packages/npm`
- 文档：
  - `docs/modules/inventory.md`
  - `apps/sidecar/MODULE.md`
  - `packages/npm/README.md`
  - `docs/architecture/31-standalone-daemon-mode-proposal.md`
- 接口：
  - CLI 新增 `taori daemon start|status|stop`
  - CLI / 运行时新增 `--host <address>`、`--password <value>`
  - Sidecar 新增 `/api/standalone-auth/session|login|logout`
- 状态 / 存储：
  - `~/.taori/taori-daemon.json` 记录 standalone daemon 的 pid / host / port / bearer / db / log
  - `~/.taori/taori-daemon.log` 记录 daemon stdout/stderr
- 部署 / 运维：
  - standalone npm 模式从“仅前台”扩展为“前台 + daemon + 同源 Web UI”
  - 远程部署可显式监听 `0.0.0.0`

## 3. 当前合同

- desktop 模式下，Rust 仍负责 sidecar 的 spawn / 守护，监听保持本机回环地址
- standalone npm 模式下，CLI 现已支持前台启动和 daemon 状态文件，但浏览器访问仍依赖 Bearer Token
- runtime 现已支持 host 配置，但 standalone 没有浏览器登录态

## 4. 拟议变更

- 公共行为变化
  - 保留原有前台启动：`taori [--host ...] [--port ...] [--db-path ...] [--password ...]`
  - 新增 daemon 生命周期：
    - `taori daemon start [--host ...] [--port ...] [--db-path ...] [--password ...] [--log-file ...]`
    - `taori daemon status`
    - `taori daemon stop`
- 运行时变化
  - standalone 运行时新增 `SIDECAR_HOST` 配置，默认仍为 `127.0.0.1`
  - standalone 运行时新增 `TAORI_STANDALONE_ACCESS_PASSWORD` 配置，用于浏览器登录
  - 当 host 为 `0.0.0.0` 时，daemon status 同时展示：
    - `Bind`：实际监听地址
    - `Local`：本机探活地址（`127.0.0.1`）
- 浏览器模式变化
  - npm 包构建时一并产出 `dist-web`
  - Sidecar 在 standalone 模式下直接托管 `/` 登录页、`/app` Web UI 与静态资源
  - 浏览器提交密码到 `/api/standalone-auth/login` 后，由 Sidecar 下发 HttpOnly cookie 会话
  - 普通 REST 与聊天 SSE 允许 Bearer 或 cookie 二选一；脚本模式不受影响
- 状态归属
  - daemon 生命周期状态由 standalone CLI 文件管理；sidecar 本体继续拥有业务数据与运行期状态
- 部署语义
  - desktop 托管语义不变
  - npm standalone 新增“单用户单实例 daemon”语义

## 5. 兼容性

- 向后兼容：是
  - `taori --port 17890` 仍可继续前台运行
  - 默认 host 仍为 `127.0.0.1`
- 新增项
  - 新 CLI 子命令：`daemon start|status|stop`
  - 新 CLI 参数：`--host`、`--password`、`--log-file`
  - 新增 standalone 浏览器登录接口与静态资源托管
- 不涉及
  - 无 SQLite migration
  - 无 shared schema 变化

## 6. 实施计划

1. sidecar runtime 支持可配置 bind host，并在 standalone 输出 bind/local/browser 三个地址
2. CLI 新增 `--password`，维护 standalone 浏览器访问密码
3. Sidecar 新增 standalone 登录页、cookie 会话与静态 Web 托管
4. web renderer 支持同源 cookie 模式
5. npm 构建产出 `dist-web`
6. 更新 `apps/sidecar/MODULE.md`、`apps/web/MODULE.md` 与 `docs/modules/inventory.md`
7. 补 sidecar 单测、npm 构建与浏览器 smoke 验证

## 7. 验证计划

- 单元 / 模块测试：
  - `pnpm --filter @taori/sidecar exec vitest run test/standalone-cli.test.ts`
- 类型 / 构建：
  - `pnpm --filter @taori/sidecar typecheck`
  - `pnpm build:npm`
- CLI smoke：
  - `node packages/npm/dist/cli.cjs --host 127.0.0.1 --port <port> --password <pwd>`
  - `curl http://127.0.0.1:<port>/`
  - `curl -X POST http://127.0.0.1:<port>/api/standalone-auth/login ...`
  - `node packages/npm/dist/cli.cjs daemon start --host 127.0.0.1 --port <port> --password <pwd>`
  - `node packages/npm/dist/cli.cjs daemon status`
  - `node packages/npm/dist/cli.cjs daemon stop`

## 8. 风险

- **误暴露公网**
  - `0.0.0.0` 适合远程服务器，但不应在未加防火墙 / 反向代理 / 访问控制时直接暴露公网
  - 缓解：README 明确提醒；默认值仍保持 `127.0.0.1`；浏览器模式推荐始终设置 `--password`
- **cookie 会话被误当成桌面鉴权替代**
  - standalone cookie 只服务浏览器入口，不替代 desktop 侧 Bearer / 控制通道语义
  - 缓解：保持双模；脚本与自动化继续走 Bearer
- **state 文件陈旧**
  - daemon 异常退出可能遗留 pid/state 文件
  - 缓解：`status` / `start` / `stop` 都会清理 stale state
- **多实例管理复杂度**
  - 本提案只支持单用户单实例 daemon，不覆盖多实例编排
  - 缓解：保留前台模式；多实例需求后续单独提案

## 9. 未决问题

- 本次不做 launchd/systemd installer 集成，只提供跨平台 detached daemon CLI
- 本次不做多实例命名空间（例如按 port 管理多个 daemon）

## 10. 决策

- [ ] Approved
- [ ] Rejected
- [ ] Needs revision

Decision notes:

- 先用最小跨平台 CLI 方案覆盖远程部署与本机常驻，再视反馈决定是否追加系统服务集成。
