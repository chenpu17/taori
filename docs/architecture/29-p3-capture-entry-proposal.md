# P3-2 剪贴板 / 截图入口提案

## 背景

P3-1 已经让 Taori 成为桌面常驻入口，但用户仍需要先切回窗口、再手动粘贴内容。P3-2 的目标是把“看到就问”收成更短路径：截图或复制文本之后，直接把内容带进当前问答。

## 设计

### 1. 桌面壳负责读取 OS 剪贴板

- `apps/desktop/src-tauri` 通过系统剪贴板读取文本 / 图片。
- 托盘菜单和全局快捷键 `CmdOrCtrl+Shift+V` 复用同一个桌面动作：`import-clipboard`。
- Renderer 内按钮 `import_clipboard()` 也调用同一条桌面导入链路，避免桌面入口与 UI 入口分叉。

### 2. Renderer 继续拥有聊天状态真相

- Desktop 不直接操作输入框或附件状态。
- Desktop 只发送 `taori:desktop-action` 事件，携带：
  - `clipboard_items[]`：文本或图片载荷
  - `error`：读取失败或空剪贴板提示
- `apps/web/src/App.tsx` 接收后：
  - 文本 → 追加到 composer
  - 图片 / 截图 → 追加到附件栏
  - 若当前模型不支持视觉能力，则沿用现有“自动切换到视觉模型”逻辑

### 3. 验证链路

- `scripts/verify-desktop-ui.mjs` 通过 debug automation channel 先写入剪贴板文本，再触发 `import-clipboard`。
- 验证目标：真实 Tauri WebView 中的 composer 能看到被导入的文本。

## 取舍

- 本轮先做“剪贴板导入”而不额外实现 OS 截屏面板，原因是 macOS/Windows/Linux 原生截屏 API 差异更大，而大量用户已经有“截图到剪贴板”的系统能力。
- 这样能优先交付“截图即问”的主价值，同时保持桌面壳实现简单、跨平台语义一致。
