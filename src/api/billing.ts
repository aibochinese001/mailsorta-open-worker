import { Hono } from 'hono';
import type { AppBindings, Env } from '../env';
import { getUser } from '../middleware/auth';
import { HttpError } from '../middleware/errors';
import {
  createOrder, expireOrder, getOrderById, getOrderByOutTradeNo, getPlan, getUserById,
  listOrdersByUser, markOrderPaid, updateUser,
} from '../db/queries';
import { applyPlanDuration, memberStatus, ORDER_EXPIRE_MS, quotaFor } from '../billing/service';
import { buildPayUrl, getEpayConfig, getEnabledPayTypes, PAY_TYPES, queryOrder, verifyNotify } from '../payment/epay';
import { paymentSuccessMail, sendTemplateMail } from '../email/smtp';

export const billingApi = new Hono<AppBindings>();

/** 订单履约：标记已支付 + 更新会员 + 发送通知邮件（幂等） */
async function fulfillOrder(env: Env, orderId: string, tradeNo: string): Promise<void> {
  await markOrderPaid(env.DB, orderId, tradeNo);
  const order = await getOrderById(env.DB, orderId);
  if (!order) return;
  const plan = order.plan_id ? await getPlan(env.DB, order.plan_id) : null;
  const user = order.user_id ? await getUserById(env.DB, order.user_id) : null;
  if (plan && user) {
    const dur = applyPlanDuration(user, plan);
    await updateUser(env.DB, user.id, { member_plan: dur.plan, member_expires_at: dur.expires_at });
    console.log(`[billing:fulfill] 会员已更新: user=${user.email} plan=${dur.plan} expires=${dur.expires_at ?? '永久'}`);
    const until = dur.plan === 'lifetime' ? '永久有效' : dur.expires_at ? new Date(dur.expires_at).toLocaleDateString('zh-CN') : '';
    const mail = paymentSuccessMail(plan.name, until);
    await sendTemplateMail(env, user.email, mail.subject, mail.html).catch((e) => console.error('[billing:fulfill] 邮件发送失败', e));
  }
}

/** 公开：启用中的套餐列表（供未登录用户浏览） */
billingApi.get('/plans', async (c) => {
  const { listPlans } = await import('../db/queries');
  const plans = await listPlans(c.env.DB, true);
  const payTypes = await getEnabledPayTypes(c.env);
  return c.json({ plans, currency: 'USD', pay_types: payTypes.map((t) => ({ key: t, label: PAY_TYPES[t] })) });
});

/** 下单：返回 payUrl 供前端跳转易支付收银台 */
billingApi.post('/checkout', async (c) => {
  const u = getUser(c);
  const body = (await c.req.json().catch(() => ({}))) as { plan_id?: string; pay_type?: string };
  if (!body.plan_id) throw new HttpError(422, '缺少套餐');
  const plan = await getPlan(c.env.DB, body.plan_id);
  if (!plan || !plan.enabled) throw new HttpError(404, '套餐不存在或已下架');

  const epay = await getEpayConfig(c.env);
  if (!epay) throw new HttpError(503, '支付通道未配置，请联系管理员');

  const user = await getUserById(c.env.DB, u.id);
  if (!user) throw new HttpError(401, '用户不存在');

  const payType = body.pay_type ?? 'alipay';
  const enabledTypes = await getEnabledPayTypes(c.env);
  if (!enabledTypes.includes(payType)) throw new HttpError(422, '不支持的支付方式');
  const outTradeNo = `MS${Date.now()}${crypto.getRandomValues(new Uint32Array(1))[0]}`;
  const base = c.env.APP_BASE_URL.replace(/\/$/, '');

  // USD 直接作为易支付收款金额（微信/支付宝通道自带汇率换算，无需折算 CNY）
  const order = await createOrder(c.env.DB, {
    user_id: user.id,
    plan_id: plan.id,
    plan_name: plan.name,
    period_type: plan.period_type,
    duration_months: plan.duration_months,
    price_usd: plan.price_usd,
    pay_type: payType,
    out_trade_no: outTradeNo,
  });

  const payUrl = await buildPayUrl(epay, {
    type: payType,
    out_trade_no: outTradeNo,
    notify_url: `${base}/api/billing/notify`,
    return_url: `${base}/api/billing/return`,
    name: `${plan.name} · ${user.email}`,
    money: String(plan.price_usd),
  });
  return c.json({ order, payUrl, currency: 'USD' }, 201);
});

/** 公开：易支付异步通知（验签 + 幂等履约）。同时支持 POST 和 GET 回调。 */
async function handleNotify(c: any): Promise<Response> {
  const epay = await getEpayConfig(c.env);
  if (!epay) return c.text('fail');

  // 同时支持 POST(form/json) 和 GET(query) 回调
  let params: Record<string, string> = {};
  if (c.req.method === 'GET') {
    const q = c.req.query();
    for (const [k, v] of Object.entries(q)) params[k] = String(v);
  } else {
    const ct = c.req.header('content-type') ?? '';
    if (ct.includes('application/json')) {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) params[k] = String(v ?? '');
    } else {
      const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) params[k] = String(v ?? '');
    }
  }

  // 回调日志（不含 sign）
  const logParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (k !== 'sign') logParams[k] = v;
  console.log('[billing:notify] 收到回调', JSON.stringify(logParams));

  const ok = await verifyNotify(params, epay.key, epay.sign_mode);
  if (!ok) {
    console.error('[billing:notify] 验签失败');
    return c.text('fail');
  }

  // 兼容多种支付成功状态字段
  const tradeStatus = (params['trade_status'] ?? params['status'] ?? params['pay_status'] ?? '').toUpperCase();
  const isPaid = tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'SUCCESS' || tradeStatus === '1' || tradeStatus === 'PAID';
  if (!isPaid) {
    console.error(`[billing:notify] 非支付成功状态: trade_status=${tradeStatus}`);
    return c.text('fail');
  }

  const outTradeNo = params['out_trade_no'] ?? params['outTradeNo'];
  const order = outTradeNo ? await getOrderByOutTradeNo(c.env.DB, outTradeNo) : null;
  if (!order) {
    console.error(`[billing:notify] 订单不存在: out_trade_no=${outTradeNo}`);
    return c.text('fail');
  }
  if (order.status === 'paid') return c.text('success'); // 幂等

  // 金额校验：payone.uk 等通道会做汇率换算（USD→CNY），回调金额与下单金额必然不同。
  // 验签通过已保证请求合法性，这里只做宽松校验（差异不超过 100 倍即视为合理汇率换算）。
  const money = Number(params['money'] ?? params['price'] ?? '0');
  if (money > 0 && order.price_usd > 0) {
    const ratio = Math.max(money, order.price_usd) / Math.min(money, order.price_usd);
    if (ratio > 100) {
      console.error(`[billing:notify] 金额异常: order=${order.price_usd} notify=${money} ratio=${ratio.toFixed(1)}`);
      return c.text('fail');
    }
    if (ratio > 1.05) {
      console.log(`[billing:notify] 金额差异（汇率换算）: order_usd=${order.price_usd} notify=${money}`);
    }
  }

  const tradeNo = params['trade_no'] ?? params['tradeNo'] ?? params['payId'] ?? '';
  await fulfillOrder(c.env, order.id, tradeNo);
  return c.text('success');
}

billingApi.post('/notify', handleNotify);
billingApi.get('/notify', handleNotify);

/** 公开：支付后回跳（重定向到前端 billing 页，前端轮询订单状态） */
billingApi.get('/return', async (c) => {
  const outTradeNo = c.req.query('out_trade_no') ?? c.req.query('outTradeNo');
  const base = c.env.APP_BASE_URL.replace(/\/$/, '');
  return Response.redirect(`${base}/#/billing${outTradeNo ? `?pay=${outTradeNo}` : ''}`, 302);
});

/** 我的订单 */
billingApi.get('/orders', async (c) => {
  const u = getUser(c);
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);
  const orders = await listOrdersByUser(c.env.DB, u.id, page, 20);
  return c.json({ orders });
});

/** 订单详情 + 主动查单兜底 + 惰性过期 */
billingApi.get('/orders/:id', async (c) => {
  const u = getUser(c);
  const order = await getOrderById(c.env.DB, c.req.param('id'));
  if (!order || order.user_id !== u.id) throw new HttpError(404, '订单不存在');

  if (order.status === 'pending') {
    const age = Date.now() - order.created_at;
    // 超过 30 秒主动向易支付查单（防止异步通知丢失）
    if (age > 30_000) {
      const epay = await getEpayConfig(c.env);
      const remote = epay ? await queryOrder(epay, order.out_trade_no) : null;
      if (remote && remote.code === 1 && remote.status === 1) {
        console.log(`[billing:order] 主动查单发现已支付: ${order.out_trade_no}`);
        await fulfillOrder(c.env, order.id, remote.trade_no ?? '');
      } else if (age > ORDER_EXPIRE_MS) {
        // 超过 2 小时且查单确认未支付，标记过期
        await expireOrder(c.env.DB, order.id);
      }
    }
    const fresh = await getOrderById(c.env.DB, order.id);
    return c.json({ order: fresh, member: fresh ? memberStatus((await getUserById(c.env.DB, u.id))!) : null });
  }
  return c.json({ order, member: memberStatus((await getUserById(c.env.DB, u.id))!) });
});

/** 当前会员与配额概览 */
billingApi.get('/me', async (c) => {
  const u = getUser(c);
  const user = await getUserById(c.env.DB, u.id);
  if (!user) throw new HttpError(401, '用户不存在');
  const member = memberStatus(user);
  const quota = await quotaFor(c.env.DB, user);
  return c.json({ member, quota, user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role } });
});
