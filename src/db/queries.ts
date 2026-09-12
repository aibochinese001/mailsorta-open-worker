import type {
  AccountRow, EmailRow, OrderRow, OrderStatus, PlanPeriod, PlanRow, Provider, RuleRow,
  SettingsRow, SyncLogRow, UserRole, UserRow,
} from './types';

const now = () => Date.now();
const uuid = () => crypto.randomUUID();

// ---------------- users ----------------

export interface UserInput {
  email: string;
  password_hash: string;
  display_name: string | null;
  role: UserRole;
  status: UserRow['status'];
  member_plan: UserRow['member_plan'];
  member_expires_at: number | null;
}

export async function createUser(db: D1Database, u: UserInput): Promise<UserRow> {
  const id = uuid();
  const t = now();
  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, display_name, role, status, member_plan, member_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, u.email, u.password_hash, u.display_name, u.role, u.status, u.member_plan, u.member_expires_at, t, t)
    .run();
  return (await getUserById(db, id))!;
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return (await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>()) ?? null;
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return (await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>()) ?? null;
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return row?.n ?? 0;
}

export async function updateUser(
  db: D1Database,
  id: string,
  patch: Partial<
    Pick<
      UserRow,
      | 'display_name'
      | 'role'
      | 'status'
      | 'member_plan'
      | 'member_expires_at'
      | 'password_hash'
      | 'llm_api_url'
      | 'llm_api_key_enc'
      | 'llm_model'
    >
  >,
): Promise<UserRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(v);
  }
  if (sets.length === 0) return getUserById(db, id);
  sets.push('updated_at = ?');
  params.push(now(), id);
  await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
  return getUserById(db, id);
}

export async function touchLogin(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), id).run();
}

export async function listUsers(db: D1Database, opts: { search?: string; page?: number; pageSize?: number }): Promise<UserRow[]> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  let sql = 'SELECT * FROM users';
  const params: unknown[] = [];
  if (opts.search) {
    sql += ' WHERE email LIKE ? OR display_name LIKE ?';
    const like = `%${opts.search}%`;
    params.push(like, like);
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(pageSize, (page - 1) * pageSize);
  const res = await db.prepare(sql).bind(...params).all<UserRow>();
  return res.results ?? [];
}

export async function countPaidUsers(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM users
       WHERE status = 'active' AND member_plan = 'lifetime'
          OR status = 'active' AND member_plan = 'trial' AND member_expires_at > ?
          OR status = 'active' AND member_plan = 'paid' AND member_expires_at > ?`,
    )
    .bind(now(), now())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------- plans ----------------

export interface PlanInput {
  name: string;
  price_usd: number;
  period_type: PlanPeriod;
  duration_months: number | null;
  description: string | null;
  sort: number;
  enabled: number;
}

export async function listPlans(db: D1Database, enabledOnly = false): Promise<PlanRow[]> {
  const sql = enabledOnly ? "SELECT * FROM plans WHERE enabled = 1 ORDER BY sort ASC, price_usd ASC" : 'SELECT * FROM plans ORDER BY sort ASC, price_usd ASC';
  const res = await db.prepare(sql).all<PlanRow>();
  return res.results ?? [];
}

export async function getPlan(db: D1Database, id: string): Promise<PlanRow | null> {
  return (await db.prepare('SELECT * FROM plans WHERE id = ?').bind(id).first<PlanRow>()) ?? null;
}

export async function createPlan(db: D1Database, p: PlanInput): Promise<PlanRow> {
  const id = uuid();
  const t = now();
  await db
    .prepare(
      `INSERT INTO plans (id, name, price_usd, period_type, duration_months, description, sort, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, p.name, p.price_usd, p.period_type, p.duration_months, p.description, p.sort, p.enabled, t, t)
    .run();
  return (await getPlan(db, id))!;
}

export async function updatePlan(db: D1Database, id: string, p: PlanInput): Promise<PlanRow | null> {
  await db
    .prepare(
      `UPDATE plans SET name = ?, price_usd = ?, period_type = ?, duration_months = ?, description = ?, sort = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(p.name, p.price_usd, p.period_type, p.duration_months, p.description, p.sort, p.enabled, now(), id)
    .run();
  return getPlan(db, id);
}

export async function deletePlan(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM plans WHERE id = ?').bind(id).run();
}

// ---------------- orders ----------------

export interface OrderInput {
  user_id: string;
  plan_id: string;
  plan_name: string;
  period_type: PlanPeriod;
  duration_months: number | null;
  price_usd: number;
  pay_type: string;
  out_trade_no: string;
}

export async function createOrder(db: D1Database, o: OrderInput): Promise<OrderRow> {
  const id = uuid();
  const t = now();
  await db
    .prepare(
      `INSERT INTO orders (id, user_id, plan_id, plan_name, period_type, duration_months, price_usd,
                           currency, status, out_trade_no, pay_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, o.user_id, o.plan_id, o.plan_name, o.period_type, o.duration_months, o.price_usd,
      'USD', 'pending', o.out_trade_no, o.pay_type, t)
    .run();
  return (await getOrderById(db, id))!;
}

export async function getOrderById(db: D1Database, id: string): Promise<OrderRow | null> {
  return (await db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<OrderRow>()) ?? null;
}

export async function getOrderByOutTradeNo(db: D1Database, no: string): Promise<OrderRow | null> {
  return (await db.prepare('SELECT * FROM orders WHERE out_trade_no = ?').bind(no).first<OrderRow>()) ?? null;
}

export async function listOrdersByUser(db: D1Database, userId: string, page = 1, pageSize = 20): Promise<OrderRow[]> {
  const res = await db
    .prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .bind(userId, pageSize, (page - 1) * pageSize)
    .all<OrderRow>();
  return res.results ?? [];
}

export async function listOrders(db: D1Database, opts: { status?: OrderStatus; page?: number; pageSize?: number }): Promise<OrderRow[]> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  let sql = 'SELECT * FROM orders';
  const params: unknown[] = [];
  if (opts.status) {
    sql += ' WHERE status = ?';
    params.push(opts.status);
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(pageSize, (page - 1) * pageSize);
  const res = await db.prepare(sql).bind(...params).all<OrderRow>();
  return res.results ?? [];
}

export async function countOrders(db: D1Database, status?: OrderStatus): Promise<number> {
  const row = status
    ? await db.prepare('SELECT COUNT(*) AS n FROM orders WHERE status = ?').bind(status).first<{ n: number }>()
    : await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>();
  return row?.n ?? 0;
}

/** 最近已支付订单（管理后台收入统计；数据量受页面分页约束，统计口径以近 1000 单为准） */
export async function listPaidOrders(db: D1Database, limit = 1000): Promise<OrderRow[]> {
  const res = await db
    .prepare("SELECT * FROM orders WHERE status = 'paid' ORDER BY paid_at DESC LIMIT ?")
    .bind(limit)
    .all<OrderRow>();
  return res.results ?? [];
}

export async function markOrderPaid(db: D1Database, id: string, epayTradeNo: string): Promise<void> {
  await db
    .prepare('UPDATE orders SET status = ?, epay_trade_no = ?, paid_at = ? WHERE id = ?')
    .bind('paid', epayTradeNo, now(), id)
    .run();
}

export async function expireOrder(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE orders SET status = ? WHERE id = ? AND status = 'pending'")
    .bind('expired', id)
    .run();
}

// ---------------- settings ----------------

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT * FROM settings WHERE key = ?').bind(key).first<SettingsRow>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, value, now())
    .run();
}

export async function listSettings(db: D1Database): Promise<Record<string, string>> {
  const res = await db.prepare('SELECT * FROM settings').all<SettingsRow>();
  const out: Record<string, string> = {};
  for (const r of res.results ?? []) out[r.key] = r.value;
  return out;
}

// ---------------- accounts ----------------

export async function listAccounts(db: D1Database, userId?: string): Promise<AccountRow[]> {
  const res = userId
    ? await db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at ASC').bind(userId).all<AccountRow>()
    : await db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all<AccountRow>();
  return res.results ?? [];
}

export async function countAccountsByUser(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getAccount(db: D1Database, id: string): Promise<AccountRow | null> {
  return (await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<AccountRow>()) ?? null;
}

export async function getAccountOwned(db: D1Database, id: string, userId: string): Promise<AccountRow | null> {
  return (await db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').bind(id, userId).first<AccountRow>()) ?? null;
}

export async function getAccountByEmail(db: D1Database, email: string): Promise<AccountRow | null> {
  return (await db.prepare('SELECT * FROM accounts WHERE email = ?').bind(email).first<AccountRow>()) ?? null;
}

export async function upsertAccount(
  db: D1Database,
  a: Pick<AccountRow, 'user_id' | 'provider' | 'email' | 'display_name' | 'status' | 'scopes' | 'token_enc' | 'token_expires_at'> & Partial<Pick<AccountRow, 'imap_host' | 'imap_port'>>,
): Promise<string> {
  const id = uuid();
  const t = now();
  await db
    .prepare(
      `INSERT INTO accounts (id, user_id, provider, email, display_name, status, scopes, token_enc, token_expires_at, imap_host, imap_port, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         provider = excluded.provider,
         display_name = excluded.display_name,
         status = excluded.status,
         scopes = excluded.scopes,
         token_enc = excluded.token_enc,
         token_expires_at = excluded.token_expires_at,
         imap_host = excluded.imap_host,
         imap_port = excluded.imap_port,
         updated_at = excluded.updated_at`,
    )
    .bind(id, a.user_id, a.provider, a.email, a.display_name, a.status, a.scopes, a.token_enc, a.token_expires_at, a.imap_host ?? null, a.imap_port ?? null, t, t)
    .run();
  return id;
}

export async function updateAccountStatus(db: D1Database, id: string, status: AccountRow['status']): Promise<void> {
  await db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?').bind(status, now(), id).run();
}

export async function deleteAccount(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
}

// ---------------- rules ----------------

export async function listRules(db: D1Database, userId?: string, enabledOnly = false): Promise<RuleRow[]> {
  let sql = 'SELECT * FROM rules';
  const conds: string[] = [];
  const params: unknown[] = [];
  if (userId) { conds.push('user_id = ?'); params.push(userId); }
  if (enabledOnly) conds.push('enabled = 1');
  if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
  sql += ' ORDER BY created_at DESC';
  const res = await db.prepare(sql).bind(...params).all<RuleRow>();
  return res.results ?? [];
}

export async function countRulesByUser(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM rules WHERE user_id = ?').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listRulesByAccount(db: D1Database, accountId: string): Promise<RuleRow[]> {
  const res = await db.prepare('SELECT * FROM rules WHERE account_id = ? ORDER BY created_at DESC').bind(accountId).all<RuleRow>();
  return res.results ?? [];
}

export async function getRule(db: D1Database, id: string): Promise<RuleRow | null> {
  return (await db.prepare('SELECT * FROM rules WHERE id = ?').bind(id).first<RuleRow>()) ?? null;
}

export interface RuleInput {
  user_id: string;
  account_id: string;
  name: string;
  sender_mode: RuleRow['sender_mode'];
  sender_pattern: string;
  schedule_mode: RuleRow['schedule_mode'];
  interval_minutes: number | null;
  fields_json: string;
  dedupe: number;
  enabled: number;
}

export async function createRule(db: D1Database, r: RuleInput): Promise<RuleRow> {
  const id = uuid();
  const t = now();
  await db
    .prepare(
      `INSERT INTO rules (id, user_id, account_id, name, sender_mode, sender_pattern, schedule_mode, interval_minutes,
                          fields_json, dedupe, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, r.user_id, r.account_id, r.name, r.sender_mode, r.sender_pattern, r.schedule_mode,
      r.interval_minutes, r.fields_json, r.dedupe, r.enabled, now(), now(),
    )
    .run();
  return (await getRule(db, id))!;
}

export async function updateRule(db: D1Database, id: string, r: Omit<RuleInput, 'user_id'>): Promise<RuleRow | null> {
  await db
    .prepare(
      `UPDATE rules SET account_id = ?, name = ?, sender_mode = ?, sender_pattern = ?, schedule_mode = ?,
       interval_minutes = ?, fields_json = ?, dedupe = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      r.account_id, r.name, r.sender_mode, r.sender_pattern, r.schedule_mode,
      r.interval_minutes, r.fields_json, r.dedupe, r.enabled, now(), id,
    )
    .run();
  return getRule(db, id);
}

export async function updateRuleRunAt(db: D1Database, id: string, runAt: number): Promise<void> {
  await db.prepare('UPDATE rules SET last_run_at = ?, updated_at = ? WHERE id = ?').bind(runAt, now(), id).run();
}

export async function deleteRule(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM rules WHERE id = ?').bind(id).run();
}

// ---------------- emails ----------------

export interface EmailFilters {
  user_id?: string;
  rule_id?: string;
  account_id?: string;
  sender?: string;
  subject?: string;
  /** 关键词：匹配发件人 / 主题 / 提取字段内容（extracted_json LIKE） */
  q?: string;
  date_from?: number; // 毫秒时间戳
  date_to?: number;
}

function buildEmailWhere(f: EmailFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  // user_id 与关键词 q 的组合要防跨租户泄露：
  // SQL 无括号时 AND 优先级高于 OR，`uid=? AND sender LIKE ? OR subject LIKE ?` 会被解析为
  // (uid=? AND sender LIKE ?) OR subject LIKE ? OR extracted_json LIKE ? → 会搜到其他用户的邮件。
  // 因此 q 存在时把 user_id 并入每个 OR 分支，保证所有命中行都属于当前用户。
  if (f.user_id && !f.q) {
    clauses.push('user_id = ?');
    params.push(f.user_id);
  }
  if (f.rule_id) { clauses.push('rule_id = ?'); params.push(f.rule_id); }
  if (f.account_id) { clauses.push('account_id = ?'); params.push(f.account_id); }
  if (f.sender) { clauses.push('sender LIKE ?'); params.push(`%${f.sender}%`); }
  if (f.subject) { clauses.push('subject LIKE ?'); params.push(`%${f.subject}%`); }
  if (f.q) {
    const like = `%${f.q}%`;
    if (f.user_id) {
      clauses.push('user_id = ? AND sender LIKE ? OR user_id = ? AND subject LIKE ? OR user_id = ? AND extracted_json LIKE ?');
      params.push(f.user_id, like, f.user_id, like, f.user_id, like);
    } else {
      clauses.push('sender LIKE ? OR subject LIKE ? OR extracted_json LIKE ?');
      params.push(like, like, like);
    }
  }
  if (f.date_from !== undefined) { clauses.push('received_at >= ?'); params.push(f.date_from); }
  if (f.date_to !== undefined) { clauses.push('received_at <= ?'); params.push(f.date_to); }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

export async function countEmails(db: D1Database, f: EmailFilters): Promise<number> {
  const { sql, params } = buildEmailWhere(f);
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM emails${sql}`).bind(...params).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countEmailsByUser(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM emails WHERE user_id = ?').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listEmails(db: D1Database, f: EmailFilters, page = 1, pageSize = 20): Promise<EmailRow[]> {
  const { sql, params } = buildEmailWhere(f);
  const offset = Math.max(0, (page - 1) * pageSize);
  const res = await db
    .prepare(`SELECT * FROM emails${sql} ORDER BY received_at DESC LIMIT ? OFFSET ?`)
    .bind(...params, pageSize, offset)
    .all<EmailRow>();
  return res.results ?? [];
}

export async function getEmail(db: D1Database, id: string): Promise<EmailRow | null> {
  return (await db.prepare('SELECT * FROM emails WHERE id = ?').bind(id).first<EmailRow>()) ?? null;
}

export async function updateEmailExtracted(db: D1Database, id: string, extractedJson: string): Promise<void> {
  await db.prepare('UPDATE emails SET extracted_json = ? WHERE id = ?').bind(extractedJson, id).run();
}

/** 按唯一键(account_id, rule_id, message_id)查找已入库邮件的 id；不存在返回 null */
export async function findEmailIdByKey(db: D1Database, accountId: string, ruleId: string, messageId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT id FROM emails WHERE account_id = ? AND rule_id = ? AND message_id = ? LIMIT 1')
    .bind(accountId, ruleId, messageId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function emailExists(db: D1Database, accountId: string, ruleId: string, messageId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM emails WHERE account_id = ? AND rule_id = ? AND message_id = ? LIMIT 1')
    .bind(accountId, ruleId, messageId)
    .first<{ ok: number }>();
  return !!row;
}

/**
 * 入库邮件。使用 INSERT OR IGNORE + 表唯一约束(account_id, rule_id, message_id)做数据库级去重兜底：
 * 无论规则是否勾选 dedupe、无论是否存在并发同步，重复邮件都会被静默忽略，不再抛 UNIQUE 约束错误。
 * 返回 true 表示实际插入，false 表示该邮件已存在（被忽略）。
 */
export async function insertEmail(
  db: D1Database,
  e: Omit<EmailRow, 'id' | 'created_at'>,
): Promise<boolean> {
  const id = uuid();
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO emails (id, user_id, account_id, rule_id, message_id, thread_id, sender, sender_name,
                           subject, received_at, extracted_json, raw_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, e.user_id, e.account_id, e.rule_id, e.message_id, e.thread_id, e.sender, e.sender_name,
      e.subject, e.received_at, e.extracted_json, e.raw_url, now(),
    )
    .run();
  return res.success && (res.meta?.changes ?? 0) > 0;
}

/** 供导出用：拉取全量匹配行（分批翻页，避免单次查询过大） */
export async function streamEmails(
  db: D1Database,
  f: EmailFilters,
  pageSize: number,
  onPage: (rows: EmailRow[]) => Promise<void>,
  maxRows = 50_000,
): Promise<number> {
  let total = 0;
  let page = 1;
  for (;;) {
    const rows = await listEmails(db, f, page, pageSize);
    if (rows.length === 0) break;
    await onPage(rows);
    total += rows.length;
    if (rows.length < pageSize || total >= maxRows) break;
    page += 1;
  }
  return total;
}

// ---------------- sync_logs ----------------

export async function insertSyncLog(
  db: D1Database,
  l: { user_id: string | null; account_id: string; rule_id: string | null; trigger: SyncLogRow['trigger']; fetched: number; inserted: number; skipped: number; error?: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_logs (id, user_id, account_id, rule_id, run_at, trigger, fetched, inserted, skipped, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(uuid(), l.user_id, l.account_id, l.rule_id, now(), l.trigger, l.fetched, l.inserted, l.skipped, l.error ?? null)
    .run();
}

export async function listSyncLogs(db: D1Database, userId?: string, limit = 50, offset = 0): Promise<SyncLogRow[]> {
  const res = userId
    ? await db.prepare('SELECT * FROM sync_logs WHERE user_id = ? ORDER BY run_at DESC LIMIT ? OFFSET ?').bind(userId, limit, offset).all<SyncLogRow>()
    : await db.prepare('SELECT * FROM sync_logs ORDER BY run_at DESC LIMIT ? OFFSET ?').bind(limit, offset).all<SyncLogRow>();
  return res.results ?? [];
}

export async function countSyncLogs(db: D1Database, userId?: string): Promise<number> {
  const res = userId
    ? await db.prepare('SELECT COUNT(*) AS n FROM sync_logs WHERE user_id = ?').bind(userId).first<{ n: number }>()
    : await db.prepare('SELECT COUNT(*) AS n FROM sync_logs').first<{ n: number }>();
  return res?.n ?? 0;
}
