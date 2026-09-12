import { describe, it, expect } from 'vitest';
import { matchSender } from '../src/sync/match';

describe('matchSender', () => {
  it('exact 模式忽略大小写', () => {
    expect(matchSender('Invoice@Alipay.com', 'exact', 'invoice@alipay.com')).toBe(true);
    expect(matchSender('invoice@alipay.com', 'exact', 'other@alipay.com')).toBe(false);
  });

  it('domain 模式匹配主域与子域', () => {
    expect(matchSender('alipay.com', 'domain', 'billing@alipay.com')).toBe(true);
    expect(matchSender('alipay.com', 'domain', 'billing@sub.alipay.com')).toBe(true);
    expect(matchSender('@alipay.com', 'domain', 'billing@alipay.com')).toBe(true);
    expect(matchSender('alipay.com', 'domain', 'alipay@notalipay.com.cn')).toBe(false);
  });

  it('regex 模式', () => {
    expect(matchSender('^.+@(finance|billing)\\.example\\.com$', 'regex', 'pay@billing.example.com')).toBe(true);
    expect(matchSender('^.+@(finance|billing)\\.example\\.com$', 'regex', 'pay@hr.example.com')).toBe(false);
  });

  it('空地址或非法正则返回 false', () => {
    expect(matchSender('x', 'exact', '')).toBe(false);
    expect(matchSender('([unclosed', 'regex', 'a@b.com')).toBe(false);
  });
});
