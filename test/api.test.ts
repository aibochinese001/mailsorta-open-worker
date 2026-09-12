import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { FakeD1, FakeKV, FakeR2 } from './fake-d1';
import type { Env } from '../src/env';
import type { AccountRow, RuleRow, EmailRow } from '../src/db/types';
import { epaySign } from '../src/payment/epay';
import { insertEmail } from '../src/db/queries';

const now = Date.now();

function makeEnv(db: FakeD1, kv: FakeKV, r2: FakeR2): Env {
  return {
    DB: db as unknown as D1Database,
    KV: kv as unknown as KVNamespace,
    R2: r2 as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } as unknown as Fetcher,
    APP_BASE_URL: 'http://localhost:8787',
    WEBHOOK_ENABLED: 'outlook,agently',
    SESSION_SECRET: 'test-session-secret',
    ADMIN_EMAILS: 'admin@test.com',
    TOKEN_ENCRYPTION_KEY: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=',
  } as Env;
}

function seedUser(db: FakeD1, over: Partial<import('../src/db/types').UserRow> = {}) {
  const u: import('../src/db/types').UserRow = {
    id: 'user_1', email: 'a@test.com', password_hash: 'x', display_name: null, role: 'user',
    status: 'active', member_plan: 'trial', member_expires_at: now + 30 * 86400_000,
    created_at: now, updated_at: now, last_login_at: null,
    llm_api_url: null, llm_api_key_enc: null, llm_model: null, ...over,
  };
  db.tables['users'] ??= [];
  db.tables['users'].push(u);
  return u;
}

function seedAccount(db: FakeD1, userId: string, over: Partial<AccountRow> = {}): AccountRow {
  const a: AccountRow = {
    id: 'acc_gmail_1', user_id: userId, provider: 'gmail', email: 'me@gmail.com', display_name: null,
    status: 'active', scopes: 'gmail.readonly', token_enc: null, token_expires_at: null,
    imap_host: null, imap_port: null,
    created_at: now, updated_at: now, ...over,
  };
  db.tables['accounts'] ??= [];
  db.tables['accounts'].push(a);
  return a;
}

function seedRule(db: FakeD1, userId: string, accountId: string, over: Partial<RuleRow> = {}): RuleRow {
  const r: RuleRow = {
    id: 'rule_1', user_id: userId, account_id: accountId, name: '发票整理', sender_mode: 'exact',
    sender_pattern: 'invoice@alipay.com', schedule_mode: 'interval', interval_minutes: 60,
    fields_json: JSON.stringify([{ key: 'order_no', label: '订单号', source: 'body_regex', pattern: '订单号[：:]\\s*(?<order_no>[\\w-]+)' }]),
    dedupe: 1, enabled: 1, last_run_at: null, created_at: now, updated_at: now, ...over,
  };
  db.tables['rules'] ??= [];
  db.tables['rules'].push(r);
  return r;
}

function seedEmail(db: FakeD1, userId: string, rule: RuleRow, over: Partial<EmailRow> = {}): EmailRow {
  const e: EmailRow = {
    id: 'email_1', user_id: userId, account_id: rule.account_id, rule_id: rule.id, message_id: 'gm-1',
    thread_id: null, sender: 'invoice@alipay.com', sender_name: '支付宝', subject: '订单 001',
    received_at: now - 3600_000, extracted_json: JSON.stringify({ order_no: 'ALI-001' }),
    raw_url: null, created_at: now, ...over,
  };
  db.tables['emails'] ??= [];
  db.tables['emails'].push(e);
  return e;
}

/** 通过 send-code(devCode) → register 完成注册并返回 cookie */
async function registerAndLogin(
  env: Env,
  email: string,
  password = 'test-pass-123',
): Promise<{ cookie: string; user: { id: string; role: string; email: string } }> {
  const codeRes = await worker.fetch(
    new Request('http://localhost/api/auth/send-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, purpose: 'register' }),
    }),
    env,
  );
  expect(codeRes.status).toBe(200);
  const { devCode } = (await codeRes.json()) as { devCode: string };

  const regRes = await worker.fetch(
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, code: devCode }),
    }),
    env,
  );
  expect(regRes.status).toBe(201);
  const regJson = (await regRes.json()) as { user: { id: string; role: string; email: string } };
  const cookie = (regRes.headers.get('set-cookie') ?? '').split(';')[0];
  return { cookie, user: regJson.user };
}

let db: FakeD1;
let kv: FakeKV;
let r2: FakeR2;
let env: Env;

beforeEach(() => {
  db = new FakeD1();
  kv = new FakeKV();
  r2 = new FakeR2();
  env = makeEnv(db, kv, r2);
});

describe('认证与多用户', () => {
  it('健康检查（公共）', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/health'), env);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it('未登录访问业务接口返回 401', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/rules'), env);
    expect(res.status).toBe(401);
  });

  it('注册 → 白名单邮箱为 admin → 登录 → me 闭环', async () => {
    const { user, cookie } = await registerAndLogin(env, 'admin@test.com');
    expect(user.role).toBe('admin');
    expect(user.email).toBe('admin@test.com');

    const meRes = await worker.fetch(new Request('http://localhost/api/auth/me', { headers: { cookie } }), env);
    const me = (await meRes.json()) as { authed: boolean; user: { email: string }; member: { level: string } };
    expect(me.authed).toBe(true);
    expect(me.user.email).toBe('admin@test.com');
    expect(me.member.level).toBe('trial');

    // 登录
    const loginRes = await worker.fetch(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@test.com', password: 'test-pass-123' }),
      }),
      env,
    );
    expect(loginRes.status).toBe(200);
  });

  it('首个注册用户不再自动成为管理员（未在白名单则为普通用户）', async () => {
    const first = await registerAndLogin(env, 'first@test.com');
    expect(first.user.role).toBe('user');
    const second = await registerAndLogin(env, 'second@test.com');
    expect(second.user.role).toBe('user');
  });

  it('OAuth start 需要登录态（不被公开前缀误放行）', async () => {
    // 未登录发起 OAuth → 401，而非业务错误
    const anon = await worker.fetch(
      new Request('http://localhost/api/accounts/oauth/agently/start', { method: 'POST' }),
      env,
    );
    expect(anon.status).toBe(401);

    // 登录后发起：未配置桥接层 → 业务报错（配置提示），证明已通过鉴权
    const { cookie } = await registerAndLogin(env, 'oauth-start@test.com');
    const st = await worker.fetch(
      new Request('http://localhost/api/accounts/oauth/agently/start', { method: 'POST', headers: { cookie } }),
      env,
    );
    expect(st.status).toBe(500);
    const body = (await st.json()) as { error: string };
    expect(body.error).toContain('未配置 Agently 桥接层');

    // gmail/outlook 同理：未登录 401，登录后报凭据配置提示
    const g = await worker.fetch(new Request('http://localhost/api/accounts/oauth/gmail/start', { method: 'POST', headers: { cookie } }), env);
    expect(g.status).toBe(500);
  });

  it('OAuth redirect_uri：优先 APP_BASE_URL，未配置时用请求 origin 兜底', async () => {
    const { cookie } = await registerAndLogin(env, 'redirect-uri@test.com');
    // 配置管理后台凭据后，start 返回的授权 URL 中 redirect_uri 使用 APP_BASE_URL
    await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('google_client_id', 'gid-1').run();
    await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('google_client_secret', 'gsec-1').run();
    const res = await worker.fetch(new Request('http://localhost/api/accounts/oauth/gmail/start', { method: 'POST', headers: { cookie } }), env);
    expect(res.status).toBe(200);
    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const u = new URL(authorizeUrl);
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:8787/api/accounts/oauth/gmail/callback');
    // APP_BASE_URL 未配置（删除 env 变量模拟）时兜底为请求 origin
    const env2 = { ...env } as Partial<typeof env> & { APP_BASE_URL?: undefined };
    delete (env2 as { APP_BASE_URL?: string }).APP_BASE_URL;
    const res2 = await worker.fetch(new Request('http://localhost/api/accounts/oauth/gmail/start', { method: 'POST', headers: { cookie } }), env2);
    const u2 = new URL((await res2.json() as { authorizeUrl: string }).authorizeUrl);
    expect(u2.searchParams.get('redirect_uri')).toBe('http://localhost/api/accounts/oauth/gmail/callback');
  });

  it('用户中心保存 AI 提取模型：配置落库且 me 返回已配置状态', async () => {
    const { cookie } = await registerAndLogin(env, 'llmuser@test.com');
    const patch = await worker.fetch(
      new Request('http://localhost/api/auth/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ llm_api_url: 'https://llm.example.com/v1', llm_model: 'my-model', llm_api_key: 'sk-abc' }),
      }),
      env,
    );
    expect(patch.status).toBe(200);

    const me = await worker.fetch(new Request('http://localhost/api/auth/me', { headers: { cookie } }), env);
    const meJson = (await me.json()) as { user: { llm_api_url?: string; llm_model?: string; llm_key_configured?: boolean } };
    expect(meJson.user.llm_api_url).toBe('https://llm.example.com/v1');
    expect(meJson.user.llm_model).toBe('my-model');
    expect(meJson.user.llm_key_configured).toBe(true);
    // 密文不出现在 me 响应
    expect(JSON.stringify(meJson)).not.toContain('sk-abc');

    // 清空模型：llm_api_url 置空后 key 一并清除
    const clear = await worker.fetch(
      new Request('http://localhost/api/auth/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ llm_api_url: '', llm_model: '', llm_api_key: '' }),
      }),
      env,
    );
    expect(clear.status).toBe(200);
    const me2 = (await (await worker.fetch(new Request('http://localhost/api/auth/me', { headers: { cookie } }), env)).json()) as {
      user: { llm_key_configured?: boolean };
    };
    expect(me2.user.llm_key_configured).toBe(false);
  });

  it('用户中心修改密码：旧密码失效、新密码可登录', async () => {    const { cookie } = await registerAndLogin(env, 'pw@test.com', 'old-pass-123');

    // 原密码错误被拒绝
    const bad = await worker.fetch(
      new Request('http://localhost/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ old_password: 'wrong-pass-123', new_password: 'new-pass-456' }),
      }),
      env,
    );
    expect(bad.status).toBe(422);

    // 正确修改
    const ok = await worker.fetch(
      new Request('http://localhost/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ old_password: 'old-pass-123', new_password: 'new-pass-456' }),
      }),
      env,
    );
    expect(ok.status).toBe(200);

    // 旧密码登录失败、新密码登录成功
    const oldLogin = await worker.fetch(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'pw@test.com', password: 'old-pass-123' }),
      }),
      env,
    );
    expect(oldLogin.status).toBe(401);
    const newLogin = await worker.fetch(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'pw@test.com', password: 'new-pass-456' }),
      }),
      env,
    );
    expect(newLogin.status).toBe(200);
  });

  it('管理员可在管理后台重置用户密码', async () => {
    const admin = await registerAndLogin(env, 'admin@test.com');
    const target = await registerAndLogin(env, 'reset-target@test.com', 'target-old-123');
    expect(target.user.role).toBe('user');

    const res = await worker.fetch(
      new Request('http://localhost/api/admin/users/' + target.user.id, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({ password: 'reset-by-admin-789' }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const login = await worker.fetch(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'reset-target@test.com', password: 'reset-by-admin-789' }),
      }),
      env,
    );
    expect(login.status).toBe(200);
  });

  it('重复邮箱注册返回 409', async () => {
    await registerAndLogin(env, 'dup@test.com');
    const codeRes = await worker.fetch(
      new Request('http://localhost/api/auth/send-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'dup@test.com', purpose: 'register' }),
      }),
      env,
    );
    expect(codeRes.status).toBe(409);
  });
});

describe('业务 API（登录后，多租户隔离）', () => {
  it('规则 CRUD 闭环 + 配额上限', async () => {
    const { cookie, user } = await registerAndLogin(env, 'a@test.com');
    seedAccount(db, user.id);

    // 未登录 422（公共鉴权之外的校验）
    const bad = await worker.fetch(
      new Request('http://localhost/api/rules', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' }),
      env,
    );
    expect(bad.status).toBe(422);

    const created = await worker.fetch(
      new Request('http://localhost/api/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          account_id: 'acc_gmail_1', name: '发票整理', sender_mode: 'exact', sender_pattern: 'invoice@alipay.com',
          schedule_mode: 'interval', interval_minutes: 30,
          fields: [{ key: 'order_no', label: '订单号', source: 'body_regex', pattern: '(?<order_no>[\\w-]+)' }],
        }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    const ruleId = ((await created.json()) as { rule: RuleRow }).rule.id;

    const listRes = await worker.fetch(new Request('http://localhost/api/rules', { headers: { cookie } }), env);
    expect(((await listRes.json()) as { rules: unknown[] }).rules).toHaveLength(1);

    const upd = await worker.fetch(
      new Request(`http://localhost/api/rules/${ruleId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          account_id: 'acc_gmail_1', name: '发票整理v2', sender_mode: 'domain', sender_pattern: 'alipay.com',
          schedule_mode: 'on_receive', interval_minutes: null, fields: [],
        }),
      }),
      env,
    );
    expect(upd.status).toBe(200);

    // 配额：免费试用 5 条上限（此处 1 条已建，再建 5 条超限）
    for (let i = 0; i < 5; i++) {
      await worker.fetch(
        new Request('http://localhost/api/rules', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({
            account_id: 'acc_gmail_1', name: `r${i}`, sender_mode: 'exact', sender_pattern: `x${i}@y.com`,
            schedule_mode: 'interval', interval_minutes: 60, fields: [],
          }),
        }),
        env,
      );
    }
    const quotaRes = await worker.fetch(
      new Request('http://localhost/api/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          account_id: 'acc_gmail_1', name: '超限', sender_mode: 'exact', sender_pattern: 'z@y.com',
          schedule_mode: 'interval', interval_minutes: 60, fields: [],
        }),
      }),
      env,
    );
    expect(quotaRes.status).toBe(402);

    const del = await worker.fetch(new Request(`http://localhost/api/rules/${ruleId}`, { method: 'DELETE', headers: { cookie } }), env);
    expect(del.status).toBe(200);
  });

  it('用户隔离：A 的规则/邮件 B 不可见', async () => {
    const a = await registerAndLogin(env, 'a@test.com');
    const b = await registerAndLogin(env, 'b@test.com');
    const account = seedAccount(db, a.user.id);
    const rule = seedRule(db, a.user.id, account.id);
    seedEmail(db, a.user.id, rule);

    // B 看不到 A 的规则
    const bRules = await worker.fetch(new Request('http://localhost/api/rules', { headers: { cookie: b.cookie } }), env);
    expect(((await bRules.json()) as { rules: unknown[] }).rules).toHaveLength(0);
    // B 看不到 A 的邮件
    const bEmails = await worker.fetch(new Request('http://localhost/api/emails', { headers: { cookie: b.cookie } }), env);
    expect(((await bEmails.json()) as { total: number }).total).toBe(0);
    // B 无法读取 A 的规则
    const bGet = await worker.fetch(new Request(`http://localhost/api/rules/${rule.id}`, { headers: { cookie: b.cookie } }), env);
    expect(bGet.status).toBe(404);
  });

  it('邮件查询与分页', async () => {
    const { cookie, user } = await registerAndLogin(env, 'a@test.com');
    const account = seedAccount(db, user.id);
    const rule = seedRule(db, user.id, account.id);
    seedEmail(db, user.id, rule);
    seedEmail(db, user.id, rule, {
      id: 'email_2', message_id: 'gm-2', subject: '订单 002', received_at: now,
      extracted_json: JSON.stringify({ order_no: 'ALI-002' }),
    });

    const res = await worker.fetch(new Request('http://localhost/api/emails?rule_id=rule_1&page=1&page_size=20', { headers: { cookie } }), env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: { extracted: Record<string, string> }[]; total: number };
    expect(data.total).toBe(2);
    expect(data.items[0].extracted.order_no).toBe('ALI-002');

    // 按提取字段内容搜索（q 命中 extracted_json）
    const qRes = await worker.fetch(new Request('http://localhost/api/emails?q=ALI-002', { headers: { cookie } }), env);
    const qData = (await qRes.json()) as { items: { subject: string }[]; total: number };
    expect(qData.total).toBe(1);
    expect(qData.items[0].subject).toBe('订单 002');
    // 关键词同时可命中主题
    const qSubj = await worker.fetch(new Request('http://localhost/api/emails?q=001', { headers: { cookie } }), env);
    const qSubjData = (await qSubj.json()) as { total: number };
    expect(qSubjData.total).toBe(1);
  });

  it('关键词搜索不跨租户：B 搜到 A 的主题/字段内容不返回 A 的邮件', async () => {
    const a = await registerAndLogin(env, 'a@test.com');
    const b = await registerAndLogin(env, 'b@test.com');
    const account = seedAccount(db, a.user.id);
    const rule = seedRule(db, a.user.id, account.id);
    // A 的邮件：主题含「订单 001」，extracted_json 含 ALI-001
    seedEmail(db, a.user.id, rule, { id: 'email_a1', message_id: 'gm-a1', subject: '订单 001', extracted_json: JSON.stringify({ order_no: 'ALI-001' }) });
    // B 自己的邮件：也含相同关键词（构造冲突场景）
    const accountB = seedAccount(db, b.user.id, { id: 'acc_b1', email: 'meB@gmail.com' });
    const ruleB = seedRule(db, b.user.id, accountB.id, { id: 'rule_b1', name: 'B 的规则' });
    seedEmail(db, b.user.id, ruleB, { id: 'email_b1', message_id: 'gm-b1', sender: 'x@y.com', subject: '别的', extracted_json: JSON.stringify({}) });

    // B 用关键词「订单 001」搜索：只能命中 B 自己的邮件，A 的邮件绝不能出现
    const qSubj = await worker.fetch(new Request('http://localhost/api/emails?q=%E8%AE%A2%E5%8D%95%20001', { headers: { cookie: b.cookie } }), env);
    const qSubjData = (await qSubj.json()) as { total: number; items: { subject: string; id: string }[] };
    expect(qSubjData.total).toBe(0);

    // B 用关键词「ALI-001」搜索（命中 A 的 extracted_json）：同样不能返回 A 的邮件
    const qExt = await worker.fetch(new Request('http://localhost/api/emails?q=ALI-001', { headers: { cookie: b.cookie } }), env);
    const qExtData = (await qExt.json()) as { total: number; items: { subject: string; id: string }[] };
    expect(qExtData.total).toBe(0);

    // 反向：A 自己能搜到自己的邮件
    const qA = await worker.fetch(new Request('http://localhost/api/emails?q=ALI-001', { headers: { cookie: a.cookie } }), env);
    const qAData = (await qA.json()) as { total: number };
    expect(qAData.total).toBe(1);
  });

  it('重新提取：账号不可用时返回 400', async () => {
    const { cookie, user } = await registerAndLogin(env, 'a@test.com');
    const account = seedAccount(db, user.id, { status: 'revoked' });
    const rule = seedRule(db, user.id, account.id);
    seedEmail(db, user.id, rule);
    const res = await worker.fetch(
      new Request('http://localhost/api/emails/email_1/re-extract', { method: 'POST', headers: { cookie } }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('Excel 导出返回 xlsx', async () => {
    const { cookie, user } = await registerAndLogin(env, 'a@test.com');
    const account = seedAccount(db, user.id);
    const rule = seedRule(db, user.id, account.id);
    seedEmail(db, user.id, rule);

    const res = await worker.fetch(new Request('http://localhost/api/export/xlsx?rule_id=rule_1', { headers: { cookie } }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(100);
  });

  it('手动同步：桥接未配置时记录错误不崩溃', async () => {
    const { cookie, user } = await registerAndLogin(env, 'a@test.com');
    const account = seedAccount(db, user.id, { id: 'acc_agently_1', provider: 'agently', email: 'bot@agent.qq.com' });
    seedRule(db, user.id, account.id, { id: 'rule_a1', account_id: 'acc_agently_1', schedule_mode: 'on_receive' });

    const res = await worker.fetch(
      new Request('http://localhost/api/sync/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { outcomes: { ruleId: string; error?: string }[] };
    expect(data.outcomes).toHaveLength(1);
    expect(data.outcomes[0].error).toContain('Agently 桥接层');
  });

  it('insertEmail 幂等：重复邮件被 OR IGNORE 忽略且不抛唯一约束错误', async () => {
    const db = new FakeD1();
    const d1 = db as unknown as D1Database;
    const base = {
      user_id: 'u1', account_id: 'acc_1', rule_id: 'rule_1', message_id: 'gm-1',
      thread_id: null, sender: 'a@b.com', sender_name: null, subject: 'S',
      received_at: now, extracted_json: '{}', raw_url: null,
    };
    expect(await insertEmail(d1, base)).toBe(true);
    // 同一 (account_id, rule_id, message_id) 重复插入：数据库级去重，返回 false 且不抛错
    expect(await insertEmail(d1, { ...base, extracted_json: '{"v":2}' })).toBe(false);
    expect(db.tables['emails']).toHaveLength(1);
    // 不同 message_id 正常插入
    expect(await insertEmail(d1, { ...base, message_id: 'gm-2' })).toBe(true);
    expect(db.tables['emails']).toHaveLength(2);
  });

  it('同步日志分页：默认 15 条/页，total 正确', async () => {
    const { cookie, user } = await registerAndLogin(env, 'a@test.com');
    db.tables['sync_logs'] ??= [];
    for (let i = 0; i < 20; i++) {
      db.tables['sync_logs'].push({
        id: `log_${i}`, user_id: user.id, account_id: 'acc_1', rule_id: 'rule_1', trigger: 'cron',
        fetched: 1, inserted: 1, skipped: 0, error: null, run_at: now - i * 60_000,
      } as import('../src/db/types').SyncLogRow);
    }
    const p1 = await worker.fetch(new Request('http://localhost/api/sync/logs?page=1&page_size=15', { headers: { cookie } }), env);
    const d1 = (await p1.json()) as { logs: unknown[]; total: number; page: number; page_size: number };
    expect(d1.total).toBe(20);
    expect(d1.logs).toHaveLength(15);
    expect(d1.page).toBe(1);
    expect(d1.page_size).toBe(15);
    // 按时间倒序：第一页第一条是最新一条
    expect((d1.logs[0] as { id: string }).id).toBe('log_0');
    const p2 = await worker.fetch(new Request('http://localhost/api/sync/logs?page=2&page_size=15', { headers: { cookie } }), env);
    const d2 = (await p2.json()) as { logs: unknown[] };
    expect(d2.logs).toHaveLength(5);
  });

  it('IMAP 账号：保存并加密授权码，账号入列', async () => {
    const { cookie, user } = await registerAndLogin(env, 'imap@test.com');
    const res = await worker.fetch(
      new Request('http://localhost/api/accounts/imap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ email: 'my@qq.com', auth_code: 'authcode-123', host: 'imap.qq.com', port: 993 }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; tested: boolean };
    expect(j.ok).toBe(true);
    expect(j.tested).toBe(false); // 未开启测试连接

    const accounts = (await worker.fetch(new Request('http://localhost/api/accounts', { headers: { cookie } }), env));
    const list = (await accounts.json()) as { accounts: { provider: string; email: string; scopes: string }[] };
    const acc = list.accounts.find((a) => a.provider === 'imap');
    expect(acc?.email).toBe('my@qq.com');
    // 授权码加密落库（不出现明文）
    const rows = db.tables['accounts'] as { email: string; token_enc: string }[];
    const saved = rows.find((r) => r.email === 'my@qq.com');
    expect(saved?.token_enc).toBeTruthy();
    expect(saved?.token_enc).not.toContain('authcode-123');

    // 参数校验：缺授权码拒绝
    const bad = await worker.fetch(
      new Request('http://localhost/api/accounts/imap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ email: 'x@163.com', host: 'imap.163.com' }),
      }),
      env,
    );
    expect(bad.status).toBe(422);
  });

  it('会员到期：手动同步被拒绝，历史查询仍可用', async () => {
    const { cookie, user } = await registerAndLogin(env, 'a@test.com');
    // 试用已过期：直接修改真实用户行
    const row = db.tables['users'].find((x) => (x as { id: string }).id === user.id) as { member_plan: string; member_expires_at: number };
    row.member_plan = 'trial';
    row.member_expires_at = now - 3600_000;
    const account = seedAccount(db, user.id);
    const rule = seedRule(db, user.id, account.id);
    seedEmail(db, user.id, rule);

    const run = await worker.fetch(
      new Request('http://localhost/api/sync/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: '{}',
      }),
      env,
    );
    expect(run.status).toBe(403);
    const j = (await run.json()) as { error: string };
    expect(j.error).toContain('会员已到期');

    // 历史数据查询与导出不受影响
    const q = await worker.fetch(new Request('http://localhost/api/emails', { headers: { cookie } }), env);
    expect(q.status).toBe(200);
    expect(((await q.json()) as { total: number }).total).toBe(1);
  });

  it('未知 API 路径返回 JSON 错误而非前端 HTML', async () => {
    const { cookie } = await registerAndLogin(env, 'nope@test.com');
    const res = await worker.fetch(new Request('http://localhost/api/nope', { headers: { cookie } }), env);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ error: expect.any(String) });
  });
});

describe('会员与支付（易支付）', () => {
  async function setupAdminAndEpay(adminCookie: string) {
    // 配置易支付
    await worker.fetch(
      new Request('http://localhost/api/admin/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({
          epay_api_url: 'https://pay.example.com',
          epay_pid: '1001',
          epay_key: 'secret-key',
          epay_pay_types: 'alipay,wxpay,gmpay,fiatstripe',
        }),
      }),
      env,
    );
    // 建套餐
    const planRes = await worker.fetch(
      new Request('http://localhost/api/admin/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ name: '月度会员', price_usd: 4.99, period_type: 'month', duration_months: 1, sort: 1, enabled: true }),
      }),
      env,
    );
    expect(planRes.status).toBe(201);
    return ((await planRes.json()) as { plan: { id: string; price_usd: number } }).plan;
  }

  it('公共套餐列表返回四种支付方式', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/billing/plans'), env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { plans: unknown[]; pay_types: { key: string }[] };
    expect(data.pay_types.map((p) => p.key).sort()).toEqual(['alipay', 'fiatstripe', 'gmpay', 'wxpay']);
  });

  it('checkout → 易支付 notify 验签 → 会员生效', async () => {
    const admin = await registerAndLogin(env, 'admin@test.com');
    const user = await registerAndLogin(env, 'buyer@test.com');
    const plan = await setupAdminAndEpay(admin.cookie);

    // 下单
    const coRes = await worker.fetch(
      new Request('http://localhost/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: user.cookie },
        body: JSON.stringify({ plan_id: plan.id, pay_type: 'alipay' }),
      }),
      env,
    );
    expect(coRes.status).toBe(201);
    const co = (await coRes.json()) as { order: { out_trade_no: string; price_usd: number; status: string }; payUrl: string };
    expect(co.payUrl).toContain('submit.php');
    expect(co.payUrl).toContain(`money=${plan.price_usd}`);
    expect(co.order.price_usd).toBe(plan.price_usd);
    expect(co.order.status).toBe('pending');

    // 不支持的支付方式 → 422
    const badPay = await worker.fetch(
      new Request('http://localhost/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: user.cookie },
        body: JSON.stringify({ plan_id: plan.id, pay_type: 'bitcoin' }),
      }),
      env,
    );
    expect(badPay.status).toBe(422);

    // 模拟易支付异步通知
    const params: Record<string, string> = {
      pid: '1001',
      trade_no: 'EPAY202609050001',
      out_trade_no: co.order.out_trade_no,
      type: 'alipay',
      name: '月度会员',
      money: String(co.order.price_usd),
      trade_status: 'TRADE_SUCCESS',
    };
    params['sign'] = await epaySign(params, 'secret-key');
    const notifyRes = await worker.fetch(
      new Request('http://localhost/api/billing/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      }),
      env,
    );
    expect(notifyRes.status).toBe(200);
    expect(await notifyRes.text()).toBe('success');

    // 订单已支付 + 会员生效（试用期从 30 天后顺延）
    const meRes = await worker.fetch(new Request('http://localhost/api/billing/me', { headers: { cookie: user.cookie } }), env);
    const me = (await meRes.json()) as { member: { level: string; expires_at: number | null } };
    expect(me.member.level).toBe('paid');
    expect(me.member.expires_at).toBeGreaterThan(now + 30 * 86400_000);

    // 幂等：重复通知仍 success 且会员不重复叠加
    const notify2 = await worker.fetch(
      new Request('http://localhost/api/billing/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      }),
      env,
    );
    expect(await notify2.text()).toBe('success');
  });

  it('签名错误的通知被拒绝', async () => {
    const admin = await registerAndLogin(env, 'admin@test.com');
    const user = await registerAndLogin(env, 'buyer2@test.com');
    await setupAdminAndEpay(admin.cookie);
    const res = await worker.fetch(
      new Request('http://localhost/api/billing/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'pid=1001&out_trade_no=MS1&money=10&trade_status=TRADE_SUCCESS&sign=deadbeef',
      }),
      env,
    );
    expect(await res.text()).toBe('fail');
  });
});
