# apps/desktop · MODULE

## 定位

Taori Tauri 桌面外壳，负责启动/守护 Sidecar、暴露 Renderer 获取 Sidecar endpoint 的命令、提供本机 OS 能力通道。

## 主要接口

- Tauri command：`sidecar_endpoint()`。
- Rust localhost control channel：供 Sidecar 读写 OS Keychain。
- Debug-only automation channel：仅在 debug build 且 `TAORI_DESKTOP_AUTOMATION=1` 时启动，用于桌面 WebView UI smoke。
- Desktop shell actions：托盘菜单、托盘点击、全局快捷键触发 `taori:desktop-action` 事件，把“显示/隐藏窗口 / 新对话 / 打开设置 / 使用帮助 / 导入剪贴板”下发给 Renderer。
- Tauri command：`import_clipboard()`，供 Renderer 主动触发桌面剪贴板导入。

## 拥有状态

- Sidecar 进程句柄和 READY endpoint。
- Control channel bearer。
- 桌面窗口生命周期。
- 托盘入口与全局快捷键注册状态。
- 剪贴板读取与导入事件分发。

## 依赖

- `apps/sidecar` 构建产物或 dev entry。
- OS Keychain / Windows Credential Manager / Linux Secret Service。
- Tauri WebView。

## 当前合同变化

- Keychain 继续作为 API Key 安全存储；桌面验证脚本默认不主动读取 Keychain，避免 macOS dev 二进制反复弹授权。
- `pnpm dev:desktop` 默认设置 `TAORI_DESKTOP_DEV_KEYSTORE=dev_file`，让桌面开发模式的 Sidecar 使用 dev_file keystore，避免日常打开桌面壳触发系统 Keychain；显式设置 `TAORI_DESKTOP_DEV_KEYSTORE=keychain` 时才走真实 OS Keychain。
- 新增 debug-only automation channel，生产构建不暴露；用于 `pnpm verify:desktop-ui` 驱动真实 WebView 点击。
- 主窗口关闭时改为隐藏到托盘，不直接退出；退出动作收敛到托盘菜单。
- 新增两个桌面快捷入口：`CmdOrCtrl+Shift+Space` 显示/隐藏 Taori，`CmdOrCtrl+Shift+N` 直接打开新对话。
- 新增桌面剪贴板入口：托盘菜单与 `CmdOrCtrl+Shift+V` 读取系统剪贴板，把文本追加到当前输入框、把截图/图片追加到附件栏；若当前模型不支持视觉能力，Renderer 会自动切到可用视觉模型。
