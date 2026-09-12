import type { Env } from '../env';
import type { Connector, FullMessage, ListOptions, MessageSummary } from './types';
import { getAccessToken } from '../oauth/tokens';
import { base64UrlDecode, jsonFetch, stripHtml, utf8Decode } from './http';

interface GmailPayload {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  parts?: GmailPart[];
  body?: { data?: string };
}

interface GmailMessageMeta {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

interface GmailMessageFull {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: GmailPayload;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function header(headers: { name: string; value: string }[] | undefined, name: string): string | undefined {
  const h = headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value;
}

/** 递归收集 Gmail payload 中的正文文本 */
function collectBody(part: GmailPart | undefined, texts: string[]): void {
  if (!part) return;
  if (part.mimeType === 'text/plain' && part.body?.data) {
    texts.push(utf8Decode(base64UrlDecode(part.body.data)));
  } else if (part.mimeType === 'text/html' && part.body?.data) {
    texts.push(stripHtml(utf8Decode(base64UrlDecode(part.body.data))));
  }
  for (const p of part.parts ?? []) collectBody(p, texts);
}

function summaryFromMeta(m: GmailMessageMeta): MessageSummary {
  const from = header(m.payload?.headers, 'From') ?? '';
  const sender = from.split(/<|>/)[1] ?? from.split(/\s+/).pop() ?? from;
  const senderName = (from.split('<')[0] ?? '').replace(/["']/g, '').trim() || null;
  const subject = header(m.payload?.headers, 'Subject') ?? '';
  return {
    id: m.id,
    threadId: m.threadId,
    sender,
    senderName: senderName || undefined,
    subject,
    receivedAt: m.internalDate ? Number(m.internalDate) : Date.now(),
  };
}

/** Gmail 发件人查询串：exact/domain 模式走服务端过滤，regex 模式不过滤 */
function buildQuery(opts: ListOptions): string {
  const parts: string[] = [];
  if (opts.senderMode !== 'regex' && opts.senderPattern) {
    const p = opts.senderPattern.trim().replace(/"/g, '');
    parts.push(`from:${p}`);
  }
  if (opts.since) {
    const d = new Date(opts.since);
    const ymd = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    parts.push(`after:${ymd}`);
  }
  return parts.join(' ');
}

export const gmailConnector: Connector = {
  provider: 'gmail',

  async listSummaries(env, accountId, opts) {
    const account = await requireAccount(env, accountId);
    const access = await getAccessToken(env, account);
    const q = buildQuery(opts);
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    if (q) url.searchParams.set('q', q);
    url.searchParams.set('maxResults', String(opts.maxResults ?? 50));

    const list = await jsonFetch<{ messages?: { id: string; threadId: string }[] }>(url.toString(), {
      headers: { authorization: `Bearer ${access}` },
    });
    const metas: GmailMessageMeta[] = [];
    for (const m of list.messages ?? []) {
      const meta = await jsonFetch<GmailMessageMeta>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        { headers: { authorization: `Bearer ${access}` } },
      );
      metas.push(meta);
    }
    return metas.map(summaryFromMeta);
  },

  async getMessage(env, accountId, messageId) {
    const account = await requireAccount(env, accountId);
    const access = await getAccessToken(env, account);
    const full = await jsonFetch<GmailMessageFull>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
      { headers: { authorization: `Bearer ${access}` } },
    );
    const texts: string[] = [];
    if (full.payload?.mimeType === 'text/plain' && full.payload.body?.data) {
      texts.push(utf8Decode(base64UrlDecode(full.payload.body.data)));
    } else {
      collectBody(full.payload, texts);
    }
    return {
      summary: summaryFromMeta(full),
      bodyText: texts.join('\n').trim(),
    } satisfies FullMessage;
  },
};

async function requireAccount(env: Env, accountId: string) {
  const { getAccount } = await import('../db/queries');
  const account = await getAccount(env.DB, accountId);
  if (!account) throw new Error(`account not found: ${accountId}`);
  return account;
}
