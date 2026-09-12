/**
 * IMAP 连接器（QQ / 163 / 126）—— 走桥接层代理。
 *
 * Cloudflare Worker 的出站 TCP 到国内邮箱服务器（imap.qq.com / imap.163.com 等）
 * 经常超时，因此 IMAP 连接动作由自托管桥接层（bridge/，运行在可直连国内网络的
 * 服务器上）执行；本连接器仅负责：解密授权码 → 调桥接层 HTTP → 归一化结果。
 *
 * 桥接层接口：
 *   POST /imap/list  { email, authCode, host, port, since, from, maxResults }
 *                    → { ok, messages: [...] } | { ok:false, auth:true, error }
 *   POST /imap/get   { email, authCode, host, port, uid }
 *                    → { ok, message: {...} } | { ok:false, auth:true, error }
 */
import type { Env } from '../env';
import type { AccountRow } from '../db/types';
import type { Connector, FullMessage, ListOptions, MessageSummary } from './types';
import { AuthExpiredError } from './types';
import { decryptSecret } from '../crypto/token';
import { getAccount } from '../db/queries';
import { getOauthConfig } from '../oauth/config';
import { bridgeUrl } from './agently';

/** IMAP 授权失败 → 账号标记失效（授权码错误/被服务商吊销） */
export class ImapAuthError extends AuthExpiredError {
  constructor(message: string) {
    super(message);
    this.name = 'ImapAuthError';
  }
}

export const imapConnector: Connector = {
  provider: 'imap',

  async listSummaries(env, accountId, opts) {
    const account = await requireImapAccount(env, accountId);
    const authCode = await decryptSecret(env.TOKEN_ENCRYPTION_KEY ?? '', account.token_enc!);

    const r = await imapProxy(env, '/imap/list', {
      email: account.email,
      authCode,
      host: account.imap_host,
      port: account.imap_port ?? 993,
      since: opts.since ?? Date.now() - 7 * 86400_000,
      from: opts.senderMode !== 'regex' && opts.senderPattern ? opts.senderPattern.trim().replace(/^"|"$/g, '') : undefined,
      maxResults: opts.maxResults ?? 50,
    });

    const messages = (r.messages ?? []) as {
      uid: number;
      sender?: string;
      senderName?: string;
      subject?: string;
      receivedAt?: number;
    }[];
    return messages
      .filter((m) => m && m.sender)
      .map((m) => ({
        id: `u:${m.uid}`,
        sender: m.sender!,
        senderName: m.senderName || undefined,
        subject: m.subject ?? '',
        receivedAt: Number(m.receivedAt) || Date.now(),
      } satisfies MessageSummary));
  },

  async getMessage(env, accountId, messageId) {
    const account = await requireImapAccount(env, accountId);
    const authCode = await decryptSecret(env.TOKEN_ENCRYPTION_KEY ?? '', account.token_enc!);

    const r = await imapProxy(env, '/imap/get', {
      email: account.email,
      authCode,
      host: account.imap_host,
      port: account.imap_port ?? 993,
      uid: String(messageId).replace(/^u:/, ''),
    });
    if (!r.message) return null;

    const m = r.message as { sender?: string; senderName?: string; subject?: string; receivedAt?: number; bodyText?: string };
    return {
      summary: {
        id: messageId,
        sender: m.sender ?? '',
        senderName: m.senderName || undefined,
        subject: m.subject ?? '',
        receivedAt: Number(m.receivedAt) || Date.now(),
      },
      bodyText: (m.bodyText ?? '').trim(),
    } satisfies FullMessage;
  },
};

/** 调桥接层 IMAP 代理；ok:false + auth → 抛 ImapAuthError（账号标记过期） */
async function imapProxy<T = { ok: boolean; auth?: boolean; error?: string; messages?: unknown[]; message?: unknown }>(
  env: Env,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const cfg = await getOauthConfig(env);
  const url = `${(await bridgeUrl(env))}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.agently_bridge_token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`bridge ${path} 失败: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as T & { ok?: boolean; auth?: boolean; error?: string };
  if (data && data.ok === false) {
    if (data.auth) throw new ImapAuthError(data.error ?? 'IMAP 认证失败');
    throw new Error(data.error ?? `bridge ${path} 返回失败`);
  }
  return data;
}

async function requireImapAccount(env: Env, accountId: string): Promise<AccountRow> {
  const account = await getAccount(env.DB, accountId);
  if (!account) throw new Error(`account not found: ${accountId}`);
  if (account.provider !== 'imap' || !account.token_enc || !account.imap_host) {
    throw new Error(`IMAP 账号配置不完整（缺服务器或授权码）: ${accountId}`);
  }
  return account;
}
