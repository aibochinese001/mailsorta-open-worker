import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings } from '../env';
import type { FieldDef } from '../sync/extractor';
import { parseFields, extractFields } from '../sync/extractor';
import { matchSender } from '../sync/match';
import { getConnector } from '../connectors/registry';
import {
  countRulesByUser, createRule, deleteRule, getAccountOwned, getRule, listAccounts, listEmails,
  listRules, updateRule,
} from '../db/queries';
import { getUserById } from '../db/queries';
import { quotaFor } from '../billing/service';
import type { RuleRow } from '../db/types';
import { getUser } from '../middleware/auth';
import { HttpError } from '../middleware/errors';

type Ctx = Context<AppBindings>;

export const rulesApi = new Hono<AppBindings>();

function validateFields(fields: unknown): FieldDef[] {
  if (!Array.isArray(fields)) throw new HttpError(422, 'fields 必须是数组');
  const out: FieldDef[] = [];
  for (const f of fields) {
    const x = f as FieldDef;
    if (!x || typeof x.key !== 'string' || !x.key.trim()) throw new HttpError(422, '字段缺少 key');
    if (typeof x.label !== 'string' || !x.label.trim()) throw new HttpError(422, `字段 ${x.key} 缺少 label`);
    if (!['header', 'body_regex', 'llm'].includes(x.source)) throw new HttpError(422, `字段 ${x.key} 的 source 非法`);
    out.push({ key: x.key.trim(), label: x.label.trim(), source: x.source, header: x.header, pattern: x.pattern, required: !!x.required });
  }
  return out;
}

function parseRuleInput(body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim();
  const account_id = String(body.account_id ?? '');
  const sender_mode = body.sender_mode as 'exact' | 'domain' | 'regex';
  const sender_pattern = String(body.sender_pattern ?? '').trim();
  const schedule_mode = body.schedule_mode as 'interval' | 'on_receive';
  const interval_minutes = body.interval_minutes == null ? null : Number(body.interval_minutes);
  const enabled = body.enabled == null ? 1 : body.enabled ? 1 : 0;
  const dedupe = body.dedupe == null ? 1 : body.dedupe ? 1 : 0;

  if (!name) throw new HttpError(422, '规则名不能为空');
  if (!account_id) throw new HttpError(422, '必须选择邮箱账号');
  if (!['exact', 'domain', 'regex'].includes(sender_mode)) throw new HttpError(422, 'sender_mode 非法');
  if (!sender_pattern) throw new HttpError(422, '发件人匹配不能为空');
  if (sender_mode === 'regex') {
    try {
      new RegExp(sender_pattern);
    } catch {
      throw new HttpError(422, '发件人正则不合法');
    }
  }
  if (!['interval', 'on_receive'].includes(schedule_mode)) throw new HttpError(422, 'schedule_mode 非法');
  if (schedule_mode === 'interval' && (!interval_minutes || interval_minutes < 1)) {
    throw new HttpError(422, 'interval 模式必须设置间隔分钟数(≥1)');
  }
  const fields_json = JSON.stringify(validateFields(body.fields));
  return { name, account_id, sender_mode, sender_pattern, schedule_mode, interval_minutes, enabled, dedupe, fields_json };
}

async function decorateRules(c: Ctx, rules: RuleRow[], userId: string) {
  const accounts = await listAccounts(c.env.DB, userId);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return rules.map((r) => ({
    ...r,
    account_email: byId.get(r.account_id)?.email ?? null,
    fields: parseFields(r.fields_json),
  }));
}

rulesApi.get('/', async (c) => {
  const u = getUser(c);
  const rules = await listRules(c.env.DB, u.id);
  return c.json({ rules: await decorateRules(c, rules, u.id) });
});

rulesApi.get('/:id', async (c) => {
  const u = getUser(c);
  const rule = await getRule(c.env.DB, c.req.param('id'));
  if (!rule || rule.user_id !== u.id) throw new HttpError(404, '规则不存在');
  return c.json({ rule: (await decorateRules(c, [rule], u.id))[0] });
});

rulesApi.post('/', async (c) => {
  const u = getUser(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = parseRuleInput(body);
  const account = await getAccountOwned(c.env.DB, input.account_id, u.id);
  if (!account) throw new HttpError(404, '账号不存在');

  const user = await getUserById(c.env.DB, u.id);
  if (!user) throw new HttpError(401, '用户不存在');
  const quota = await quotaFor(c.env.DB, user);
  const count = await countRulesByUser(c.env.DB, u.id);
  if (count >= quota.rules) throw new HttpError(402, `规则数量已达上限（${quota.rules}），请升级会员`);

  const rule = await createRule(c.env.DB, { ...input, user_id: u.id });
  return c.json({ rule: (await decorateRules(c, [rule], u.id))[0] }, 201);
});

rulesApi.put('/:id', async (c) => {
  const u = getUser(c);
  const id = c.req.param('id');
  const existing = await getRule(c.env.DB, id);
  if (!existing || existing.user_id !== u.id) throw new HttpError(404, '规则不存在');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = parseRuleInput(body);
  const account = await getAccountOwned(c.env.DB, input.account_id, u.id);
  if (!account) throw new HttpError(404, '账号不存在');
  const rule = await updateRule(c.env.DB, id, input);
  return c.json({ rule: rule ? (await decorateRules(c, [rule], u.id))[0] : null });
});

rulesApi.delete('/:id', async (c) => {
  const u = getUser(c);
  const id = c.req.param('id');
  const existing = await getRule(c.env.DB, id);
  if (!existing || existing.user_id !== u.id) throw new HttpError(404, '规则不存在');
  await c.env.DB.prepare('DELETE FROM emails WHERE rule_id = ?').bind(id).run();
  await deleteRule(c.env.DB, id);
  return c.json({ ok: true });
});

/** 试跑：拉最近邮件做字段提取预览（不改库）；失败时回退最近入库的样本 */
rulesApi.post('/:id/test', async (c) => {
  const u = getUser(c);
  const rule = await getRule(c.env.DB, c.req.param('id'));
  if (!rule || rule.user_id !== u.id) throw new HttpError(404, '规则不存在');
  const fields = parseFields(rule.fields_json);
  const samples: { sender: string | null; subject: string | null; receivedAt: number | null; extracted: Record<string, string | null> }[] = [];

  try {
    const account = await getAccountOwned(c.env.DB, rule.account_id, u.id);
    if (account && account.status === 'active') {
      const connector = getConnector(account.provider);
      const summaries = await connector.listSummaries(c.env, account.id, {
        senderPattern: rule.sender_pattern,
        senderMode: rule.sender_mode,
        maxResults: 10,
      });
      for (const s of summaries) {
        if (!matchSender(rule.sender_pattern, rule.sender_mode, s.sender)) continue;
        if (samples.length >= 3) break;
        const full = await connector.getMessage(c.env, account.id, s.id);
        if (!full) continue;
        const extracted = await extractFields(c.env, fields, full, u.id);
        samples.push({
          sender: full.summary.sender,
          subject: full.summary.subject ?? null,
          receivedAt: full.summary.receivedAt,
          extracted,
        });
      }
    }
  } catch (e) {
    // 实时抓取失败（未授权/限流/桥接未起），回退存储样本
  }

  if (samples.length === 0) {
    const stored = await listEmails(c.env.DB, { user_id: u.id, rule_id: rule.id }, 1, 3);
    for (const e of stored) {
      let extracted: Record<string, string | null> = {};
      try {
        extracted = e.extracted_json ? JSON.parse(e.extracted_json) : {};
      } catch {
        extracted = {};
      }
      samples.push({ sender: e.sender, subject: e.subject, receivedAt: e.received_at, extracted });
    }
  }

  return c.json({ fields, samples, live: samples.length > 0 });
});
