import type { Env } from '../env';
import type { Connector, FullMessage, ListOptions, MessageSummary } from './types';
import { getAccessToken } from '../oauth/tokens';
import { jsonFetch, stripHtml } from './http';

interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  body?: { contentType?: 'text' | 'html'; content?: string };
}

function toSummary(m: GraphMessage): MessageSummary {
  return {
    id: m.id,
    threadId: m.conversationId,
    sender: m.from?.emailAddress?.address ?? '',
    senderName: m.from?.emailAddress?.name || undefined,
    subject: m.subject ?? '',
    receivedAt: m.receivedDateTime ? Date.parse(m.receivedDateTime) : Date.now(),
  };
}

/** Outlook 服务端过滤：exact 模式可精确过滤；domain/regex 取最近 N 封后本地裁决 */
function buildFilter(opts: ListOptions): string {
  if (opts.senderMode !== 'exact') return '';
  const addr = opts.senderPattern.trim().replace(/'/g, "''");
  const time = opts.since ? ` and receivedDateTime ge ${new Date(opts.since).toISOString()}` : '';
  return `from/emailAddress/address eq '${addr}'${time}`;
}

export const outlookConnector: Connector = {
  provider: 'outlook',

  async listSummaries(env, accountId, opts) {
    const { getAccount } = await import('../db/queries');
    const account = await getAccount(env.DB, accountId);
    if (!account) throw new Error(`account not found: ${accountId}`);
    const access = await getAccessToken(env, account);

    const filter = buildFilter(opts);
    const url = new URL('https://graph.microsoft.com/v1.0/me/messages');
    const selects = ['id', 'conversationId', 'subject', 'from', 'receivedDateTime'];
    url.searchParams.set('$select', selects.join(','));
    if (filter) url.searchParams.set('$filter', filter);
    url.searchParams.set('$top', String(opts.maxResults ?? 50));
    url.searchParams.set('$orderby', 'receivedDateTime desc');

    const data = await jsonFetch<{ value?: GraphMessage[] }>(url.toString(), {
      headers: { authorization: `Bearer ${access}` },
    });
    return (data.value ?? []).map(toSummary);
  },

  async getMessage(env, accountId, messageId) {
    const { getAccount } = await import('../db/queries');
    const account = await getAccount(env.DB, accountId);
    if (!account) throw new Error(`account not found: ${accountId}`);
    const access = await getAccessToken(env, account);

    const url = new URL(`https://graph.microsoft.com/v1.0/me/messages/${messageId}`);
    url.searchParams.set('$select', 'id,conversationId,subject,from,receivedDateTime,body');
    const m = await jsonFetch<GraphMessage>(url.toString(), {
      headers: { authorization: `Bearer ${access}` },
    });

    let bodyText = m.body?.content ?? '';
    if (m.body?.contentType === 'html') bodyText = stripHtml(bodyText);
    return { summary: toSummary(m), bodyText: bodyText.trim() } satisfies FullMessage;
  },
};

// ---------------- Outlook Graph 订阅（Webhook 推送，收到即整理） ----------------

export interface OutlookSubscription {
  id: string;
  expirationDateTime: string;
  notificationUrl: string;
}

/** 为账号创建 me/messages 变更订阅（created 事件） */
export async function createMessageSubscription(
  env: Env,
  accountId: string,
): Promise<OutlookSubscription> {
  const { getAccount } = await import('../db/queries');
  const account = await getAccount(env.DB, accountId);
  if (!account) throw new Error(`account not found: ${accountId}`);
  const access = await getAccessToken(env, account);

  const expiration = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(); // Graph 消息订阅最长 ~3 天
  const sub = await jsonFetch<OutlookSubscription>('https://graph.microsoft.com/v1.0/subscriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      changeType: 'created',
      notificationUrl: `${env.APP_BASE_URL}/api/webhooks/outlook`,
      resource: 'me/messages',
      expirationDateTime: expiration,
      clientState: `ms-${accountId}`,
    }),
  });
  await env.KV.put(`outlook:sub:${sub.id}`, JSON.stringify({ accountId, expirationDateTime: sub.expirationDateTime }), {
    expirationTtl: 4 * 24 * 3600,
  });
  return sub;
}

/** 续期所有接近过期的订阅（scheduled 中调用） */
export async function renewExpiringSubscriptions(env: Env): Promise<number> {
  const keys = await env.KV.list({ prefix: 'outlook:sub:' });
  let renewed = 0;
  for (const key of keys.keys) {
    const raw = await env.KV.get(key.name);
    if (!raw) continue;
    const meta = JSON.parse(raw) as { accountId: string; expirationDateTime: string };
    const remaining = Date.parse(meta.expirationDateTime) - Date.now();
    if (remaining > 24 * 3600 * 1000) continue; // 24 小时内才续
    try {
      await createMessageSubscription(env, meta.accountId);
      await env.KV.delete(key.name);
      renewed += 1;
    } catch {
      // 单订阅失败不阻断整体
    }
  }
  return renewed;
}
