import type { ErrorHandler, NotFoundHandler } from 'hono';
import type { AppBindings } from '../env';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const errorHandler: ErrorHandler<AppBindings> = (err, c) => {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  if (status >= 500) {
    console.error(`[error] ${err instanceof Error ? err.stack ?? err.message : err}`);
  }
  return c.json({ error: message, code: status >= 500 ? 'INTERNAL' : 'ERROR' }, status as 400 | 401 | 403 | 404 | 409 | 422 | 500);
};

export const notFoundHandler: NotFoundHandler<AppBindings> = async (c) => {
  // API 未知路径：返回 JSON，便于前端/客户端处理
  if (new URL(c.req.url).pathname.startsWith('/api/')) {
    return c.json({ error: '接口不存在', code: 'NOT_FOUND' }, 404);
  }
  // 非 /api 路径回退到前端静态资源（SPA）
  const env = c.env;
  try {
    const res = await env.ASSETS.fetch(c.req.raw);
    if (res.status !== 404) return res;
    // SPA 路由回退到 index.html
    const index = await env.ASSETS.fetch(new Request(new URL('/', c.req.url)));
    if (index.status !== 404) return new Response(index.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  } catch {
    // 前端未构建时给出提示
  }
  return c.text('mailsorta-worker: 未找到资源（前端尚未构建，请先运行 cd frontend && npm run build）', 404);
};
