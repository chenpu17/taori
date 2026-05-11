# P3 桌面壳入口提案

## 背景

Taori 已经有 Tauri 外壳与 Sidecar 守护能力，但桌面入口仍接近“浏览器模式”：

- 关窗即退出，不适合作为常驻工作台；
- 没有托盘入口，无法低打扰驻留；
- 缺少全局快捷键，无法快速唤起；
- Desktop 侧动作不能直接驱动 Renderer 的新对话 / 设置等 UI。

P3-1 的目标不是再造一层业务逻辑，而是在 **`apps/desktop` 持有 OS 入口能力、`apps/web` 持有 UI 状态真相** 的前提下，把桌面壳补成真正的系统入口。

## 方案

### 1. Desktop 侧新增系统入口

在 `apps/desktop/src-tauri` 中新增：

- 托盘菜单：
  - 显示 / 隐藏 Taori
  - 新对话
  - 打开设置
  - 使用帮助
  - 退出 Taori
- 托盘左键点击：切换主窗口显示状态
- 全局快捷键：
  - `CmdOrCtrl+Shift+Space`：显示 / 隐藏主窗口
  - `CmdOrCtrl+Shift+N`：直接新建对话

### 2. 主窗口关闭语义调整

- 主窗口点击关闭时，不直接退出进程；
- 改为 `prevent_close + hide()`，让 Sidecar 与桌面壳继续驻留；
- 显式退出统一收敛到托盘菜单。

### 3. Desktop → Web 的动作桥接

Desktop 不直接改 Web 内部状态，而是只发统一事件：

- 事件名：`taori:desktop-action`
- 载荷：`{ action, source }`

Web 监听后自行执行：

- `new-chat`
- `open-settings`
- `open-help`

这样保持：

- OS 能力仍归 `apps/desktop`
- UI 状态仍归 `apps/web`
- 不引入新的跨进程状态源

## 验证

使用 debug-only automation channel 新增 desktop action 触发入口，在 `scripts/verify-desktop-ui.mjs` 中验证：

1. 触发 `open-settings` 后，Renderer 中控制中心可见；
2. 触发 `new-chat` 后，已选会话被清空，回到新的聊天态。

## 影响模块

- `apps/desktop`
- `apps/web`
- `docs/modules/inventory.md`
- `apps/desktop/MODULE.md`
