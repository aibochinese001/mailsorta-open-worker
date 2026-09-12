import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../env';

/** 简单 API 限流：按客户端 IP + 分钟，KV 计数，默认 120 次/分 */
export const apiRateLimit = createMiddleware<AppBindings>(async (c, next) => {
  try {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'local';
    const minute = Math.floor(Date.now() / 60_000);
    const key = `rl:api:${ip}:${minute}`;
    const raw = await c.env.KV.get(key);
    const count = raw ? Number(raw) : 0;
    if (count >= 120) {
      return c.json({ error: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED' }, 429);
    }
    await c.env.KV.put(key, String(count + 1), { expirationTtl: 180 });
  } catch {
    // KV 异常不阻断请求
  }
  await next();
});
