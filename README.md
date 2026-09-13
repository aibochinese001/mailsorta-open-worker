# MailSorta Worker · 邮件整理 SaaS

部署在 Cloudflare Workers 上的**多租户邮件整理 SaaS**：接入 **Gmail / Outlook / Agently Mail（QQ 新推出的 Agent 专属邮箱）**，按"发件人规则"定期抓取邮件、按�[...]

> 📚 **图文部署教程**：https://opcgrow.org/article.php?id=130

## 功能

### 邮件整理（核心）
- **多源接入**：Gmail（Google OAuth2）、Outlook（Microsoft Graph OAuth2）、Agently Mail（微信扫码 OAuth，经本地桥接层）、QQ/网易 163/126（IMAP 授权码，经桥接层代��[...]
- **规则引擎**：发件人精确 / 域名 / 正则三种匹配；每条规则独立字段配置
- **自定义字段提取**：邮件头字段、正文正则（命名捕获组）、可选 LLM 提取（OpenAI 兼容端点）
- **两种调度**：`interval`（按间隔分钟整理）/ `on_receive`（收到即整理，Cron + Webhook 双通道）
- **去重入库**：`(账号, 规则, 消息ID)` 唯一索引，同邮件只入一次
- **查询与导出**：组合筛选 + 分页查询；Excel(.xlsx)/CSV 导出，大数据走 R2 异步下载

### 多租户与商业化
- **注册 / 登录 / 忘记密码**：邮箱验证码（KV 存储，TTL 5 分钟），PBKDF2-SHA256 60 万次迭代存密码
- **新用户默认 30 天免费试用**：试用期与付费会员同配额；到期自动降级免费（1 账号 / 5 规则）
- **会员套餐**：月付 / 季付 / 年付 / 永久，USD 标价，管理后台可增删改上下架
- **易支付收款（USD 直接计价）**：套餐按 USD 标价，下单金额原样传给易支付（微信/支付宝通道自带汇率换算，不做 USD→CNY 折算）；异步通知验签 [...]
- **四种支付方式（管理员后台勾选）**：支付宝 `alipay`、微信 `wxpay`、USDT `gmpay`、Stripe 法币 `fiatstripe`
- **QQ SMTP 邮件**：注册/重置验证码邮件、支付成功通知邮件；未配置时返回 devCode 便于本地开发
- **管理后台**：统计（用户/付费/订单/收入）、用户管理（禁用/角色/送会员）、套餐管理、订单管理、系统设置（SMTP/易支付/配额/注册开关/汇率）
- **多租户数据隔离**：所有业务数据按 `user_id` 隔离，OAuth 账号归属发起用户；管理员由「管理员邮箱白名单」单独授予（`ADMIN_EMAILS` 环境变量或管��[...]

## 架构

```
Gmail ─┐   Google OAuth2 · Gmail API
Outlook─┼─► 连接器(统一只读契约) ─► 同步编排器 ─► 字段提取引擎 ─► D1 入库(user_id 隔离)
Agently┘   CLI/HTTP 桥接层           │  去重/游标/限流   │ 头部/正则/LLM
                                     └── 触发：Cron(1min) · Webhook · 手动API
                                     └── 输出：REST API ─► Vue3 前端 ─► 导出 Excel/CSV
                                                    ┌─ 注册/登录/验证码 ─► 会话 Cookie
多租户层（新增）：users/plans/orders/settings ─► 会员判定/配额 ─► 易支付(USD 直接收款) ─► SMTP
管理员：/api/admin/*（requireAuth + requireAdmin）── 统计/用户/套餐/订单/设置
```

## 目录结构

```
mailsorta-open-worker/
├── wrangler.jsonc            # Workers 配置（D1/KV/R2/Cron/assets）
├── migrations/
│   ├── 0001_init.sql         # 表结构（accounts/rules/emails/sync_logs）
│   └── 0002_users_billing.sql# 多租户/用户/套餐/订单/设置 + 既有表加 user_id
├── src/
│   ├── index.ts              # 入口：路由 + scheduled 定时任务
│   ├── env.ts                # 绑定与 Secrets 类型
│   ├── middleware/           # 会话鉴权(requireAuth/requireAdmin) / 错误 / 限流
│   ├── db/                   # D1 查询层（users/plans/orders/settings/业务表）
│   ├── crypto/               # password(PBKDF2) / token(AES-GCM) / md5
│   ├── billing/service.ts    # 会员判定 / 试用 / 配额 / 套餐时长叠加
│   ├── payment/epay.ts       # 易支付签名 / 下单 / 验签 / 汇率
│   ├── email/smtp.ts         # 零依赖 SMTP（cloudflare:sockets）+ 模板
│   ├── connectors/           # gmail / outlook / agently 连接器 + 注册表
│   ├── oauth/                # 三家授权流（start/callback/status）
│   ├── sync/                 # 编排器 / 提取器 / 调度裁决 / 限流
│   ├── export/xlsx.ts        # SheetJS 导出（按用户分目录存 R2）
│   └── api/                  # REST 路由（auth/billing/admin/accounts/rules/emails/sync/export/webhooks）
├── bridge/                   # 本地桥接层（Node）：Agently CLI 封装 + IMAP 代理（QQ/163/126）
├── frontend/                 # Vue3 + Vite 管理台（登录/套餐/管理后台）
├── scripts/                  # 密码哈希 / 加密密钥生成 / 一键初始化
└── test/                     # Vitest 单元 + API 集成测试（36 用例)
```

## 快速开始（本地开发）

前置：Node ≥ 18.17、npm、已登录 Cloudflare 账号（部署时需要）。

```bash
# 1. 安装依赖
npm install
cd frontend && npm install && cd ..

# 2. 本地配置
cp .dev.vars.example .dev.vars
npm run key:generate          # 生成 TOKEN_ENCRYPTION_KEY，填入 .dev.vars
# SESSION_SECRET 建议填入随机长字符串（本地可留空，但会有警示）

# 3. 本地起 D1 + Worker（首次自动建库跑迁移）
npm run dev

# 4. 另开终端起前端（代理 /api 到 8787）
cd frontend && npm run dev    # http://localhost:5173

# 5. 注册账号。管理员不自动产生：在 wrangler.jsonc 的 vars 里配置 ADMIN_EMAILS（逗号分隔的管理员邮箱白名单），
#    用白名单中的邮箱注册即自动授予 admin；也可注册后在管理后台「系统设置 → 管理员邮箱白名单」维护。
#    SMTP 未配置时验证码会显示在页面提示里（devCode）
```

## Cloudflare 资源创建与部署

```bash
# D1 数据库
npx wrangler d1 create mailsorta-db
#   → 把返回的 database_id 填入 wrangler.jsonc 的 d1_databases[0].database_id
npx wrangler d1 migrations apply mailsorta-db   # 执行 0001 + 0002

# KV 命名空间
npx wrangler kv namespace create MAILSORTA_KV
#   → 把返回的 id 填入 wrangler.jsonc 的 kv_namespaces[0].id

# R2 桶（大导出文件）
npx wrangler r2 bucket create mailsorta-exports

# Secrets（生产）
npx wrangler secret put SESSION_SECRET      # 必填！会话签名密钥
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put MICROSOFT_CLIENT_ID
npx wrangler secret put MICROSOFT_CLIENT_SECRET
npx wrangler secret put AGENTLY_BRIDGE_URL
npx wrangler secret put AGENTLY_BRIDGE_TOKEN
# LLM 字段提取为「用户级配置」：每个用户在自己的账户设置 → AI 提取模型 中填写，
# 无需全局 Secret；API Key 使用 TOKEN_ENCRYPTION_KEY 加密落库（必配）：
npx wrangler secret put TOKEN_ENCRYPTION_KEY   # base64 32 字节，scripts/gen-encryption-key.mjs 可生成

# vars（wrangler.jsonc 中修改）
#   APP_BASE_URL 改为你的生产域名，如 https://mail.example.com（支付回跳/通知回调依赖它）

# 构建前端并部署
cd frontend && npm run build && cd ..
npx wrangler deploy
```

> 免费计划注意：Cron 最小间隔为 1 小时，"收到即整理"会退化为小时级。
> 兜底方案：用 UptimeRobot 等每 1 分钟 ping `https://你的域名/api/sync/run`（POST，需带登录态），
> 或升级 Workers Paid（Cron 最小 1 分钟，本仓库按此设计）。

## 上线前配置清单（管理后台 → 系统设置）

0. **邮箱接入（OAuth 凭据，可选）**：`google_client_id/secret`（Gmail）、`microsoft_client_id/secret`（Outlook）、`agently_bridge_url/token`（Agently 桥接层）均可直接��[...]
1. **QQ SMTP**：`smtp_host=smtp.qq.com`、`smtp_port=465`、勾选 SSL、`smtp_user=你的QQ邮箱`、`smtp_pass=QQ邮箱授权码`、`smtp_from=站点名`。QQ 邮箱路径：设置 → 账户 [...]
2. **易支付**：`epay_api_url=你的易支付接口地址`、`epay_pid=商户ID`、`epay_key=商户密钥`；勾选需要开放的支付方式（支付宝/微信/USDT/Stripe）。type 调用��[...]
3. **套餐**：在「套餐管理」新建月/季/年/永久套餐（USD 定价）。
4. **配额与注册开关**：可按需调整免费/会员配额、关闭开放注册。

## 会员与支付说明

- 新注册用户 `member_plan=trial`，试用 30 天；到期后自动按 `free` 处理（免费 1 账号 / 5 规则，设置可调）。
- 下单流程：`GET /api/billing/plans`（公开，返回启用套餐 + 启用支付方式）→ `POST /api/billing/checkout`（套餐 USD 原价直接作为易支付收款金额）→ 前端��[...]
- 订单 2 小时未支付自动过期；订单详情接口会先向易支付主动查单，防止通知丢失。
- 未支付订单/到期会员调用创建接口时返回 402「请升级会员」。

## Gmail 接入（Google Cloud Console）

1. 打开 https://console.cloud.google.com → 创建/选择项目 → 启用 **Gmail API**
2. **OAuth 同意屏幕**：External，添加测试用户（你的 Gmail）
3. **凭据 → 创建 OAuth 客户端 ID** → 类型"Web 应用"
   - 授权重定向 URI：`https://你的域名/api/accounts/oauth/gmail/callback`（本地开发为 `http://localhost:8787/api/accounts/oauth/gmail/callback`）
4. 把 Client ID / Secret 写入 Secrets，然后前端"连接 Gmail"扫码授权

## Outlook 接入（Azure 应用注册）

1. https://portal.azure.com → **应用注册** → 新注册（任意名称，支持个人/工作账号）
2. 重定向 URI 类型 Web：`https://你的域名/api/accounts/oauth/outlook/callback`
3. **API 权限** → 添加 `Mail.Read`（委托）与 `offline_access`（自动含）
4. 记录应用(客户端) ID 与客户端密码（Certificates & secrets → 新客户端密码）
5. 可选：连接后点"创建推送订阅"，新邮件由 Graph Webhook 实时触发整理（Worker 自动续期，3 天一期）

## Agently Mail（QQ）接入 —— 本地桥接层

腾讯官方只提供本地 CLI / MCP（无服务端 REST API），因此本仓库自带 `bridge/` 把 CLI 封装成 HTTP 接口：

```bash
# 1. 安装并授权（首次需要微信扫码）
npm install -g @tencent-qqmail/agently-cli
agently-cli auth login

# 2. 安装桥接层依赖（v1.1.0 起含 IMAP 代理，需 imapflow）
cd bridge && npm install

# 3. 启动桥接层（放在本机或一台常开小机器上）
AGENTLY_BRIDGE_TOKEN=你的随机token node index.mjs
# 监听 http://127.0.0.1:9876；若需公网访问，用 frp/cloudflared 隧道暴露 HTTPS，
# 并把 AGENTLY_BRIDGE_URL 指向该地址（Worker 侧会加 Bearer token 鉴权）

# 4. Worker 侧填入 AGENTLY_BRIDGE_URL / AGENTLY_BRIDGE_TOKEN（Secrets）
# 5. 前端"连接 Agently Mail"→ 打开授权链接 → 微信扫码 → 自动完成
```

- 桥接层自动注册 `message +watch` 新邮件推送（`/watch/register`），实现"收到即整理"
- **限流**：官方 10 次/分、200 次/时，Worker 侧按 8 次/分令牌桶留余量
- CLI 子命令若有差异，只需调整 `bridge/index.mjs` 里的 `TOOL_MAP`（以 `agently-cli --help` 为准）
- 官方推荐工作流：QQ 个人邮箱 →「设置-收信规则」→ 按条件**自动转发**到 Agent Mail，再由本服务整理

## QQ / 网易 163 / 126 接入 —— IMAP（经桥接层代理）

Cloudflare Worker 的出站 TCP 到国内邮箱服务器经常超时，因此 IMAP 连接同样**经由桥接层**执行：

- Worker 侧解密授权码后调用 `bridge/` 的 `POST /imap/list`、`POST /imap/get`，桥接层用 imapflow 直连邮箱服务器
- 授权码 AES-256-GCM 加密存 D1，不落明文；桥接层仅在每次调用时收到解密后的授权码（自部署，可信）
- 绑定入口：前端「连接邮箱 → QQ 邮箱 / 网易 163 / 网易 126」，自动带出服务器地址（imap.qq.com / imap.163.com / imap.126.com，993）
- 授权码获取：QQ「设置 → 账号 → 开启 IMAP/SMTP」；163/126「设置 → POP3/SMTP/IMAP → 开启 IMAP」
- 增量拉取：首次默认最近 7 天，之后按 SINCE 游标推进；Worker 侧 6 次/分限流；认证失败自动标记账号过期

## 字段提取配置

每条规则一个 `fields` 数组，每项：

| 字段 | 说明 |
|---|---|
| `key` | 内部键名（小写字母数字下划线） |
| `label` | 导出 Excel 的列名 |
| `source` | `header` 邮件头 / `body_regex` 正文正则 / `llm` AI 提取 |
| `header` | header 模式取值：`from` / `from_name` / `subject` / `date` / `message_id` |
| `pattern` | 正则模式；命名捕获组 `(?<key>...)` 优先，否则取首个捕获组 |
| `required` | 是否必填（目前影响 LLM 提示词与 UI 标记） |

LLM 提取（用户级配置）：用户在「账户设置 → AI 提取模型」填写自己的 OpenAI 兼容端点（API 地址 / 模型 ID / API Key），
处理自己规则中的 `llm` 来源字段。示例：

```
API 地址  https://ark.cn-beijing.volces.com/api/v3
模型 ID   doubao-seed-1-6-250615 / deepseek-chat / gpt-4o-mini
API Key   sk-xxxx（AES-256-GCM 加密落库，需部署 TOKEN_ENCRYPTION_KEY）
```

未配置 LLM 的用户，其 `llm` 来源字段在同步时置空，不影响其他字段；LLM 调用失败同样置空、不阻塞入库。
适合邮件中没有目标关键词、需要语义理解的内容（如提取"船东名称"而正文只有公司名）。

## API 一览（均需登录态，除标注外）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（公开） |
| GET | `/api/settings/public` | 站点公开设置（公开） |
| POST | `/api/auth/send-code` | 发送验证码（公开；register/reset） |
| POST | `/api/auth/register` | 注册（公开；白名单邮箱自动授予 admin，默认 30 天试用） |
| POST | `/api/auth/change-password` | 修改密码（登录态；验证原密码） |
| PATCH | `/api/auth/profile` | 更新昵称（登录态） |
| POST | `/api/auth/login` | 登录（公开） |
| POST | `/api/auth/forgot` | 忘记密码发码（公开） |
| POST | `/api/auth/reset` | 重置密码（公开） |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/auth/me` | 会话 + 会员 + 配额 |
| GET | `/api/billing/plans` | 套餐 + 启用支付方式（公开） |
| POST | `/api/billing/checkout` | 下单，返回易支付跳转地址 |
| GET | `/api/billing/orders` | 我的订单 |
| GET | `/api/billing/orders/:id` | 订单详情（惰性过期 + 主动查单） |
| GET | `/api/billing/me` | 我的会员/配额 |
| POST | `/api/billing/notify` | 易支付异步通知（公开，验签） |
| GET | `/api/billing/return` | 支付回跳（公开，302 到前端） |
| GET | `/api/admin/stats` | 统计（admin） |
| GET/PATCH | `/api/admin/users[/:id]` | 用户列表/修改（admin；支持角色、状态、会员、重置密码） |
| GET/POST/PUT/DELETE | `/api/admin/plans[/:id]` | 套餐管理（admin） |
| GET | `/api/admin/orders` | 订单列表（admin） |
| GET/PUT | `/api/admin/settings` | 设置读写（admin；敏感值掩码） |
| GET | `/api/accounts` | 账号列表 |
| POST | `/api/accounts/oauth/:provider/start` | 发起授权（gmail/outlook/agently） |
| GET | `/api/accounts/oauth/:provider/callback` | OAuth 回调（公开） |
| GET | `/api/accounts/oauth/agently/status?session=` | Agently 授权轮询 |
| POST | `/api/accounts/:id/subscription` | Outlook 创建推送订阅 |
| DELETE | `/api/accounts/:id` | 删除账号（级联删规则/记录） |
| GET/POST/PUT/DELETE | `/api/rules[/:id]` | 规则 CRUD |
| POST | `/api/rules/:id/test` | 试跑字段提取（不改库） |
| GET | `/api/emails?rule_id=&sender=&subject=&date_from=&date_to=&page=&page_size=` | 邮件查询 |
| GET | `/api/emails/:id` | 单封详情 |
| POST | `/api/sync/run` | 手动触发整理 |
| GET | `/api/sync/logs` | 同步日志 |
| GET | `/api/export/xlsx` `/api/export/csv` | 导出（同查询参数） |
| GET | `/api/export/download/:id` | R2 大导出下载 |
| GET/POST | `/api/webhooks/outlook` | Outlook Graph 通知（公开，带验证） |
| POST | `/api/webhooks/agently` `/api/webhooks/agently/auth` | 桥接层推送（公开，Bearer 校验） |

## 测试

```bash
npm test          # Vitest：36 用例（提取/匹配/调度/令牌/Excel/认证/隔离/套餐/支付验签）
npm run typecheck # tsc --noEmit
npm run build     # wrangler 打包校验
```

## 安全说明

- 密码 PBKDF2-SHA256（60 万次迭代）+ 每用户随机盐；会话为 HMAC 签名的 HttpOnly Cookie（`SESSION_SECRET` 生产必配）
- refresh token 用 `TOKEN_ENCRYPTION_KEY`（AES-256-GCM）加密后落 D1；访问令牌存 KV 短 TTL
- OAuth state 绑定用户，回调后账号归属发起用户；所有业务表按 `user_id` 隔离
- 易支付通知验签 + 金额容差校验 + 订单幂等；订单主动查单兜底
- 最小权限 scope：`gmail.readonly` / `Mail.Read`（只读，不涉及发送删除）
- Agently 凭据只存在你自己的桥接层机器上，Worker 无令牌
- 建议再套一层 **Cloudflare Access** 保护管理入口；邮箱内容一律视为不可信输入，仅做正则/LLM 提取
