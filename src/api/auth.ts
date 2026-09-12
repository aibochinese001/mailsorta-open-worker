import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { clearSessionCookie, createSessionToken, currentSession, setSessionCookie, type SessionPayload } from '../middleware/auth';
import { hashPassword, isValidPassword, verifyPassword } from '../crypto/password';
import { createUser, getUserByEmail, getUserById, setSetting, touchLogin, updateUser } from '../db/queries';
import { memberStatus, TRIAL_DAYS } from '../billing/service';
import { sendTemplateMail, verifyCodeMail } from '../email/smtp';
import { getSetting } from '../db/queries';
import { HttpError } from '../middleware/errors';
import { getUser } from '../middleware/auth';
import { encryptSecret } from '../crypto/token';

export const authApi = new Hono<AppBindings>();

const CODE_TTL_S = 300;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeUser(u: Awaited<ReturnType<typeof getUserById>>) {
  if (!u) return null;
  const { password_hash, llm_api_key_enc, ...rest } = u;
  void password_hash;
  void llm_api_key_enc;
  return rest;
}

/** 发送验证码（注册/重置密码）。SMTP 未配置时返回 devCode（仅限未配置 SMTP 的环境，生产必须配置） */
authApi.post('/send-code', async (c) => {
  const { email, purpose } = (await c.req.json().catch(() => ({}))) as { email?: string; purpose?: string };
  if (!email || !EMAIL_RE.test(email)) throw new HttpError(422, '邮箱格式不正确');
  if (purpose !== 'register' && purpose !== 'reset') throw new HttpError(422, 'purpose 必须为 register 或 reset');

  if (purpose === 'register') {
    const existing = await getUserByEmail(c.env.DB, email);
    if (existing) throw new HttpError(409, '该邮箱已注册，请直接登录');
  } else {
    const existing = await getUserByEmail(c.env.DB, email);
    if (!existing) throw new HttpError(404, '该邮箱尚未注册');
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  await c.env.KV.put(`auth:code:${purpose}:${email.toLowerCase()}`, code, { expirationTtl: CODE_TTL_S });
  const mail = verifyCodeMail(code, CODE_TTL_S / 60);
  const result = await sendTemplateMail(c.env, email, mail.subject, mail.html);
  if (!result.sent) {
    // SMTP 未配置：开发环境可用 devCode 完成注册/重置
    return c.json({ ok: true, devCode: code, smtp: false });
  }
  return c.json({ ok: true, smtp: true });
});

authApi.post('/register', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string; code?: string; display_name?: string };
  const email = (body.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(422, '邮箱格式不正确');
  if (!isValidPassword(body.password ?? '')) throw new HttpError(422, '密码至少 8 位（最多 128 位）');
  const code = (body.code ?? '').trim();
  if (!code) throw new HttpError(422, '缺少验证码');

  const allowReg = (await getSetting(c.env.DB, 'allow_registration')) ?? '1';
  if (allowReg !== '1') throw new HttpError(403, '暂未开放注册');
  const existing = await getUserByEmail(c.env.DB, email);
  if (existing) throw new HttpError(409, '该邮箱已注册');

  const saved = await c.env.KV.get(`auth:code:register:${email}`);
  if (!saved || saved !== code) throw new HttpError(422, '验证码错误或已过期');

  // 管理员不在注册时自动产生：仅管理员邮箱白名单中的账号获得 admin 角色
  // （白名单来源：管理后台设置 admin_emails，逗号分隔；未配置时回退环境变量 ADMIN_EMAILS）
  const adminList = ((await getSetting(c.env.DB, 'admin_emails')) ?? c.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const isAdmin = adminList.includes(email);

  const password_hash = await hashPassword(body.password!);
  const t = Date.now();
  const user = await createUser(c.env.DB, {
    email,
    password_hash,
    display_name: body.display_name?.trim() ? body.display_name.trim() : null,
    role: isAdmin ? 'admin' : 'user',
    status: 'active',
    member_plan: 'trial',
    member_expires_at: t + TRIAL_DAYS * 24 * 3600 * 1000,
  });
  await c.env.KV.delete(`auth:code:register:${email}`);

  const session = await createSessionToken(c.env.SESSION_SECRET ?? '', user.id, user.role);
  setSessionCookie(c, session);
  return c.json({ ok: true, user: safeUser(user), isAdmin, trialDays: TRIAL_DAYS }, 201);
});

authApi.post('/login', async (c) => {
  const { email, password } = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!email || !password) throw new HttpError(422, '缺少邮箱或密码');
  const user = await getUserByEmail(c.env.DB, email.trim().toLowerCase());
  if (!user) throw new HttpError(401, '邮箱或密码错误');
  if (!(await verifyPassword(user.password_hash, password))) throw new HttpError(401, '邮箱或密码错误');
  if (user.status !== 'active') throw new HttpError(403, '账号已被禁用，请联系管理员');

  await touchLogin(c.env.DB, user.id);
  const session = await createSessionToken(c.env.SESSION_SECRET ?? '', user.id, user.role);
  setSessionCookie(c, session);
  return c.json({ ok: true, user: safeUser(user) });
});

authApi.post('/forgot', async (c) => {
  const { email } = (await c.req.json().catch(() => ({}))) as { email?: string };
  if (!email || !EMAIL_RE.test(email)) throw new HttpError(422, '邮箱格式不正确');
  const user = await getUserByEmail(c.env.DB, email.trim().toLowerCase());
  if (!user) throw new HttpError(404, '该邮箱尚未注册');
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  await c.env.KV.put(`auth:code:reset:${email.trim().toLowerCase()}`, code, { expirationTtl: CODE_TTL_S });
  const mail = verifyCodeMail(code, CODE_TTL_S / 60);
  const result = await sendTemplateMail(c.env, email.trim(), mail.subject, mail.html);
  if (!result.sent) return c.json({ ok: true, devCode: code, smtp: false });
  return c.json({ ok: true, smtp: true });
});

authApi.post('/reset', async (c) => {
  const { email, code, password } = (await c.req.json().catch(() => ({}))) as { email?: string; code?: string; password?: string };
  const normalized = (email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) throw new HttpError(422, '邮箱格式不正确');
  if (!isValidPassword(password ?? '')) throw new HttpError(422, '密码至少 8 位');
  const saved = await c.env.KV.get(`auth:code:reset:${normalized}`);
  if (!saved || saved !== (code ?? '').trim()) throw new HttpError(422, '验证码错误或已过期');
  const user = await getUserByEmail(c.env.DB, normalized);
  if (!user) throw new HttpError(404, '该邮箱尚未注册');
  const password_hash = await hashPassword(password!);
  await updateUser(c.env.DB, user.id, { password_hash });
  await c.env.KV.delete(`auth:code:reset:${normalized}`);
  return c.json({ ok: true });
});

authApi.post('/logout', (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

/** 修改密码（登录态）：验证原密码 → 更新哈希 */
authApi.post('/change-password', async (c) => {
  const u = getUser(c);
  const body = (await c.req.json().catch(() => ({}))) as { old_password?: string; new_password?: string };
  if (!body.old_password || !body.new_password) throw new HttpError(422, '缺少原密码或新密码');
  if (!isValidPassword(body.new_password)) throw new HttpError(422, '新密码至少 8 位（最多 128 位）');
  if (body.old_password === body.new_password) throw new HttpError(422, '新密码不能与原密码相同');

  const user = await getUserById(c.env.DB, u.id);
  if (!user) throw new HttpError(401, '用户不存在');
  if (!(await verifyPassword(user.password_hash, body.old_password))) throw new HttpError(422, '原密码不正确');

  const password_hash = await hashPassword(body.new_password);
  await updateUser(c.env.DB, user.id, { password_hash });
  return c.json({ ok: true });
});

/** 更新个人资料（昵称 / AI 提取模型配置）。API Key 加密存储，'********' 表示保持不变 */
authApi.patch('/profile', async (c) => {
  const u = getUser(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    display_name?: string;
    llm_api_url?: string;
    llm_model?: string;
    llm_api_key?: string;
  };
  const user = await getUserById(c.env.DB, u.id);
  if (!user) throw new HttpError(401, '用户不存在');

  const patch: Parameters<typeof updateUser>[2] = {};
  if (body.display_name !== undefined) {
    patch.display_name = body.display_name.trim() ? body.display_name.trim().slice(0, 40) : null;
  }
  if (body.llm_api_url !== undefined) {
    const url = body.llm_api_url.trim();
    if (url && !/^https?:\/\//i.test(url)) throw new HttpError(422, 'LLM API 地址需以 http(s):// 开头');
    patch.llm_api_url = url || null;
  }
  if (body.llm_model !== undefined) {
    patch.llm_model = body.llm_model.trim() || null;
  }
  if (body.llm_api_key !== undefined) {
    const key = body.llm_api_key.trim();
    if (key && key !== '********') {
      if (!c.env.TOKEN_ENCRYPTION_KEY) {
        throw new HttpError(500, '未配置 TOKEN_ENCRYPTION_KEY，无法安全保存 API Key（部署时执行 wrangler secret put TOKEN_ENCRYPTION_KEY）');
      }
      patch.llm_api_key_enc = await encryptSecret(c.env.TOKEN_ENCRYPTION_KEY, key);
    }
    // '********' 或空串：保留原值 / 清空由 URL 是否填写决定
    if (!key && !patch.llm_api_url) patch.llm_api_key_enc = null;
  }

  const updated = await updateUser(c.env.DB, u.id, patch);
  return c.json({ ok: true, user: safeUser(updated) });
});

authApi.get('/me', async (c) => {
  const session = await currentSession(c);
  if (!session) return c.json({ authed: false });
  const user = await getUserById(c.env.DB, (session as SessionPayload).sub);
  if (!user || user.status !== 'active') {
    clearSessionCookie(c);
    return c.json({ authed: false });
  }
  const member = memberStatus(user);
  const quotaRaw = {
    accounts: member.level === 'free' ? Number((await getSetting(c.env.DB, 'quota_free_accounts')) ?? '') || 1 : Number((await getSetting(c.env.DB, 'quota_paid_accounts')) ?? '') || 20,
    rules: member.level === 'free' ? Number((await getSetting(c.env.DB, 'quota_free_rules')) ?? '') || 5 : Number((await getSetting(c.env.DB, 'quota_paid_rules')) ?? '') || 200,
  };
  return c.json({
    authed: true,
    user: { ...safeUser(user), llm_key_configured: !!user.llm_api_key_enc },
    member,
    quota: quotaRaw,
  });
});

// 供其它模块复用
export { safeUser, EMAIL_RE };
