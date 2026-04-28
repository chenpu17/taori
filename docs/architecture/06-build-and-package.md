# 06 · 构建与打包

## 开发环境

```bash
pnpm install
pnpm --filter @taori/sidecar build:watch  # Sidecar TS → JS
pnpm --filter @taori/desktop tauri dev    # 启动 Tauri（自动启动 Sidecar 与 Vite）
```

> Tauri 的 `beforeDevCommand` 配置 Vite 启动；Sidecar 通过 Tauri `externalBin` 在开发模式下指向本地 dev script。

## 生产打包

### Sidecar 打包成单一可执行文件

候选方案：

| 方案 | 优点 | 缺点 |
|---|---|---|
| **Node SEA + esbuild bundle** ✅ **首选** | 官方支持、Node 主线兼容；与 better-sqlite3/N-API 兼容性可预期；可控 | 单文件相对较大；需要把 native `.node` 文件随 binary 附带 |
| `bun build --compile` | 速度快、产物小、原生 TS | **对 N-API native 模块（含 better-sqlite3）兼容不稳定**，社区有多个未解 issue（[WiseLibs/better-sqlite3 issues 检索 "bun"](https://github.com/WiseLibs/better-sqlite3/issues?q=bun)）；Bun 仍在快速演进 |
| `pkg`（Vercel） | 成熟稳定 | 已停止维护 |
| `nexe` | 老牌 | 启动慢，更新不勤 |

**首选 Node SEA**，备选 `bun build --compile`（仅在 SEA 验收受阻时启用）。

> **关键风险（M0 spike 必须验证）：** better-sqlite3 是 N-API native 模块，必须按 `target_platform × target_arch` 预编译；任何打包方案都必须能正确**附带** `better_sqlite3.node`，并保证 SEA/可执行文件启动时能定位到它。M0 spike 验收点：在 macOS arm64 / x64、Windows x64 上，sidecar 二进制能正常打开 SQLite 并执行迁移。
>
> 若 Node SEA 在 native 加载上失败、或 `bun compile` 在某平台失败，回退方案是**直接打包整个 `node_modules`**（不做单文件压缩），由 Tauri `externalBin` 嵌入整个目录。这是最坏情况下仍可发布的兜底。

### Tauri 打包

通过 `externalBin` 配置把 Sidecar 二进制嵌入 Tauri 安装包：

```json
// tauri.conf.json (片段)
{
  "productName": "Taori",
  "identifier": "app.taori.desktop",
  "bundle": {
    "externalBin": [
      "binaries/taori-sidecar"
    ]
  }
}
```

构建命令：
```bash
pnpm --filter @taori/sidecar build:bin    # 生成各平台二进制 → binaries/
pnpm --filter @taori/desktop tauri build  # 打安装包
```

### 各平台产物

| 平台 | 格式 |
|---|---|
| macOS | `.app` / `.dmg`（universal binary：x64 + arm64） |
| Windows | `.msi` / `.exe`（NSIS） |
| Linux | `.AppImage` / `.deb` |

## 包大小预估

- Tauri 外壳：~10 MB
- Sidecar（含 better-sqlite3）：~20–40 MB
- 总计：**30–50 MB**

对比 Electron 同类产品通常 100MB+，Tauri 优势明显。

## CI/CD（M0 后）

- GitHub Actions 矩阵：macOS / Windows / Linux
- 每平台独立打 sidecar bin + Tauri 包
- macOS 需要 Apple Developer 证书做 codesign + notarization（第二阶段处理）
- Windows 需要 EV 证书做签名（第二阶段，可先用自签名 + 警告）

## 升级机制

- Tauri 内置 [updater](https://tauri.app/v1/guides/distribution/updater)，从 GitHub Release 拉签名包
- 升级粒度：整包替换（Sidecar bin 与 Tauri exe 一起换）
- 第二阶段考虑增量升级 / 仅更新 Sidecar

## 数据库迁移

- Drizzle Kit 生成 migration SQL
- Sidecar 启动时自动应用未执行的 migration
- 失败时回滚到上一版本数据库副本（启动时备份一次）

## 资源清理

- 卸载时保留用户数据（Keychain Key + SQLite）—— 避免误删
- 用户主动清理 → 设置中提供"导出 + 删除全部数据"按钮
