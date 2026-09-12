/**
 * 会员 / 试用 / 配额 / 订单履约 业务服务。
 */
import { getSetting } from '../db/queries';
import type { PlanRow, UserRow } from '../db/types';

export const TRIAL_DAYS = 7;

export interface MemberInfo {
  level: 'free' | 'trial' | 'paid' | 'lifetime';
  plan: UserRow['member_plan'];
  expires_at: number | null;
}

/** 当前会员等级：试用期与付费期享有同等配额 */
export function memberStatus(user: UserRow): MemberInfo {
  const nowMs = Date.now();
  if (user.member_plan === 'lifetime') return { level: 'lifetime', plan: 'lifetime', expires_at: null };
  if ((user.member_plan === 'trial' || user.member_plan === 'paid') && user.member_expires_at && user.member_expires_at > nowMs) {
    return { level: user.member_plan, plan: user.member_plan, expires_at: user.member_expires_at };
  }
  return { level: 'free', plan: user.member_plan, expires_at: user.member_expires_at };
}

export function isPaid(user: UserRow): boolean {
  const m = memberStatus(user);
  return m.level === 'paid' || m.level === 'lifetime';
}

export interface Quota {
  accounts: number;
  rules: number;
}

/** 配额（settings 可覆盖，默认：免费 1 账号/5 规则；付费 20 账号/200 规则） */
export async function quotaFor(db: D1Database, user: UserRow): Promise<Quota> {
  const paid = isPaid(user);
  const read = async (k: string, d: number) => Number((await getSetting(db, k)) ?? '') || d;
  return paid
    ? { accounts: await read('quota_paid_accounts', 20), rules: await read('quota_paid_rules', 200) }
    : { accounts: await read('quota_free_accounts', 1), rules: await read('quota_free_rules', 5) };
}

/** 把套餐时长叠加到用户会员（续费从当前到期日顺延；永久直接置 lifetime） */
export function applyPlanDuration(user: UserRow, plan: PlanRow): { plan: UserRow['member_plan']; expires_at: number | null } {
  const nowMs = Date.now();
  if (plan.period_type === 'lifetime') {
    return { plan: 'lifetime', expires_at: null };
  }
  const months = plan.duration_months ?? 1;
  const base = user.member_expires_at && user.member_expires_at > nowMs ? user.member_expires_at : nowMs;
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return { plan: 'paid', expires_at: d.getTime() };
}

export const ORDER_EXPIRE_MS = 2 * 3600 * 1000; // 未支付订单 2 小时后过期
