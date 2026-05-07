# 15 · Browser-first 发布候选摘要

Status: release candidate evidence
Owner: Taori
Date: 2026-05-06

## 1. 发布边界

本轮发布候选只覆盖浏览器 WebUI + Sidecar 后端的产品闭环。Tauri 桌面壳、系统 Keychain 授权频率和 macOS 弹窗体验保留为 Desktop follow-up，不阻塞 Web 主线。

## 2. 已验证能力

| 能力 | 状态 | 证据 |
|---|---|---|
| 多轮聊天与模型切换 | 通过 | `pnpm verify:web` 全量 E2E |
| ModelCenter 默认模型、排序、降级徽章、批量选择 | 通过 | `m1.8`、`r3.1`、`r5`、`r5-demoted-badge` |
| 停止与续写 | 通过 | `c2-stop-continue.spec.ts` |
| 失败恢复 | 通过 | `m2.1-failure-decision.spec.ts`、`m2.1-skip-tool-recovery.spec.ts` |
| Run Timeline | 通过 | `run-timeline-user-journeys.spec.ts` |
| Cost Dashboard | 通过 | `d1-d2-cost-dashboard-budget.spec.ts` |
| Cost ↔ Run Timeline 双向联动 | 通过 | T28 / T31 定向 E2E |
| 备份导入后继续聊天 | 通过 | `e2-backup-restore.spec.ts` + 真实 Provider artifact |
| 圆桌启动、轮次、总结、Timeline | 通过 | `m3a.*`、`r5-user-journey`、`run-timeline-user-journeys` |
| Help Center 与真实能力诊断入口 | 通过 | `b3-help-center.spec.ts`、`diagnostics.test.ts` |

## 3. 验证命令

- `pnpm verify:browser-rc` · passed，总耗时 269516ms（约 4.50 分钟）。
  - artifact：`/tmp/taori-browser-rc-browser-rc-20260506020212`
  - summary：`/tmp/taori-browser-rc-browser-rc-20260506020212/summary.json`
  - report：`/tmp/taori-browser-rc-browser-rc-20260506020212/report.md`
  - `verify_web`：passed，187 passed，约 4.49 分钟。
  - `verify_real_report`：passed，最近真实 Provider artifact `risk_count=0`。
  - `diff_check`：passed。
- `pnpm verify:web` · 187 passed，约 4.3 分钟。
- `pnpm verify:real:report` · passed。
  - artifact：`/tmp/taori-real-journey-real-20260506000254`
  - report：`/tmp/taori-real-journey-real-20260506000254/real-provider-report.json`
  - `passed_steps=27`
  - `failed_steps=0`
  - `risk_count=0`
- `pnpm --filter @taori/web typecheck` · passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/d1-d2-cost-dashboard-budget.spec.ts --workers=1` · 2 passed
- `node --check scripts/verify-real-journey.mjs` · passed
- `git diff --check` · passed

T32 后新增：

- `pnpm verify:browser-rc`：串行执行 `verify:web`、`verify:real:report`、`git diff --check`，并在 `/tmp/taori-browser-rc-*` 写入每步日志、`summary.json` 和面向发布复盘的 `report.md`。
- `pnpm verify:browser-rc:report`：只读最近 Browser RC artifact，重建并打印 `report.md`，用于发布前快速复盘，不重新跑 E2E。
- 最新通过证据：`/tmp/taori-browser-rc-browser-rc-20260506020212`。

## 4. Known Risks

| 风险 | 当前处理 |
|---|---|
| 真实 Provider 当前可用性会随远端服务变化 | Browser-first 默认用 `verify:real:report` 读取最近 artifact；live 验证需显式执行 `pnpm verify:real` |
| live `verify:real` 可能读取 provider key status | 默认不作为 Web 主线门槛执行；若执行 live 模式，脚本会带 `confirm_keychain=1` 明确进入 Keychain 读取路径 |
| Cost ↔ Timeline 联动需要稳定定位成本调用 | T31 已完成双向跳转，`/v1/costs/calls?cost_record_id=` 可精确返回目标成本记录，不受最近列表窗口限制 |
| Desktop / Keychain 用户体验仍需长期优化 | T30 已让 key-status 在 Keychain 模式下默认拒绝隐式读取；T33 让 `pnpm dev:desktop` 默认走 dev_file keystore，真实 Keychain 需显式 `TAORI_DESKTOP_DEV_KEYSTORE=keychain` |

## 5. 下一步

1. Browser RC 再回归：下一次较大 Web/Sidecar 改动后执行 `pnpm verify:browser-rc`，刷新 `/tmp/taori-browser-rc-*` 证据。
2. T34 · Desktop 安装包签名与持久授权验证：在 release build 上确认 Keychain 授权频率；该项需要显式授权，因为可能触发 macOS Keychain 弹窗。

## 6. Browser RC 再回归 Playbook

触发条件：

- 改动触及 WebUI 主旅程：聊天、ModelCenter、Settings、Control Center、Cost Dashboard、Run Timeline、Help Center。
- 改动触及 Sidecar 主链路：`/v1/chat`、runs、run_events、costs、tools、MCP、roundtable、backup import/export。
- 改动触及 shared schema / API contract / E2E fixtures。
- 发布前需要刷新 Browser-first 证据。

执行顺序：

1. 快速查看最近一次结果：
   - `pnpm verify:browser-rc:report`
2. 如本次改动属于触发条件，执行完整门禁：
   - `pnpm verify:browser-rc`
3. 读取最新 artifact：
   - `ls -td /tmp/taori-browser-rc-* | head -1`
   - `cat /tmp/taori-browser-rc-*/report.md`

通过标准：

- `summary.json.ok=true`
- `verify_web` 通过，Playwright E2E 全绿。
- `verify_real_report` 通过，`risk_count=0`。
- `diff_check` 通过。
- 不触发 Desktop、不触发 live Provider 调用、不读取系统 Keychain。

失败处理：

- 不直接重复跑全量。
- 先查看失败 artifact 中对应步骤日志：`verify_web.log`、`verify_real_report.log` 或 `diff_check.log`。
- 定位后优先跑最小定向验证，例如单个 sidecar test 或单个 Playwright spec。
- 修复后再执行 `pnpm verify:browser-rc` 刷新证据。

证据更新：

- 将最新 artifact 路径、`report.md` 路径、Playwright passed 数、真实 Provider `risk_count` 写回本文件第 3 节。
- 若回归来自较大功能改动，同步更新 `docs/product/14-agent-runtime-v1-plan.md` 对应任务记录。
