# apps/desktop · MODULE

## 定位

Taori Tauri 桌面外壳，负责启动/守护 Sidecar、暴露 Renderer 获取 Sidecar endpoint 的命令、提供本机 OS 能力通道。

## 主要接口

- Tauri command：`sidecar_endpoint()`。
- Rust localhost control channel：供 Sidecar 读写 OS Keychain。
- Debug-only automation channel：仅在 debug build 且 `TAORI_DESKTOP_AUTOMATION=1` 时启动，用于桌面 WebView UI smoke。

## 拥有状态

- Sidecar 进程句柄和 READY endpoint。
- Control channel bearer。
- 桌面窗口生命周期。

## 依赖

- `apps/sidecar` 构建产物或 dev entry。
- OS Keychain / Windows Credential Manager / Linux Secret Service。
- Tauri WebView。

## 当前合同变化

- Keychain 继续作为 API Key 安全存储；桌面验证脚本默认不主动读取 Keychain，避免 macOS dev 二进制反复弹授权。
- `pnpm dev:desktop` 默认设置 `TAORI_DESKTOP_DEV_KEYSTORE=dev_file`，让桌面开发模式的 Sidecar 使用 dev_file keystore，避免日常打开桌面壳触发系统 Keychain；显式设置 `TAORI_DESKTOP_DEV_KEYSTORE=keychain` 时才走真实 OS Keychain。
- 新增 debug-only automation channel，生产构建不暴露；用于 `pnpm verify:desktop-ui` 驱动真实 WebView 点击。
