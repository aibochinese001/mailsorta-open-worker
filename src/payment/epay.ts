/**
 * 易支付（EPay）接口适配。
 * 标准协议：submit.php 下单 / api.php?act=order 查单 / 异步 notify 回调。
 * 签名：参与参数去除 sign、sign_type 与空值，按 key 字典序 k=v&...&key=商户密钥，MD5。
 * 本项目标价与收款均使用 USD，微信/支付宝等通道自带汇率换算，不做金额折算。
 */
import { getSetting } from '../db/queries';
import type { Env } from '../env';
import { md5Hex } from '../crypto/md5';

export interface EpayConfig {
  api_url: string;
  pid: string;
  key: string;
  sign_mode: 'standard' | 'direct'; // standard: &key=密钥（彩虹易支付）; direct: 直接拼接密钥（payone.uk 等）
}

/** 易支付支付方式：key 为下单 type 参数值 */
export const PAY_TYPES: Record<string, string> = {
  alipay: '支付宝',
  wxpay: '微信支付',
  gmpay: 'USDT',
  fiatstripe: 'Stripe',
  ecny: 'e-CNY',
};

/** 读取管理后台勾选的启用支付方式（逗号分隔；未配置时默认全开） */
export async function getEnabledPayTypes(env: Env): Promise<string[]> {
  const raw = (await getSetting(env.DB, 'epay_pay_types')) ?? 'alipay,wxpay,gmpay,fiatstripe';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => Object.prototype.hasOwnProperty.call(PAY_TYPES, s));
}

export async function getEpayConfig(env: Env): Promise<EpayConfig | null> {
  const api_url = (await getSetting(env.DB, 'epay_api_url')) ?? '';
  const pid = (await getSetting(env.DB, 'epay_pid')) ?? '';
  const key = (await getSetting(env.DB, 'epay_key')) ?? '';
  const sign_mode_raw = (await getSetting(env.DB, 'epay_sign_mode')) ?? 'standard';
  const sign_mode: 'standard' | 'direct' = sign_mode_raw === 'direct' ? 'direct' : 'standard';
  if (!api_url || !pid || !key) return null;
  return { api_url: api_url.replace(/\/+$/, ''), pid, key, sign_mode };
}

export async function md5hex(s: string): Promise<string> {
  return md5Hex(s);
}

/**
 * 易支付签名。
 * standard 模式（彩虹易支付默认）：字典序 k=v 拼接 + &key=密钥，MD5。
 * direct 模式（payone.uk 等）：字典序 k=v 拼接后直接拼接密钥（无 &key= 前缀），MD5。
 */
export async function epaySign(
  params: Record<string, string>,
  key: string,
  sign_mode: 'standard' | 'direct' = 'standard',
): Promise<string> {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === 'sign' || k === 'sign_type' || v === '' || v == null) continue;
    filtered[k] = String(v);
  }
  const str = Object.keys(filtered)
    .sort()
    .map((k) => `${k}=${filtered[k]}`)
    .join('&');
  const signStr = sign_mode === 'direct' ? `${str}${key}` : `${str}&key=${key}`;
  return md5hex(signStr);
}

export interface PayRequest {
  type: string; // alipay / wxpay / gmpay / fiatstripe ...
  out_trade_no: string;
  notify_url: string;
  return_url: string;
  name: string;
  money: string; // USD（通道自带汇率换算）
}

/** 生成下单跳转地址（submit.php） */
export async function buildPayUrl(cfg: EpayConfig, p: PayRequest): Promise<string> {
  const params: Record<string, string> = {
    pid: cfg.pid,
    type: p.type,
    out_trade_no: p.out_trade_no,
    notify_url: p.notify_url,
    return_url: p.return_url,
    name: p.name,
    money: p.money,
  };
  const sign = await epaySign(params, cfg.key, cfg.sign_mode);
  const qs = new URLSearchParams({ ...params, sign, sign_type: 'MD5' }).toString();
  return `${cfg.api_url}/submit.php?${qs}`;
}

/** 验签（notify/return 共用） */
export async function verifyNotify(
  params: Record<string, string>,
  key: string,
  sign_mode: 'standard' | 'direct' = 'standard',
): Promise<boolean> {
  const sign = params['sign'];
  if (!sign) return false;
  const expected = await epaySign(params, key, sign_mode);
  return expected.toLowerCase() === sign.toLowerCase();
}

/** 主动查单（api.php?act=order） */
export async function queryOrder(
  cfg: EpayConfig,
  outTradeNo: string,
): Promise<{ code: number; status?: number; trade_no?: string; money?: string } | null> {
  try {
    const url = new URL(`${cfg.api_url}/api.php`);
    url.searchParams.set('act', 'order');
    url.searchParams.set('pid', cfg.pid);
    url.searchParams.set('key', cfg.key);
    url.searchParams.set('out_trade_no', outTradeNo);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { code: number; status?: number; trade_no?: string; money?: string };
    return data;
  } catch {
    return null;
  }
}
