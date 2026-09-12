/**
 * Worker 环境绑定与 Secrets 的类型定义。
 * 所有 Secrets 通过 `wrangler secret put <KEY>` 注入；vars 在 wrangler.jsonc 中配置。
 * SMTP / 易支付 / 汇率 / 配额等站点配置优先存 D1 settings 表（管理后台可改），
 * 环境变量仅提供部署期默认兜底。
 */
export interface Env {
  // bindings
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  ASSETS: Fetcher;

  // vars
  APP_BASE_URL: string; // 对外域名，如 https://mail.example.com（OAuth 回调 / 支付通知 / Webhook 使用）
  WEBHOOK_ENABLED: string; // 逗号分隔：outlook,agently
  ADMIN_EMAILS?: string; // 管理员邮箱白名单（逗号分隔）；注册命中自动授予 admin。管理后台设置 admin_emails 优先

  // secrets —— 以下全部可缺省（功能级降级），但对应功能不可用
  SESSION_SECRET?: string; // 生产必配：会话签名密钥
  TOKEN_ENCRYPTION_KEY?: string; // OAuth refresh token 加密密钥（base64 32 字节）
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  AGENTLY_BRIDGE_URL?: string;
  AGENTLY_BRIDGE_TOKEN?: string;
}

export type SessionUserInfo = { id: string; role: 'user' | 'admin'; email: string };

export type AppBindings = { Bindings: Env; Variables: { user?: SessionUserInfo } };
