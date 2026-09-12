import type { Env } from '../env';
import type { AccountRow, Provider } from '../db/types';
import { decryptSecret } from '../crypto/token';
import { AuthExpiredError, ConnectorError } from '../connectors/types';
import { updateAccountStatus } from '../db/queries';
import { getOauthConfig } from './config';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

async function refreshForProvider(env: Env, account: AccountRow): Promise<TokenResponse> {
  const cfg = await getOauthConfig(env);
  const refreshToken = account.token_enc
    ? await decryptSecret(env.TOKEN_ENCRYPTION_KEY ?? '', account.token_enc)
    : null;
  if (!refreshToken) throw new AuthExpiredError(`${account.provider}: 无 refresh token`);

  if (account.provider === 'gmail') {
    if (!cfg.google_client_id || !cfg.google_client_secret) throw new AuthExpiredError('gmail: 未配置 OAuth 凭据');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.google_client_id,
        client_secret: cfg.google_client_secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new AuthExpiredError(`gmail refresh 失败: ${res.status}`);
    return (await res.json()) as TokenResponse;
  }

  if (account.provider === 'outlook') {
    if (!cfg.microsoft_client_id || !cfg.microsoft_client_secret) throw new AuthExpiredError('outlook: 未配置 OAuth 凭据');
    const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.microsoft_client_id,
        client_secret: cfg.microsoft_client_secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: 'https://graph.microsoft.com/Mail.Read offline_access',
      }),
    });
    if (!res.ok) throw new AuthExpiredError(`outlook refresh 失败: ${res.status}`);
    return (await res.json()) as TokenResponse;
  }

  throw new ConnectorError(`${account.provider}: 该 Provider 不需要 Worker 侧令牌`);
}

/**
 * 获取 Provider 的访问令牌。
 * 缓存于 KV（短 TTL）；过期后自动用 refresh token 换新，并将新 refresh token 加密回写。
 */
export async function getAccessToken(env: Env, account: AccountRow): Promise<string> {
  if (account.provider === 'agently') {
    // Agently 凭据保存在桥接层，Worker 侧无令牌
    throw new ConnectorError('agently 连接器无需访问令牌');
  }

  const cacheKey = `token:${account.id}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) return cached;

  const token = await refreshForProvider(env, account);
  const ttl = Math.max(60, (token.expires_in ?? 3600) - 120);
  await env.KV.put(cacheKey, token.access_token, { expirationTtl: ttl });

  // 部分 Provider 会轮换 refresh token，回写加密存储
  if (token.refresh_token && env.TOKEN_ENCRYPTION_KEY) {
    const enc = await encryptRefresh(env, token.refresh_token);
    if (enc) {
      const res = await env.DB.prepare(
        'UPDATE accounts SET token_enc = ?, updated_at = ? WHERE id = ?',
      ).bind(enc, Date.now(), account.id).run();
      void res;
    }
  }
  return token.access_token;
}

async function encryptRefresh(env: Env, plain: string): Promise<string | null> {
  try {
    const { encryptSecret } = await import('../crypto/token');
    return await encryptSecret(env.TOKEN_ENCRYPTION_KEY ?? '', plain);
  } catch {
    return null;
  }
}

/** 令牌失效（revoked/expired）时标记账号，供编排器跳过 */
export async function markAccountExpired(env: Env, account: AccountRow, reason: string): Promise<void> {
  await updateAccountStatus(env.DB, account.id, reason === 'revoked' ? 'revoked' : 'expired');
  await env.KV.delete(`token:${account.id}`);
}

export type { Provider };
