# AGENTS.md — MailSorta 部署指南（AI / 开发者必读）

MailSorta 是部署在 Cloudflare Workers 上的多租户邮件整理 SaaS：接入 Gmail / Outlook / Agently Mail / QQ 网易 IMAP，按规则提取字段入库（D1），Vue3 前端查询并导出 Excel（R2），支持注册登录、会员套餐、易支付收款、管理后台。

## 1. 快速部署（确定性命令，照单执行）

前置：Node ≥ 18.17、npm、Cloudflare 账号（已登录或 `CLOUDFLARE_API_TOKEN`）。

```bash
# 1) 安装依赖（根 + 前端 + 桥接层）
npm install
cd frontend && npm install && cd ..
cd bridge && npm install && cd ..

# 2) 一键初始化：建 D1/KV/R2 → 回填 wrangler.jsonc → 跑迁移 → 生成 .dev.vars 密钥
npm run setup

# 3) 本地开发
npm run dev                 # Worker :8787（首次自动建本地 D1 + 迁移）
cd frontend && npm run dev  # 前端 :5173（代理 /api → 8787）

# 4) 构建前端并部署
cd frontend && npm run build && cd ..
npm run deploy

# 5) 生产 Secrets（必填 2 个，其余可选）
npx wrangler secret put SESSION_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

部署后打开 `https://<name>.<account>.workers.dev`。首次注册的账号不会自动成为管理员——在
`wrangler.jsonc` 的 `ADMIN_EMAILS`（或管理后台「系统设置」）中配置管理员邮箱白名单，
用白名单邮箱注册即自动授予 admin。

## 2. Token 权限清单（Cloudflare API Token 需勾选）

| 权限 | 级别 | 用途 |
|---|---|---|
| Workers Scripts | Edit | 部署 Worker |
| Workers D1 | Edit | 建库 / 迁移 |
| Workers KV Storage | Edit | 建命名空间 |
| Workers R2 | Edit | 建桶 |
| Account Settings | Read | wrangler 读取账号信息 |
| Workers Routes | Edit | （可选）绑定自定义域名 |

创建位置：https://dash.cloudflare.com/profile/api-tokens → Create Token → 按上表勾选。

## 3. Secrets 清单表

| 变量 | 作用 | 获取方式 | 必填 |
|---|---|---|---|
| `SESSION_SECRET` | 会话 Cookie 签名（HMAC） | 任意随机长字符串（`npm run setup` 自动生成） | ✅ 生产必填 |
| `TOKEN_ENCRYPTION_KEY` | OAuth refresh token / LLM Key 加密（AES-256-GCM，base64 32 字节） | `npm run key:generate`（`npm run setup` 自动生成） | ✅ 生产必填 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail OAuth | Google Cloud Console → OAuth 客户端 | 可选（缺省 Gmail 不可用，其余功能正常） |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Outlook OAuth | Azure 门户 → 应用注册 | 可选（缺省 Outlook 不可用） |
| `AGENTLY_BRIDGE_URL` / `AGENTLY_BRIDGE_TOKEN` | Agently 桥接层地址 / Bearer 鉴权 | 自建 bridge/（见 README「Agently 接入」） | 可选（缺省 Agently 不可用） |

> vars（wrangler.jsonc，非 secret）：`APP_BASE_URL`（生产域名，支付通知/回跳/OAuth 回调依赖，首次部署可用 workers.dev）、`WEBHOOK_ENABLED`、`ADMIN_EMAILS`。
> 另：SMTP / 易支付 / 配额 / 注册开关等在「管理后台 → 系统设置」配置（存 D1），非环境变量。

## 4. 常见报错对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `✖ 未找到 wrangler` | 依赖未装 | `npm install` |
| `REPLACE_WITH_D1_DATABASE_ID` 仍留在配置 | setup 未跑或失败 | `npm run setup`；或手动 `npx wrangler d1 create mailsorta-db` 回填 |
| `You are not authenticated` | 未登录 | `npx wrangler login` 或设置 `CLOUDFLARE_API_TOKEN` |
| 前端 `/api` 404 | frontend/dist 未构建或未构建后部署 | `cd frontend && npm run build && cd .. && npm run deploy` |
| 迁移报错 `table already exists` | 重复执行迁移 | 用 `npx wrangler d1 migrations apply mailsorta-db` 幂等执行（迁移带 IF NOT EXISTS） |
| 部署后打开 404 | workers_dev 被关 / 未部署成功 | 检查 wrangler.jsonc `workers_dev: true`；`npm run deploy` 看输出 |
| Cron 不触发 / 触发频率不符 | 免费计划 Cron 最小 1 小时 | 升级 Workers Paid（Cron 最小 1 分钟），或用 UptimeRobot 每分钟 ping `/api/sync/run` |
| 邮件同步超时（QQ/163） | Worker 出站 TCP 到国内邮箱超时 | 使用 bridge/ IMAP 代理（见 README） |
| Gmail 授权失败 | 重定向 URI 未配置 | Google Console 添加 `https://你的域名/api/accounts/oauth/gmail/callback` |
| 易支付回调不生效 | `APP_BASE_URL` 不是公网可达域名 | 改为你的生产域名（workers.dev 也可但易支付方需能访问） |

## 5. 提交前必做

```bash
npm run scan:secrets   # 敏感扫描，必须 0 命中（会扫描 src/bridge/frontend/test/migrations 等）
npm test               # 36 用例应全部通过
npm run typecheck      # tsc --noEmit 无错误
```

- `.dev.vars`、`bridge/data/`（真实邮件数据与配置）、`frontend/dist`、`node_modules/` 已 gitignore，绝不提交。
- 涉及真实凭据的改动，先改代码再跑 `scan:secrets` 确认。
