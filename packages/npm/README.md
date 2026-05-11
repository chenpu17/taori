# @chenpu17/taori

Taori 的 standalone sidecar CLI。

## 这是什么

当前 npm 包提供的是 **Taori standalone 运行时 + 浏览器 Web UI**。

适合：

- 在本机或服务器上直接启动 Taori，并从浏览器访问
- 做本地 API / 自动化 / 集成接入
- 先把运行时和 Web UI 跑起来，再按需接自己的工具链

> 当前包内 **不包含 Tauri 桌面壳**，但已包含 standalone 浏览器界面。

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

当前 CLI 主要提供三类能力：

- 前台直接启动 sidecar HTTP runtime
- 直接提供浏览器可打开的 Taori Web UI
- 以 daemon 方式在后台常驻运行

## 浏览器直开

```bash
taori --host 0.0.0.0 --port 4101 --password my-secret
```

启动后，用浏览器访问：

```text
http://<你的服务器IP>:4101/
```

你会先看到登录页，输入 `--password` 设置的访问密码后进入 Taori Web UI。

本机示例：

```bash
taori --host 127.0.0.1 --port 4101 --password my-secret
```

然后打开：

```text
http://127.0.0.1:4101/
```

## 常用参数

- `--host <address>` 设置监听地址，默认 `127.0.0.1`
- `--port <number>` 设置监听端口，默认 `17890`
- `--db-path <path>` 覆盖 sqlite 数据库路径，默认 `~/.taori/taori.db`
- `--password <value>` 设置浏览器登录密码；推荐远程部署时始终设置
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
taori --host 0.0.0.0 --port 4101 --password my-secret
```

## 守护进程模式

如果你希望 npm 安装后的 sidecar 常驻后台运行，可以使用 daemon 生命周期命令：

```bash
taori daemon start --host 0.0.0.0 --port 4101 --password my-secret
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

## API 与探活

浏览器模式之外，sidecar 仍然保留 HTTP API 能力。

探活检查：

```bash
curl http://127.0.0.1:4101/health
```

业务接口仍需要 Bearer Token：

```bash
curl http://127.0.0.1:4101/v1/models \
  -H 'Authorization: Bearer <启动输出里的 Bearer>'
```

## 远程服务器 / Web 部署

在远程服务器上，通常建议：

```bash
taori daemon start --host 0.0.0.0 --port 4101 --password my-secret
```

此时 CLI 会显示：

- `Browser` 浏览器入口
- `Bind` 实际监听地址
- `Local` 本机探活地址
- `Login password` 浏览器登录密码
- `Bearer` 脚本/API 调用用的 token

> `0.0.0.0` 适合服务器部署，但不建议在没有防火墙、反向代理或访问控制的情况下直接暴露公网。至少应设置 `--password`，并建议再配合反向代理或网络访问控制。

## CLI 输出里会看到什么

前台启动时，CLI 会输出：

- `Taori sidecar is running at ...`
- `Bind: ...`
- `Browser: ...`
- `Port: ...`
- `Host: ...`
- `Login password: ...`（如果设置了 `--password`）
- `Bearer: ...`
- `DB: ...`

daemon 启动 / 状态时，CLI 会输出：

- `PID`
- `Bind`
- `Browser`
- `Local`
- `Host`
- `Port`
- `Bearer`
- `DB`
- `Log`
