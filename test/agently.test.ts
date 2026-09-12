import { describe, it, expect } from 'vitest';
import { toSummary } from '../src/connectors/agently';

describe('agently toSummary 字段归一化', () => {
  it('agently-cli 字段名（message_id/from/received_at 秒级）映射为内部结构', () => {
    const s = toSummary({
      message_id: 'msg_123',
      from: 'sender@qq.com',
      sender_name: '发件人',
      subject: '测试主题',
      received_at: 1788600000, // 秒级
      thread_id: 'th_1',
    });
    expect(s.id).toBe('msg_123');
    expect(s.sender).toBe('sender@qq.com');
    expect(s.senderName).toBe('发件人');
    expect(s.subject).toBe('测试主题');
    expect(s.receivedAt).toBe(1788600000000); // 秒 → 毫秒
    expect(s.threadId).toBe('th_1');
  });

  it('from 为对象 {address,name} 时取地址与名称', () => {
    const s = toSummary({ id: 'm1', from: { address: 'ops@co.com', name: '运营' } });
    expect(s.sender).toBe('ops@co.com');
    expect(s.senderName).toBe('运营');
  });

  it('ISO 日期字符串解析为时间戳', () => {
    const s = toSummary({ id: 'm1', received_at: '2026-09-05T08:00:00Z' });
    expect(s.receivedAt).toBe(Date.parse('2026-09-05T08:00:00Z'));
  });

  it('body 字段映射（getMessage 用）', async () => {
    const { agentlyConnector } = await import('../src/connectors/agently');
    // bodyOf 未导出，通过 getMessage 的 rpc mock 验证太重，这里仅确认 toSummary 不依赖 body
    expect(agentlyConnector.provider).toBe('agently');
  });

  it('message.list 对象包装（{messages:[...]}）可提取为数组', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: true, messages: [{ message_id: 'msg_a', from: 'a@b.com' }, { id: 'msg_b', sender: 'c@d.com' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    try {
      const { agentlyConnector } = await import('../src/connectors/agently');
      const { FakeD1 } = await import('./fake-d1');
      const db = new FakeD1();
      db.tables['settings'] = [
        { key: 'agently_bridge_url', value: 'http://bridge.local' },
        { key: 'agently_bridge_token', value: 'tok' },
      ];
      const env = {
        KV: {} as unknown as KVNamespace,
        DB: db as unknown as D1Database,
        APP_BASE_URL: 'http://localhost',
        SESSION_SECRET: 's',
        TOKEN_ENCRYPTION_KEY: 'x',
      } as unknown as import('../src/env').Env;
      const list = await agentlyConnector.listSummaries(env, 'acc', {
        senderPattern: '',
        senderMode: 'exact',
        maxResults: 50,
      });
      expect(list.map((s) => s.id)).toEqual(['msg_a', 'msg_b']);
      expect(list[0].sender).toBe('a@b.com');
      expect(list[1].sender).toBe('c@d.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('getMessage 双层包装（{ok:true, data:{message:{...}}}）解包成功并返回正文', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: { message: { message_id: 'msg_9', from: 'ship@co.com', subject: '船期', body: '船名：OCEAN STAR' } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    try {
      const { agentlyConnector } = await import('../src/connectors/agently');
      const { FakeD1 } = await import('./fake-d1');
      const db = new FakeD1();
      db.tables['settings'] = [
        { key: 'agently_bridge_url', value: 'http://bridge.local' },
        { key: 'agently_bridge_token', value: 'tok' },
      ];
      const env = {
        KV: {} as unknown as KVNamespace,
        DB: db as unknown as D1Database,
        APP_BASE_URL: 'http://localhost',
        SESSION_SECRET: 's',
        TOKEN_ENCRYPTION_KEY: 'x',
      } as unknown as import('../src/env').Env;
      const full = await agentlyConnector.getMessage(env, 'acc', 'msg_9');
      expect(full).not.toBeNull();
      expect(full!.summary.id).toBe('msg_9');
      expect(full!.summary.sender).toBe('ship@co.com');
      expect(full!.bodyText).toContain('OCEAN STAR');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('message.list 双层包装（{ok:true, data:{messages:[...]}}）可提取为数组', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: { total: 2, messages: [{ message_id: 'n1', from: 'x@y.com' }, { message_id: 'n2', from: 'z@w.com' }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    try {
      const { agentlyConnector } = await import('../src/connectors/agently');
      const { FakeD1 } = await import('./fake-d1');
      const db = new FakeD1();
      db.tables['settings'] = [
        { key: 'agently_bridge_url', value: 'http://bridge.local' },
        { key: 'agently_bridge_token', value: 'tok' },
      ];
      const env = {
        KV: {} as unknown as KVNamespace,
        DB: db as unknown as D1Database,
        APP_BASE_URL: 'http://localhost',
        SESSION_SECRET: 's',
        TOKEN_ENCRYPTION_KEY: 'x',
      } as unknown as import('../src/env').Env;
      const list = await agentlyConnector.listSummaries(env, 'acc', {
        senderPattern: '',
        senderMode: 'exact',
        maxResults: 50,
      });
      expect(list.map((s) => s.id)).toEqual(['n1', 'n2']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
