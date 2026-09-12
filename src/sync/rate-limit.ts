import type { Env } from '../env';
import type { Provider } from '../db/types';
import { RateLimitHitError } from '../connectors/types';

/**
 * 按 Provider 的 KV 分钟级令牌桶。
 * Agently 官方限流 10 次/分、200 次/时 —— 我们按 8 次/分留出安全余量；
 * Gmail/Outlook 官方配额高，按 150 次/分兜底；
 * QQ/163/126 IMAP 对第三方客户端连接频率敏感，按 6 次/分保守限流。
 */
const PROVIDER_LIMITS: Record<Provider, number> = {
  gmail: 150,
  outlook: 150,
  agently: 8,
  imap: 6,
};

export async function rateLimitCheck(env: Env, provider: Provider): Promise<void> {
  const limit = PROVIDER_LIMITS[provider] ?? 60;
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rl:${provider}:${minute}`;

  const raw = await env.KV.get(key);
  const count = raw ? Number(raw) : 0;
  if (count >= limit) {
    throw new RateLimitHitError(`${provider} 已到达分钟级限流（${limit}/分），本轮跳过`);
  }
  await env.KV.put(key, String(count + 1), { expirationTtl: 180 });
}

/** 全局同步锁：防止 cron 与手动触发重叠执行 */
export async function tryAcquireSyncLock(env: Env): Promise<boolean> {
  const key = 'sync:lock';
  const existing = await env.KV.get(key);
  if (existing) return false;
  await env.KV.put(key, '1', { expirationTtl: 120 });
  return true;
}

export async function releaseSyncLock(env: Env): Promise<void> {
  await env.KV.delete('sync:lock');
}
