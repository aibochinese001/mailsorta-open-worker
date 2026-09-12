import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { HttpError } from '../middleware/errors';
import {
  countOrders, countPaidUsers, countUsers, createPlan, deletePlan, getPlan, getSetting, getUserById,
  listOrders, listPaidOrders, listPlans, listSettings, listUsers, setSetting, updatePlan, updateUser,
} from '../db/queries';
import type { PlanPeriod, PlanRow, UserRow } from '../db/types';
import { hashPassword } from '../crypto/password';

export const adminApi = new Hono<AppBindings>();

// ---------------- 统计 ----------------

adminApi.get('/stats', async (c) => {
  const [users, paidUsers, orders, paidOrders] = await Promise.all([
    countUsers(c.env.DB),
    countPaidUsers(c.env.DB),
    countOrders(c.env.DB),
    listPaidOrders(c.env.DB, 1000),
  ]);
  const revenueUsd = paidOrders.reduce((s, o) => s + o.price_usd, 0);
  return c.json({
    users,
    paid_users: paidUsers,
    orders,
    paid_orders: paidOrders.length,
    revenue_usd: Math.round(revenueUsd * 100) / 100,
  });
});

// ---------------- 用户管理 ----------------

adminApi.get('/users', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);
  const search = c.req.query('search') ?? '';
  const users = await listUsers(c.env.DB, { search, page, pageSize: 20 });
  const list = users.map(({ password_hash, ...u }) => u);
  return c.json({ users: list, page });
});

adminApi.patch('/users/:id', async (c) => {
  const id = c.req.param('id');
  const user = await getUserById(c.env.DB, id);
  if (!user) throw new HttpError(404, '用户不存在');
  const body = (await c.req.json().catch(() => ({}))) as {
    status?: 'active' | 'disabled';
    role?: 'user' | 'admin';
    member_plan?: UserRow['member_plan'];
    member_expires_at?: number | null;
    password?: string;
  };
  const patch: Parameters<typeof updateUser>[2] = {};
  if (body.status === 'active' || body.status === 'disabled') patch.status = body.status;
  if (body.role === 'user' || body.role === 'admin') patch.role = body.role;
  if (body.member_plan === 'none' || body.member_plan === 'trial' || body.member_plan === 'paid' || body.member_plan === 'lifetime') {
    patch.member_plan = body.member_plan;
  }
  if (body.member_expires_at !== undefined) {
    patch.member_expires_at = body.member_expires_at ? Number(body.member_expires_at) : null;
  }
  if (patch.member_plan === 'lifetime') patch.member_expires_at = null;
  if (body.password !== undefined) {
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) {
      throw new HttpError(422, '密码至少 8 位（最多 128 位）');
    }
    patch.password_hash = await hashPassword(body.password);
  }
  const updated = await updateUser(c.env.DB, id, patch);
  const { password_hash, ...safe } = updated!;
  void password_hash;
  return c.json({ user: safe });
});

// ---------------- 套餐管理 ----------------

adminApi.get('/plans', async (c) => {
  return c.json({ plans: await listPlans(c.env.DB) });
});

adminApi.post('/plans', async (c) => {
  const body = await parsePlanBody(c);
  const plan = await createPlan(c.env.DB, body);
  return c.json({ plan }, 201);
});

adminApi.put('/plans/:id', async (c) => {
  const id = c.req.param('id');
  if (!(await getPlan(c.env.DB, id))) throw new HttpError(404, '套餐不存在');
  const body = await parsePlanBody(c);
  const plan = await updatePlan(c.env.DB, id, body);
  return c.json({ plan });
});

adminApi.delete('/plans/:id', async (c) => {
  const id = c.req.param('id');
  if (!(await getPlan(c.env.DB, id))) throw new HttpError(404, '套餐不存在');
  await deletePlan(c.env.DB, id);
  return c.json({ ok: true });
});

async function parsePlanBody(c: { req: { json(): Promise<unknown> } }) {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string; price_usd?: number; period_type?: PlanPeriod; duration_months?: number | null;
    description?: string; sort?: number; enabled?: boolean | number;
  };
  if (!body.name?.trim()) throw new HttpError(422, '套餐名称不能为空');
  if (!['month', 'quarter', 'year', 'lifetime'].includes(body.period_type ?? '')) throw new HttpError(422, 'period_type 非法');
  const price = Number(body.price_usd);
  if (!Number.isFinite(price) || price <= 0) throw new HttpError(422, '价格必须为正数');
  let duration = body.duration_months == null ? null : Number(body.duration_months);
  if (body.period_type !== 'lifetime') {
    duration = duration && duration >= 1 ? Math.floor(duration) : 1;
  } else {
    duration = null;
  }
  return {
    name: body.name.trim(),
    price_usd: price,
    period_type: body.period_type!,
    duration_months: duration,
    description: body.description?.trim() ? body.description.trim() : null,
    sort: Number(body.sort) || 0,
    enabled: body.enabled === false || body.enabled === 0 ? 0 : 1,
  } satisfies Parameters<typeof createPlan>[1];
}

// ---------------- 订单管理 ----------------

adminApi.get('/orders', async (c) => {
  const status = c.req.query('status') as 'pending' | 'paid' | 'expired' | undefined;
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);
  const orders = await listOrders(c.env.DB, { status, page, pageSize: 20 });
  return c.json({ orders, page });
});

// ---------------- 设置 ----------------

const MASKED = new Set(['smtp_pass', 'epay_key', 'google_client_secret', 'microsoft_client_secret', 'agently_bridge_token']);

adminApi.get('/settings', async (c) => {
  const all = await listSettings(c.env.DB);
  for (const k of MASKED) if (all[k]) all[k] = '********';
  return c.json({ settings: all });
});

/** PUT /settings { key: value }；敏感字段传 '*' 表示保留原值 */
adminApi.put('/settings', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const allowed = new Set([
    'site_name', 'allow_registration', 'admin_emails',
    'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from',
    'epay_api_url', 'epay_pid', 'epay_key', 'epay_pay_types', 'epay_sign_mode',
    'google_client_id', 'google_client_secret', 'microsoft_client_id', 'microsoft_client_secret',
    'agently_bridge_url', 'agently_bridge_token',
    'quota_free_accounts', 'quota_free_rules', 'quota_paid_accounts', 'quota_paid_rules',
  ]);
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.has(k)) continue;
    if (v === '*' || v === undefined) continue;
    if (v === null || v === '') {
      await setSetting(c.env.DB, k, '');
      continue;
    }
    const value = String(v);
    if (MASKED.has(k) && value === '********') continue; // 前端回显的掩码
    await setSetting(c.env.DB, k, value);
  }
  const all = await listSettings(c.env.DB);
  // 敏感值掩码后返回
  for (const k of MASKED) if (all[k]) all[k] = '********';
  return c.json({ settings: all });
});

/** 供公开设置查询复用 */
export async function publicSettings(c: { env: AppBindings['Bindings'] }) {
  const get = (k: string, d: string) => getSetting(c.env.DB, k).then((v) => v ?? d);
  const [site_name, allow_registration, smtp_configured] = await Promise.all([
    get('site_name', 'MailSorta'),
    get('allow_registration', '1'),
    getSetting(c.env.DB, 'smtp_host').then((v) => (v ? '1' : '0')),
  ]);
  return { site_name, allow_registration, smtp_configured };
}

export type { PlanRow };
