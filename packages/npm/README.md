# @chenpu17/taori

Taori 的 standalone sidecar CLI。

## 这是什么

当前 npm 包提供的是 **Taori 本地 sidecar 运行时**。

适合：

- 在本机启动 Taori runtime
- 做本地 API / 自动化 / 集成接入
- 先把运行时服务跑起来，再接自己的前端或工具链

> 当前包内 **不包含完整桌面 UI**。如果你想体验当前最完整的 Taori 交互界面，请到仓库根目录查看 `README.md` 中的 WebUI 使用方式。

## 安装

```bash
npm install -g @chenpu17/taori
```

## 启动

```bash
taori --port 17890
```

启动后默认监听：

```text
http://127.0.0.1:17890
```

探活检查：

```bash
curl http://127.0.0.1:17890/health
```

默认数据库路径：

```text
~/.taori/taori.db
```

## 常用命令

- `--port <number>` set the listening port
- `--db-path <path>` override the sqlite database path

例如：

```bash
taori --help
taori --port 18901
taori --db-path ~/.taori/my-taori.db
```
