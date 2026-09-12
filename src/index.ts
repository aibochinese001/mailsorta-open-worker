import { Hono } from 'hono';
import type { AppBindings, Env } from './env';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { apiRateLimit } from './middleware/rate-limit';
import { requireAdmin, requireAuth } from './middleware/auth';
import { authApi } from './api/auth';
import { billingApi } from './api/billing';
import { adminApi } from './api/admin';
import { accountsApi } from './api/accounts';
import { rulesApi } from './api/rules';
import { emailsApi } from './api/emails';
import { syncApi } from './api/sync';
import { exportApi } from './api/export';
import { webhooksApi } from './api/webhooks';
import { runSyncAll } from './sync/orchestrator';
import { renewExpiringSubscriptions } from './connectors/outlook';
import { publicSettings } from './api/admin';
import { getSetting } from './db/queries';

const app = new Hono<AppBindings>();

app.onError(errorHandler);
app.notFound(notFoundHandler);

app.use('/api/*', apiRateLimit);

// 公共路径（无需登录）：健康检查 / 认证(含验证码) / 套餐浏览 / 支付回调回跳 / Provider Webhook / OAuth 回调 / 公开设置
// 注意：OAuth 仅 callback（浏览器回跳）公开；start/status 需要登录态，不能整体放行
const PUBLIC_PREFIXES = [
  '/api/health',
  '/api/auth/login', '/api/auth/register', '/api/auth/send-code', '/api/auth/forgot', '/api/auth/reset',
  '/api/webhooks',
  '/api/accounts/oauth/gmail/callback', '/api/accounts/oauth/outlook/callback',
  '/api/billing/plans', '/api/billing/notify', '/api/billing/return',
  '/api/settings/public',
];
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) {
    return next();
  }
  return requireAuth(c, next);
});

app.get('/api/health', async (c) => {
  const smtp = !!(await getSetting(c.env.DB, 'smtp_host'));
  return c.json({ ok: true, ts: Date.now(), smtp_configured: smtp });
});

app.get('/api/settings/public', async (c) => c.json(await publicSettings(c)));

app.route('/api/auth', authApi);
app.route('/api/billing', billingApi);
app.route('/api/accounts', accountsApi);
app.route('/api/rules', rulesApi);
app.route('/api/emails', emailsApi);
app.route('/api/sync', syncApi);
app.route('/api/export', exportApi);
app.route('/api/webhooks', webhooksApi);

// 管理后台（需登录 + admin 角色）
app.use('/api/admin/*', requireAuth, requireAdmin);
app.route('/api/admin', adminApi);

export default {
  fetch: app.fetch,

  /**
   * 定时任务（每分钟触发，付费计划）：
   *  - 逐规则按 interval/on_receive 裁决后执行同步；
   *  - 续期 Outlook 变更订阅。
   * 免费计划下 Cron 最小为 1 小时，可用 UptimeRobot 每分钟 ping /api/sync/run 兜底（需登录，建议配 Access 或专用 Token）。
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const job = (async () => {
      await runSyncAll(env, { trigger: 'cron' });
      const enabled = (env.WEBHOOK_ENABLED ?? '').split(',').map((s) => s.trim());
      if (enabled.includes('outlook')) {
        await renewExpiringSubscriptions(env);
      }
    })();
    ctx.waitUntil(job);
  },
} satisfies ExportedHandler<Env>;
