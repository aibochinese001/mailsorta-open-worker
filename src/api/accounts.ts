import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { agentlyAuthStart, agentlyAuthStatus, buildAuthorizeUrl, completeOAuth, createOAuthState, verifyOAuthState } from '../oauth/flows';
import { createMessageSubscription } from '../connectors/outlook';
import { imapConnector, ImapAuthError } from '../connectors/imap';
import { encryptSecret } from '../crypto/token';
import { countAccountsByUser, deleteAccount, getAccountByEmail, getAccountOwned, getRule, getUserById, listAccounts, upsertAccount } from '../db/queries';
import { quotaFor } from '../billing/service';
import { getUser } from '../middleware/auth';
import { HttpError } from '../middleware/errors';

export const accountsApi = new Hono<AppBindings>();

accountsApi.get('/', async (c) => {
  const u = getUser(c);
  const accounts = await listAccounts(c.env.DB, u.id);
  return c.json({ accounts });
});

accountsApi.delete('/:id', async (c) => {
  const u = getUser(c);
  const id = c.req.param('id');
  const account = await getAccountOwned(c.env.DB, id, u.id);
  if (!account) throw new HttpError(404, '账号不存在');
  // 手动级联：邮件 → 规则 → 账号
  await c.env.DB.prepare('DELETE FROM emails WHERE account_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM rules WHERE account_id = ?').bind(id).run();
  await deleteAccount(c.env.DB, id);
  return c.json({ ok: true });
});

/** 新增 IMAP 账号（QQ/163/126）：邮箱 + 授权码 + 服务器；授权码 AES 加密落库 */
accountsApi.post('/imap', async (c) => {
  const u = getUser(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    auth_code?: string;
    host?: string;
    port?: number;
    test?: boolean; // 保存时尝试真实连接
  };
  const email = (body.email ?? '').trim().toLowerCase();
  const authCode = (body.auth_code ?? '').trim();
  const host = (body.host ?? '').trim().replace(/^imaps?:\/\//, '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(422, '邮箱格式不正确');
  if (!authCode) throw new HttpError(422, '缺少授权码（在邮箱网页端开启 IMAP 服务后生成）');
  if (!host) throw new HttpError(422, '缺少 IMAP 服务器地址');
  const port = Math.max(1, Number(body.port) || 993);

  // 配额预检：同邮箱已有账号视为更新，不占新增名额
  const user = await getUserById(c.env.DB, u.id);
  if (!user) throw new HttpError(401, '用户不存在');
  const existing = (await listAccounts(c.env.DB, u.id)).find((a) => a.email === email);
  // 跨用户占用检查：email 全局唯一（accounts.email UNIQUE），且 upsert 的 ON CONFLICT 不更新 user_id，
  // 若该邮箱已属于其他用户，继续 upsert 会静默改写对方账号的授权码与归属混淆，必须拒绝。
  const ownedByOther = await getAccountByEmail(c.env.DB, email);
  if (ownedByOther && ownedByOther.user_id !== u.id) {
    throw new HttpError(409, `邮箱 ${email} 已被其他账号绑定，请先让对方解绑`);
  }
  if (!existing) {
    const quota = await quotaFor(c.env.DB, user);
    const count = await countAccountsByUser(c.env.DB, u.id);
    if (count >= quota.accounts) throw new HttpError(402, `账号数量已达上限（${quota.accounts}），请升级会员`);
  }

  if (!c.env.TOKEN_ENCRYPTION_KEY) throw new HttpError(500, '未配置 TOKEN_ENCRYPTION_KEY，无法加密保存授权码');
  const tokenEnc = await encryptSecret(c.env.TOKEN_ENCRYPTION_KEY, authCode);

  // 保存；新建且开启测试时先真实连接一次，失败则回滚（不覆盖已存在账号）
  let tested = false;
  if (!existing) {
    const accountId = await upsertAccount(c.env.DB, {
      user_id: u.id, provider: 'imap', email, display_name: null, status: 'active',
      scopes: 'imap:read', token_enc: tokenEnc, token_expires_at: null, imap_host: host, imap_port: port,
    });
    if (body.test) {
      try {
        await imapConnector.listSummaries(c.env, accountId, { senderPattern: '', senderMode: 'exact', since: Date.now() - 3600_000, maxResults: 1 });
        tested = true;
      } catch (e) {
        await c.env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId).run();
        const reason = e instanceof Error ? e.message : String(e);
        // 认证失败是授权码问题（用户输入错误），用 422 而非 401——401 会被前端误判为未登录而跳登录页
        if (e instanceof ImapAuthError) throw new HttpError(422, reason);
        throw new HttpError(502, reason);
      }
    }
  } else {
    await upsertAccount(c.env.DB, {
      user_id: u.id, provider: 'imap', email, display_name: null, status: 'active',
      scopes: 'imap:read', token_enc: tokenEnc, token_expires_at: null, imap_host: host, imap_port: port,
    });
  }
  return c.json({ ok: true, tested });
});

/** 发起 OAuth：gmail/outlook 返回授权跳转 URL；agently 返回桥接层授权链接（微信扫码） */
accountsApi.post('/oauth/:provider/start', async (c) => {
  const u = getUser(c);
  const provider = c.req.param('provider') as 'gmail' | 'outlook' | 'agently';
  if (!['gmail', 'outlook', 'agently'].includes(provider)) throw new HttpError(400, '不支持的 Provider');

  // 配额预检：OAuth 成功后会新增账号
  const user = await getUserById(c.env.DB, u.id);
  if (!user) throw new HttpError(401, '用户不存在');
  const quota = await quotaFor(c.env.DB, user);
  const count = await countAccountsByUser(c.env.DB, u.id);
  if (count >= quota.accounts) throw new HttpError(402, `账号数量已达上限（${quota.accounts}），请升级会员`);

  if (provider === 'agently') {
    // 透传桥接层三分支结果：已登录(alreadyLoggedIn/email/status) / 扫码(authUrl/session) / 失败(hint 由异常带出)
    const r = await agentlyAuthStart(c.env, u.id);
    return c.json({ authUrl: r.authUrl ?? null, session: r.session, alreadyLoggedIn: r.alreadyLoggedIn ?? false, email: r.email ?? null, status: r.status ?? null, provider });
  }
  const origin = new URL(c.req.url).origin;
  const state = await createOAuthState(c.env, provider, u.id, origin);
  const authorizeUrl = await buildAuthorizeUrl(c.env, provider, state, origin);
  return c.json({ authorizeUrl, provider });
});

/** OAuth 回调（公共端点，浏览器直接访问；state 绑定用户） */
accountsApi.get('/oauth/:provider/callback', async (c) => {
  const provider = c.req.param('provider') as 'gmail' | 'outlook';
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  const base = (c.env.APP_BASE_URL ?? new URL(c.req.url).origin).replace(/\/$/, '');

  if (error) return Response.redirect(`${base}/?oauth=error#accounts`, 302);
  if (!code || !state) return Response.redirect(`${base}/?oauth=error#accounts`, 302);

  try {
    const expected = await verifyOAuthState(c.env, state);
    if (expected.provider !== provider) return Response.redirect(`${base}/?oauth=error#accounts`, 302);
    await completeOAuth(c.env, provider, code, expected.userId, expected.origin);
    return Response.redirect(`${base}/?oauth=ok#accounts`, 302);
  } catch (e) {
    console.error('[oauth] 回调失败', e);
    return Response.redirect(`${base}/?oauth=failed#accounts`, 302);
  }
});

/** Agently 授权状态轮询：前端轮询直到 done */
accountsApi.get('/oauth/agently/status', async (c) => {
  const u = getUser(c);
  const session = c.req.query('session');
  if (!session) throw new HttpError(400, '缺少 session');
  return c.json(await agentlyAuthStatus(c.env, session));
});

/** 为 Outlook 账号创建 Graph 变更订阅（Webhook 推送） */
accountsApi.post('/:id/subscription', async (c) => {
  const u = getUser(c);
  const account = await getAccountOwned(c.env.DB, c.req.param('id'), u.id);
  if (!account) throw new HttpError(404, '账号不存在');
  if (account.provider !== 'outlook') throw new HttpError(400, '仅 Outlook 支持订阅');
  const sub = await createMessageSubscription(c.env, account.id);
  return c.json({ ok: true, subscription: sub });
});

export { getRule };
