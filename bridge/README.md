# Agently Mail 本地桥接层

把腾讯 Agently Mail 的本地 CLI（`agently-cli`）封装为 HTTP 接口，供 Cloudflare Worker 调用。

## 依赖

```bash
npm install -g @tencent-qqmail/agently-cli
agently-cli auth login     # 首次微信扫码授权
```

## 启动

```bash
cd bridge
AGENTLY_BRIDGE_TOKEN=你的随机token node index.mjs
# 默认 http://127.0.0.1:9876
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `BRIDGE_PORT` | `9876` | 监听端口 |
| `AGENTLY_BRIDGE_TOKEN` / `BRIDGE_TOKEN` | 空（拒绝所有请求） | Worker 侧 Bearer 鉴权 |
| `AGENTLY_CLI` | `agently-cli` | CLI 可执行文件路径 |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活检查 |
| POST | `/rpc` | `{tool, params}` 执行 CLI；tool: `me` / `message.list` / `message.search` / `message.get` |
| POST | `/auth/start` | `{session}` 触发 `auth login`，返回微信扫码链接 `{authUrl, session, urls}`；授权进行中重复调用会复用现有会话（`reused: true`） |
| GET | `/auth/status?session=` | 轮询授权结果 `{status: pending|done|error, email, error?}` |
| POST | `/watch/register` | `{callback, secret}` 启动 `message +watch`，新邮件推送到 callback（带 `x-webhook-secret`）；授权完成也会回调 `callback + /auth` |

## 重要

- **命令映射**：`index.mjs` 底部的 `TOOL_MAP` 是唯一的命令映射点。若与 `agently-cli --help` 输出不一致，只改这里。
- **授权链接提取**：`auth login` 采用 OAuth 设备码模式，输出授权链接后需在浏览器打开并用微信扫码。桥接层按优先级提取链接（微信扫码 URL > OAuth 设备码 URL）
- **授权中单实例**：同一时刻只允许一个 `auth login` 进程，重复发起会复用当前授权链接，避免 CLI 登录态冲突。
- **CLI 未安装**：`/auth/start` 会返回 500 并给出 `npm install -g @tencent-qqmail/agently-cli` 提示。
- **凭据位置**：agently-cli 的登录凭据保存在本机用户目录；桥接层配置（watcher、授权会话）存在 `bridge/data/config.json`（已 gitignore）。
- **限流**：官方 10 次/分、200 次/时，Worker 侧已按 8 次/分令牌桶留余量。
- 公网可达时（如 cloudflared/frp 隧道），把 HTTPS 地址配到 Worker 的 `AGENTLY_BRIDGE_URL`，即可实现 Worker → 桥接层 → Agently 全链路。
