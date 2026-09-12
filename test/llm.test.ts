import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractFields } from '../src/sync/extractor';
import { encryptSecret } from '../src/crypto/token';
import { FakeD1 } from './fake-d1';
import type { Env } from '../src/env';
import type { FullMessage } from '../src/connectors/types';

const TEST_ENC_KEY = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE='; // base64 32 字节

const msg: FullMessage = {
  summary: {
    id: 'm1', threadId: undefined, sender: 'ops@shipping.com', senderName: '船务部',
    subject: '船期通知', receivedAt: Date.now(),
  },
  bodyText:
    '船名：OCEAN STAR。本航次由中远海运承运，提单号 COSCO2026-091，\n' +
    '目的港上海，预计 9 月 12 日到港。联系人：王经理。',
};

function makeEnv(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    KV: {} as unknown as KVNamespace,
    R2: {} as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) } as unknown as Fetcher,
    APP_BASE_URL: 'http://localhost',
    WEBHOOK_ENABLED: '',
    SESSION_SECRET: 's',
    TOKEN_ENCRYPTION_KEY: TEST_ENC_KEY,
  } as Env;
}

function seedUserWithLlm(db: FakeD1, userId: string, llm: { url: string; key: string; model?: string }) {
  db.tables['users'] = [
    {
      id: userId, email: `${userId}@test.com`, password_hash: 'x', display_name: null, role: 'user',
      status: 'active', member_plan: 'trial', member_expires_at: Date.now() + 86400_000,
      created_at: Date.now(), updated_at: Date.now(), last_login_at: null,
      llm_api_url: llm.url, llm_model: llm.model ?? null,
      llm_api_key_enc: llm.key,
    },
  ];
}

const llmFields = [
  { key: 'ship_owner', label: '船东名称', source: 'llm' as const },
  { key: 'vessel', label: '船名', source: 'llm' as const },
];

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubLlmOk(extra: Record<string, unknown> = {}) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String((init as RequestInit)?.body ?? '{}'));
    expect(body.model).toBeTruthy();
    expect((body.messages ?? []).length).toBe(2);
    expect((init?.headers as Record<string, string>)?.authorization).toMatch(/^Bearer\s+\S+$/);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ship_owner: '中远海运', vessel: 'OCEAN STAR', ...extra }) } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

describe('用户级 LLM 字段提取', () => {
  it('用户未配置 LLM：llm 字段置空，不阻塞其它字段', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const result = await extractFields(
      env,
      [
        { key: 'vessel', label: '船名', source: 'body_regex', pattern: '船名[：:]\\s*([^，。\\n]+)' },
        { key: 'ship_owner', label: '船东名称', source: 'llm' },
      ],
      msg,
      'user_a',
    );
    expect(result.vessel).toBe('OCEAN STAR'); // 正则字段正常
    expect(result.ship_owner).toBeNull(); // 未配置 LLM → null
    expect(result._llm_error).toContain('未配置 LLM'); // 原因可见
  });

  it('用户配置了自己的模型：语义提取船东名称成功（邮件中无“船东”关键词）', async () => {
    stubLlmOk();
    const db = new FakeD1();
    seedUserWithLlm(db, 'user_a', {
      url: 'https://llm.example.com/v1',
      key: await encryptSecret(TEST_ENC_KEY, 'user-a-key'),
      model: 'user-a-model',
    });
    const env = makeEnv(db);
    const result = await extractFields(env, llmFields, msg, 'user_a');
    expect(result.ship_owner).toBe('中远海运');
    expect(result.vessel).toBe('OCEAN STAR');
  });

  it('用户配置隔离：A 配置了模型、B 未配置，B 的字段置空', async () => {
    stubLlmOk();
    const db = new FakeD1();
    seedUserWithLlm(db, 'user_a', {
      url: 'https://llm.example.com/v1',
      key: await encryptSecret(TEST_ENC_KEY, 'user-a-key'),
    });
    const env = makeEnv(db);
    const forB = await extractFields(env, llmFields, msg, 'user_b');
    expect(forB.ship_owner).toBeNull();
    const forA = await extractFields(env, llmFields, msg, 'user_a');
    expect(forA.ship_owner).toBe('中远海运');
  });

  it('LLM 返回失败：字段置空不抛错', async () => {
    globalThis.fetch = (async () => new Response('server error', { status: 500 })) as unknown as typeof fetch;
    const db = new FakeD1();
    seedUserWithLlm(db, 'user_a', {
      url: 'https://llm.example.com/v1',
      key: await encryptSecret(TEST_ENC_KEY, 'user-a-key'),
    });
    const env = makeEnv(db);
    const result = await extractFields(env, llmFields, msg, 'user_a');
    expect(result.ship_owner).toBeNull();
    expect(result.vessel).toBeNull();
    expect(result._llm_error).toContain('LLM 提取失败');
  });
});
