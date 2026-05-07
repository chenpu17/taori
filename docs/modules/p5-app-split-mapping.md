# P5 App/styles 拆分 · 特性到模块映射

## 涉及模块

| 模块 | 变化 | 责任边界 |
|---|---|---|
| `apps/web` | 拆分 App.tsx 与 styles.css | 内部结构优化，不改变外部行为 |
| `apps/sidecar` | 无变化 | API 合同不变 |
| `packages/shared` | 无变化 | 类型合同不变 |
| `apps/desktop` | 无变化 | Tauri 外壳不受影响 |

## 依赖方向

```text
apps/web/App
  -> app/ChatPanel
  -> chat/timeline/cost/attachments/markdown components
  -> api/shared types
```

## 状态归属

- 首轮不改变状态归属。
- `App.tsx`/`ChatPanel.tsx` 仍持有主运行状态。
- 子组件只接收 props 和回调。

## 合同变化

- 无 HTTP/DB/shared contract 变化。
- DOM testid 必须保持稳定，避免破坏 E2E。

## 风险

- 大文件拆分容易混入行为改动；必须按“移动代码 + 验证”小步进行。
- CSS 拆分会受 import 顺序影响；需要先建立 `styles/index.css` 或在 `main.tsx` 明确顺序。
- 如果一次性抽 store，风险过高；先组件化，再 hook 化。
