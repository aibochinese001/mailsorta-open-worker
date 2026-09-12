import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { runSyncAll } from '../sync/orchestrator';
import { countSyncLogs, listSyncLogs, getUserById } from '../db/queries';
import { getUser } from '../middleware/auth';
import { HttpError } from '../middleware/errors';
import { memberStatus } from '../billing/service';

export const syncApi = new Hono<AppBindings>();

/** 手动触发整理：POST /api/sync/run { rule_id? } */
syncApi.post('/run', async (c) => {
  const u = getUser(c);
  const owner = await getUserById(c.env.DB, u.id);
  if (owner && memberStatus(owner).level === 'free') {
    throw new HttpError(403, '会员已到期，续费后才能继续整理（历史数据仍可查询与导出）');
  }
  const body = (await c.req.json().catch(() => ({}))) as { rule_id?: string };
  const outcomes = await runSyncAll(c.env, { trigger: 'manual', ruleId: body.rule_id, userId: u.id });
  return c.json({ outcomes });
});

syncApi.get('/logs', async (c) => {
  const u = getUser(c);
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query('page_size') ?? '15') || 15));
  const [logs, total] = await Promise.all([
    listSyncLogs(c.env.DB, u.id, pageSize, (page - 1) * pageSize),
    countSyncLogs(c.env.DB, u.id),
  ]);
  return c.json({ logs, total, page, page_size: pageSize });
});
