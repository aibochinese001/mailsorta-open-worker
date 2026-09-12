import type { Env } from '../env';
import type { Provider } from '../db/types';
import { upsertAccount, getAccountByEmail } from '../db/queries';
import { encryptSecret } from '../crypto/token';
import { jsonFetch } from '../connectors/http';
import { bridgeMe } from '../connectors/agently';
import { getOauthConfig, hasOauthCreds } from './config';

const STATE_TTL = 600;

export interface OAuthStateData {
  provider: Provider;
  userId: string;
  createdAt: number;
  /** 发起授权的站点 origin（APP_BASE_URL 未配置时的兜底域名来源） */
  origin?: string;
}

/** OAuth state 绑定发起用户，回调后账号归属该用户；记录 origin 保证回调换 token 时 redirect_uri 与授权时一致 */
export async function createOAuthState(env: Env, provider: Provider, userId: string, origin?: string): Promise<string> {
  const state = crypto.randomUUID();
  const data: OAuthStateData = { provider, userId, createdAt: Date.now() };
  if (origin) data.origin = origin;
  await env.KV.put(`oauth:state:${state}`, JSON.stringify(data), {
    expirationTtl: STATE_TTL,
  });
  return state;
}

/**
 * 计算 redirect_uri：优先 APP_BASE_URL（固定域名，防 Host 头注入）；
 * 未配置时用请求 origin 兜底（开源部署者换域名开箱即用，无需改 env）。
 */
export function redirectUriFor(env: Env, provider: Provider, origin?: string): string {
  const base = (env.APP_BASE_URL ?? origin ?? '').replace(/\/$/, '');
  return `${base}/api/accounts/oauth/${provider}/callback`;
}

export async function buildAuthorizeUrl(env: Env, provider: Provider, state: string, origin?: string): Promise<string> {
  const cfg = await getOauthConfig(env);
  const redirectUri = redirectUriFor(env, provider, origin);
  if (provider === 'gmail') {
    if (!hasOauthCreds(cfg, 'gmail')) throw new Error('未配置 Gmail OAuth 凭据：请在管理后台「系统设置 → 邮箱接入」填写 Google Client ID / Secret');
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', cfg.google_client_id);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email https://www.googleapis.com/auth/gmail.readonly');
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('state', state);
    return u.toString();
  }
  if (provider === 'outlook') {
    if (!hasOauthCreds(cfg, 'outlook')) throw new Error('未配置 Outlook OAuth 凭据：请在管理后台「系统设置 → 邮箱接入」填写 Microsoft Client ID / Secret');
    const u = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    u.searchParams.set('client_id', cfg.microsoft_client_id);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'offline_access Mail.Read');
    u.searchParams.set('state', state);
    return u.toString();
  }
  throw new Error(`Provider ${provider} 走桥接层授权，请使用 agently 专用流程`);
}

export async function verifyOAuthState(env: Env, state: string): Promise<OAuthStateData> {
  const raw = await env.KV.get(`oauth:state:${state}`);
  if (!raw) throw new Error('OAuth state 无效或已过期');
  await env.KV.delete(`oauth:state:${state}`);
  const parsed = JSON.parse(raw) as OAuthStateData;
  if (!parsed.userId) throw new Error('OAuth state 缺少用户');
  return parsed;
}

interface ExchangedToken {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export async function exchangeCode(env: Env, provider: Provider, code: string, redirectUri: string): Promise<ExchangedToken> {
  const cfg = await getOauthConfig(env);
  if (provider === 'gmail') {
    if (!hasOauthCreds(cfg, 'gmail')) throw new Error('未配置 Gmail OAuth 凭据');
    return jsonFetch<ExchangedToken>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: cfg.google_client_id,
        client_secret: cfg.google_client_secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
  }
  if (provider === 'outlook') {
    if (!hasOauthCreds(cfg, 'outlook')) throw new Error('未配置 Outlook OAuth 凭据');
    return jsonFetch<ExchangedToken>('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: cfg.microsoft_client_id,
        client_secret: cfg.microsoft_client_secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: 'offline_access Mail.Read',
      }),
    });
  }
  throw new Error(`Provider ${provider} 不支持授权码交换`);
}

async function profile(env: Env, provider: Provider, token: ExchangedToken): Promise<{ email: string; displayName: string }> {
  if (provider === 'gmail') {
    const info = await jsonFetch<{ email?: string; name?: string }>('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    return { email: info.email ?? '', displayName: info.name ?? '' };
  }
  if (provider === 'outlook') {
    const me = await jsonFetch<{ mail?: string; userPrincipalName?: string; displayName?: string }>(
      'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName',
      { headers: { authorization: `Bearer ${token.access_token}` } },
    );
    return { email: me.mail ?? me.userPrincipalName ?? '', displayName: me.displayName ?? '' };
  }
  throw new Error(`Provider ${provider} 不支持 profile 查询`);
}

export async function completeOAuth(env: Env, provider: Provider, code: string, userId: string, origin?: string): Promise<{ email: string }> {
  const redirectUri = redirectUriFor(env, provider, origin);
  const token = await exchangeCode(env, provider, code, redirectUri);
  const { email, displayName } = await profile(env, provider, token);
  if (!email) throw new Error('未能获取邮箱地址');

  const tokenEnc = token.refresh_token
    ? await encryptSecret(env.TOKEN_ENCRYPTION_KEY ?? '', token.refresh_token)
    : null;
  if (token.refresh_token && !env.TOKEN_ENCRYPTION_KEY) {
    throw new Error('未配置 TOKEN_ENCRYPTION_KEY，无法安全保存 refresh token');
  }

  await upsertAccount(env.DB, {
    user_id: userId,
    provider,
    email,
    display_name: displayName || null,
    status: 'active',
    scopes: token.scope ?? null,
    token_enc: tokenEnc,
    token_expires_at: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
  });
  return { email };
}

// ---------------- Agently（桥接层授权） ----------------

/** 发起 agently-cli 授权（微信扫码），session 绑定用户。
 * 桥接层返回三种形态：
 *  A) 未登录 → { authUrl, session, urls }，前端展示扫码链接
 *  B) 已登录 → { session, alreadyLoggedIn: true, email, status: 'done' }，前端直接显示绑定成功（不登出、不扫码）
 *  C) 复用进行中授权 → { authUrl, session, reused: true, urls }
 */
export async function agentlyAuthStart(
  env: Env,
  userId: string,
): Promise<{ authUrl?: string | null; session: string; alreadyLoggedIn?: boolean; email?: string; status?: string; hint?: string }> {
  const cfg = await getOauthConfig(env);
  if (!cfg.agently_bridge_url) throw new Error('未配置 Agently 桥接层地址：请在管理后台「系统设置 → 邮箱接入」填写桥接层 URL / Token');
  const session = crypto.randomUUID();
  const res = await fetch(`${cfg.agently_bridge_url.replace(/\/$/, '')}/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.agently_bridge_token}` },
    body: JSON.stringify({ session, user: userId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`桥接层 /auth/start 失败 (${res.status})：${errBody.error ?? '请确认桥接层已启动且 URL/Token 正确'}`);
  }
  const data = (await res.json()) as {
    authUrl?: string | null;
    session?: string;
    hint?: string;
    urls?: string[];
    alreadyLoggedIn?: boolean;
    email?: string;
    status?: string;
    displayName?: string;
  };

  const effectiveSession = data.session ?? session;

  // 形态 B：该用户槽已登录，直接返回成功（桥接层设计如此，绝不 logout）
  if (data.alreadyLoggedIn || data.status === 'done') {
    if (data.email) {
      // 防跨用户绑定：该邮箱已属于其他账号时拒绝（多槽正常路径不会触发，防御性检查）
      const existing = await getAccountByEmail(env.DB, data.email);
      if (existing && existing.user_id !== userId) {
        throw new Error(`该 Agent Mail 邮箱（${data.email}）已绑定其他账号，请先让该账号解绑或联系管理员处理`);
      }
      // 已登录槽直接为用户建号（凭据留在桥接层）
      await upsertAccount(env.DB, {
        user_id: userId,
        provider: 'agently',
        email: data.email,
        display_name: data.displayName ?? null,
        status: 'active',
        scopes: 'alias:read,mail:read',
        token_enc: null,
        token_expires_at: null,
      });
    }
    await env.KV.put(`oauth:agently:${effectiveSession}`, JSON.stringify({ userId, createdAt: Date.now(), done: true }), { expirationTtl: 900 });
    return {
      session: effectiveSession,
      alreadyLoggedIn: true,
      email: data.email,
      status: 'done',
    };
  }

  // 形态 A/C：有授权链接，返回扫码
  if (data.authUrl) {
    await env.KV.put(`oauth:agently:${effectiveSession}`, JSON.stringify({ userId, createdAt: Date.now() }), { expirationTtl: 900 });

    // 注册桥接层回调：授权完成时桥接层主动 POST /api/webhooks/agently/auth，立即建号（无需等前端轮询）
    if (cfg.agently_bridge_url && cfg.agently_bridge_token && env.APP_BASE_URL) {
      fetch(`${cfg.agently_bridge_url.replace(/\/$/, '')}/watch/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.agently_bridge_token}` },
        body: JSON.stringify({ callback: `${env.APP_BASE_URL.replace(/\/$/, '')}/api/webhooks/agently`, secret: cfg.agently_bridge_token }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }

    return { authUrl: data.authUrl, session: effectiveSession };
  }

  // 真正的捕获失败
  throw new Error(`桥接层未捕获到授权链接：${data.hint ?? '请确认已安装 agently-cli 并在桥接层所在机器手动执行一次 agently-cli auth login'}`);
}

/** 轮询桥接层授权结果；授权完成时创建账号（归属发起用户） */
export async function agentlyAuthStatus(env: Env, session: string): Promise<{ status: 'pending' | 'done' | 'expired'; email?: string }> {
  const pending = await env.KV.get(`oauth:agently:${session}`);
  if (!pending) return { status: 'expired' };
  const cfg = await getOauthConfig(env);
  if (!cfg.agently_bridge_url) return { status: 'pending' };

  const res = await fetch(
    `${cfg.agently_bridge_url.replace(/\/$/, '')}/auth/status?session=${encodeURIComponent(session)}`,
    { headers: { authorization: `Bearer ${cfg.agently_bridge_token}` }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) return { status: 'pending' };
  const data = (await res.json()) as { status: 'pending' | 'done' | 'error'; email?: string; displayName?: string; error?: string | null };
  if (data.status === 'error') return { status: 'expired' }; // 桥接层 CLI 故障，会话作废
  if (data.status !== 'done' || !data.email) return { status: 'pending' };

  const meta = JSON.parse(pending) as { userId: string };
  await upsertAccount(env.DB, {
    user_id: meta.userId,
    provider: 'agently',
    email: data.email,
    display_name: data.displayName ?? null,
    status: 'active',
    scopes: 'alias:read,mail:read',
    token_enc: null, // 凭据留在桥接层
    token_expires_at: null,
  });
  await env.KV.delete(`oauth:agently:${session}`);
  return { status: 'done', email: data.email };
}

/** 备用：桥接层主动回调完成授权 */
export async function agentlyAuthCallback(env: Env, session: string, email: string, displayName?: string): Promise<void> {
  const pending = await env.KV.get(`oauth:agently:${session}`);
  if (!pending) throw new Error('session 不存在或已过期');
  const meta = JSON.parse(pending) as { userId: string };
  await upsertAccount(env.DB, {
    user_id: meta.userId,
    provider: 'agently',
    email,
    display_name: displayName ?? null,
    status: 'active',
    scopes: 'alias:read,mail:read',
    token_enc: null,
    token_expires_at: null,
  });
  await env.KV.delete(`oauth:agently:${session}`);
}

export { bridgeMe };
