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

## 版本与帮助

```bash
taori --version
taori version
taori --help
taori daemon help
```

当前 CLI 主要提供两类能力：

- 前台直接启动 sidecar HTTP runtime
- 以 daemon 方式在后台常驻运行

## 前台启动

```bash
taori
taori --port 17890
taori serve --host 127.0.0.1 --port 17890
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

## 常用参数

- `--host <address>` 设置监听地址，默认 `127.0.0.1`
- `--port <number>` 设置监听端口，默认 `17890`
- `--db-path <path>` 覆盖 sqlite 数据库路径，默认 `~/.taori/taori.db`
- `--log-file <path>` 仅 `taori daemon start` 可用，覆盖 daemon 日志路径
- `--version` / `-v` 输出当前 CLI 版本
- `--help` / `-h` 输出完整帮助

例如：

```bash
taori --help
taori --version
taori --port 18901
taori --db-path ~/.taori/my-taori.db
taori --host 0.0.0.0 --port 17890
```

## 守护进程模式

如果你希望 npm 安装后的 sidecar 常驻后台运行，可以使用 daemon 生命周期命令：

```bash
taori daemon start --host 0.0.0.0 --port 17890
taori daemon status
taori daemon stop
taori daemon help
```

默认 daemon 状态文件与日志：

```text
~/.taori/taori-daemon.json
~/.taori/taori-daemon.log
```

如果你需要自定义日志路径：

```bash
taori daemon start --log-file /var/log/taori-sidecar.log
```

## 远程服务器 / Web 部署

在远程服务器上，通常需要监听全局地址：

例如：

```bash
taori daemon start --host 0.0.0.0 --port 17890
```

此时：

- `Bind` 会显示 `http://0.0.0.0:17890`
- `Local` 会显示 `http://127.0.0.1:17890`
- `Bearer` 会显示当前 sidecar bearer token
- 远程 Web 前端应连接服务器真实 IP / 域名对应的 `17890` 端口，或经反向代理转发

> `0.0.0.0` 适合服务器部署，但不建议在没有防火墙、反向代理或访问控制的情况下直接暴露公网。业务接口仍依赖 bearer token，请妥善保护。

## CLI 输出里会看到什么

前台启动时，CLI 会输出：

- `Taori sidecar is running at ...`
- `Bind: ...`
- `Port: ...`
- `Host: ...`
- `Bearer: ...`
- `DB: ...`

daemon 启动 / 状态时，CLI 会输出：

- `PID`
- `Bind`
- `Local`
- `Host`
- `Port`
- `Bearer`
- `DB`
- `Log`
