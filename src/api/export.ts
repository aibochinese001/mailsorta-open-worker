import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { buildCsv, buildXlsxBuffer, CSV_MIME, emailToRow, exportEmails, XLSX_MIME, type ExportFilters } from '../export/xlsx';
import { listEmails, listRules } from '../db/queries';
import { getUser } from '../middleware/auth';
import { HttpError } from '../middleware/errors';

export const exportApi = new Hono<AppBindings>();

function filtersFromQuery(q: Record<string, string | undefined>, userId: string): ExportFilters {
  return {
    user_id: userId,
    rule_id: q.rule_id || undefined,
    account_id: q.account_id || undefined,
    sender: q.sender || undefined,
    subject: q.subject || undefined,
    date_from: q.date_from ? Number(q.date_from) : undefined,
    date_to: q.date_to ? Number(q.date_to) : undefined,
  };
}

function attachmentName(ext: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `mailsorta-${stamp}.${ext}`;
}

exportApi.get('/xlsx', async (c) => {
  const u = getUser(c);
  const filters = filtersFromQuery(c.req.query(), u.id);
  const rules = await listRules(c.env.DB, u.id);
  const rulesById = new Map(rules.map((r) => [r.id, r]));
  const result = await exportEmails(c.env, filters, rulesById, u.id);

  if (result.kind === 'r2') {
    return c.json({ kind: 'r2', total: result.total, exportId: result.exportId, downloadUrl: `/api/export/download/${result.exportId}` });
  }
  return new Response(result.buffer!, {
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${attachmentName('xlsx')}"`,
      'content-length': String(result.buffer!.byteLength),
    },
  });
});

exportApi.get('/csv', async (c) => {
  const u = getUser(c);
  const filters = filtersFromQuery(c.req.query(), u.id);
  const rules = await listRules(c.env.DB, u.id);
  const rulesById = new Map(rules.map((r) => [r.id, r]));
  const { total } = await exportEmails(c.env, filters, rulesById, u.id);
  // exportEmails 在 >20000 行时走 R2，CSV 场景直接用小批量重新生成
  if (total > 20_000) throw new HttpError(422, '数据量过大，请使用 Excel 导出（异步 R2 通道）');

  const rows: Record<string, unknown>[] = [];
  let page = 1;
  for (;;) {
    const emails = await listEmails(c.env.DB, filters, page, 500);
    if (emails.length === 0) break;
    for (const e of emails) rows.push(emailToRow(e, rulesById));
    if (emails.length < 500) break;
    page += 1;
  }
  const csv = '\uFEFF' + (await buildCsv(rows));
  return new Response(csv, {
    headers: {
      'content-type': CSV_MIME,
      'content-disposition': `attachment; filename="${attachmentName('csv')}"`,
    },
  });
});

exportApi.get('/download/:id', async (c) => {
  const u = getUser(c);
  const id = c.req.param('id');
  const obj = await c.env.R2.get(`exports/${u.id}/${id}.xlsx`);
  if (!obj) throw new HttpError(404, '导出文件不存在或已过期');
  return new Response(obj.body, {
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${attachmentName('xlsx')}"`,
    },
  });
});
