import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { countEmails, getAccountOwned, getEmail, getRule, listEmails, listRules, updateEmailExtracted } from '../db/queries';
import { parseFields, extractFields } from '../sync/extractor';
import { getConnector } from '../connectors/registry';
import { getUser } from '../middleware/auth';
import { HttpError } from '../middleware/errors';

export const emailsApi = new Hono<AppBindings>();

emailsApi.get('/', async (c) => {
  const u = getUser(c);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? '1') || 1);
  const page_size = Math.min(100, Math.max(1, Number(q.page_size ?? '20') || 20));
  const filters = {
    user_id: u.id,
    rule_id: q.rule_id || undefined,
    account_id: q.account_id || undefined,
    sender: q.sender || undefined,
    subject: q.subject || undefined,
    q: q.q || undefined,
    date_from: q.date_from ? Number(q.date_from) : undefined,
    date_to: q.date_to ? Number(q.date_to) : undefined,
  };
  const [items, total] = await Promise.all([
    listEmails(c.env.DB, filters, page, page_size),
    countEmails(c.env.DB, filters),
  ]);

  const rules = await listRules(c.env.DB, u.id);
  const rulesById = new Map(rules.map((r) => [r.id, r]));

  return c.json({
    items: items.map((e) => {
      const rule = rulesById.get(e.rule_id);
      let extracted: Record<string, string | null> = {};
      try {
        extracted = e.extracted_json ? JSON.parse(e.extracted_json) : {};
      } catch {
        extracted = {};
      }
      // 诊断字段（_ 开头）拆出，不污染业务字段展示
      const llm_error = extracted._llm_error ?? null;
      const fields: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(extracted)) {
        if (k.startsWith('_')) continue;
        fields[k] = v;
      }
      return {
        ...e,
        rule_name: rule?.name ?? null,
        fields: rule ? parseFields(rule.fields_json) : [],
        extracted: fields,
        llm_error,
      };
    }),
    total,
    page,
    page_size,
  });
});

emailsApi.get('/:id', async (c) => {
  const u = getUser(c);
  const email = await getEmail(c.env.DB, c.req.param('id'));
  if (!email || email.user_id !== u.id) throw new HttpError(404, '邮件不存在');
  const rules = await listRules(c.env.DB, u.id);
  const rule = rules.find((r) => r.id === email.rule_id);
  let extracted: Record<string, string | null> = {};
  try {
    extracted = email.extracted_json ? JSON.parse(email.extracted_json) : {};
  } catch {
    extracted = {};
  }
  const llm_error = extracted._llm_error ?? null;
  const fields: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(extracted)) {
    if (k.startsWith('_')) continue;
    fields[k] = v;
  }
  return c.json({
    ...email,
    rule_name: rule?.name ?? null,
    fields: rule ? parseFields(rule.fields_json) : [],
    extracted: fields,
    llm_error,
  });
});

/**
 * 重新提取：对已入库邮件重新拉取全文并跑字段提取（LLM 偶发失败后可手动补救）。
 * 需要该规则关联的账号仍可用（active）。
 */
emailsApi.post('/:id/re-extract', async (c) => {
  const u = getUser(c);
  const email = await getEmail(c.env.DB, c.req.param('id'));
  if (!email || email.user_id !== u.id) throw new HttpError(404, '邮件不存在');
  const rule = await getRule(c.env.DB, email.rule_id);
  if (!rule || rule.user_id !== u.id) throw new HttpError(404, '规则不存在');
  const account = await getAccountOwned(c.env.DB, rule.account_id, u.id);
  if (!account || account.status !== 'active') throw new HttpError(400, '邮箱账号不可用，无法重新提取');
  const connector = getConnector(account.provider);
  const full = await connector.getMessage(c.env, account.id, email.message_id);
  if (!full) throw new HttpError(502, '无法获取邮件全文，请稍后重试');

  const fields = parseFields(rule.fields_json);
  const extracted = await extractFields(c.env, fields, full, u.id);
  const llm_error = extracted._llm_error ?? null;
  const clean: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(extracted)) {
    if (k.startsWith('_')) continue;
    clean[k] = v;
  }
  await updateEmailExtracted(c.env.DB, email.id, JSON.stringify(extracted));
  return c.json({ ok: true, extracted: clean, llm_error });
});
