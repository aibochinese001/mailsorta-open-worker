import { describe, it, expect } from 'vitest';
import { extractField, parseFields, type FieldDef } from '../src/sync/extractor';
import { FakeD1 } from './fake-d1';
import type { FullMessage } from '../src/connectors/types';
import type { Env } from '../src/env';

const msg: FullMessage = {
  summary: {
    id: 'msg1',
    sender: 'invoice@alipay.com',
    senderName: '支付宝',
    subject: '您的订单 20260905001 已支付',
    receivedAt: Date.parse('2026-09-05T08:00:00Z'),
  },
  bodyText: '订单号：ALI-8821-9999\n金额：¥128.00\n收货人：张三',
};

const env = { DB: new FakeD1() as unknown as D1Database } as Env;

describe('extractField', () => {
  it('头部字段', () => {
    expect(extractField({ key: 'f', label: 'F', source: 'header', header: 'from' }, msg)).toBe('invoice@alipay.com');
    expect(extractField({ key: 's', label: 'S', source: 'header', header: 'subject' }, msg)).toBe('您的订单 20260905001 已支付');
    expect(extractField({ key: 'n', label: 'N', source: 'header', header: 'from_name' }, msg)).toBe('支付宝');
    expect(extractField({ key: 'd', label: 'D', source: 'header', header: 'date' }, msg)).toBeTruthy();
  });

  it('正则命名捕获组', () => {
    const f: FieldDef = { key: 'order_no', label: '订单号', source: 'body_regex', pattern: '订单号[：:]\\s*(?<order_no>[\\w-]+)' };
    expect(extractField(f, msg)).toBe('ALI-8821-9999');
  });

  it('正则首个捕获组（无命名组时）', () => {
    const f: FieldDef = { key: 'amount', label: '金额', source: 'body_regex', pattern: '金额[：:]\\s*[¥￥]?\\s*([\\d.]+)' };
    expect(extractField(f, msg)).toBe('128.00');
  });

  it('未命中返回 null', () => {
    const f: FieldDef = { key: 'x', label: 'X', source: 'body_regex', pattern: '不存在的关键词\\s*(\\w+)' };
    expect(extractField(f, msg)).toBeNull();
  });

  it('非法正则返回 null 不抛错', () => {
    const f: FieldDef = { key: 'x', label: 'X', source: 'body_regex', pattern: '([unclosed' };
    expect(extractField(f, msg)).toBeNull();
  });

  it('llm 字段不在单字段提取中处理', () => {
    const f: FieldDef = { key: 'llm', label: 'LLM', source: 'llm' };
    expect(extractField(f, msg)).toBeNull();
  });
});

describe('parseFields', () => {
  it('解析合法 JSON', () => {
    const fields = parseFields('[{"key":"a","label":"A","source":"header","header":"subject"}]');
    expect(fields).toHaveLength(1);
    expect(fields[0].key).toBe('a');
  });

  it('非法 JSON 返回空数组', () => {
    expect(parseFields('not-json')).toEqual([]);
  });
});

describe('extractFields 主入口（无 LLM 配置）', async () => {
  const { extractFields } = await import('../src/sync/extractor');
  it('llm 字段在未配置时置空，不抛错', async () => {
    const result = await extractFields(env, [
      { key: 'order_no', label: '订单号', source: 'body_regex', pattern: '订单号[：:]\\s*(?<order_no>[\\w-]+)' },
      { key: 'llm', label: 'LLM', source: 'llm' },
    ], msg, 'user_x');
    expect(result.order_no).toBe('ALI-8821-9999');
    expect(result.llm).toBeNull();
  });
});
