import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { agentlyAuthCallback } from '../oauth/flows';
import { getOauthConfig } from '../oauth/config';
import { runSyncAll } from '../sync/orchestrator';
import { listAccounts } from '../db/queries';
import { HttpError } from '../middleware/errors';

/**
 * Provider Webhook（公共端点）：
 *  - Outlook：Graph 变更通知（需先创建订阅）
 *  - Agently：桥接层新邮件事件 / 授权完成回调
 */
export const webhooksApi = new Hono<AppBindings>();

// ---------------- Outlook ----------------

webhooksApi.get('/outlook', (c) => {
  const token = c.req.query('validationToken');
  if (!token) throw new HttpError(400, '缺少 validationToken');
  return c.text(token);
});

webhooksApi.post('/outlook', async (c) => {
  if (!(c.env.WEBHOOK_ENABLED ?? '').split(',').map((s) => s.trim()).includes('outlook')) {
    throw new HttpError(404, 'webhook 未启用');
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    value?: { resource?: string; changeType?: string }[];
  };
  const ids = (body.value ?? [])
    .map((v) => v.resource?.split('/').pop())
    .filter((x): x is string => !!x);

  const accounts = (await listAccounts(c.env.DB)).filter((a) => a.provider === 'outlook');
  const outcomes = [];
  for (const account of accounts) {
    outcomes.push(...(await runSyncAll(c.env, { trigger: 'webhook', accountId: account.id })));
  }
  return c.json({ ok: true, messageIds: ids.length, rules: outcomes.length });
});

// ---------------- Agently ----------------

async function checkBridgeSecret(c: { env: AppBindings['Bindings']; req: { header(name: string): string | undefined } }): Promise<void> {
  const secret = c.req.header('x-webhook-secret') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const cfg = await getOauthConfig(c.env);
  const expected = cfg.agently_bridge_token;
  if (!expected || secret !== expected) {
    throw new HttpError(401, 'webhook 签名无效');
  }
}

webhooksApi.post('/agently', async (c) => {
  checkBridgeSecret(c);
  const body = (await c.req.json().catch(() => ({}))) as { messageId?: string; accountEmail?: string };
  const accounts = (await listAccounts(c.env.DB)).filter((a) => a.provider === 'agently');
  const outcomes = [];
  for (const account of accounts) {
    if (body.accountEmail && account.email !== body.accountEmail) continue;
    outcomes.push(...(await runSyncAll(c.env, { trigger: 'webhook', accountId: account.id })));
  }
  return c.json({ ok: true, rules: outcomes.length });
});

/** 桥接层授权完成回调 */
webhooksApi.post('/agently/auth', async (c) => {
  checkBridgeSecret(c);
  const body = (await c.req.json().catch(() => ({}))) as { session?: string; email?: string; displayName?: string };
  if (!body.session || !body.email) throw new HttpError(400, '缺少 session/email');
  await agentlyAuthCallback(c.env, body.session, body.email, body.displayName);
  return c.json({ ok: true });
});
