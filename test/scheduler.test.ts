import { describe, it, expect } from 'vitest';
import { isRuleDue } from '../src/sync/scheduler';
import type { RuleRow } from '../src/db/types';

const base: RuleRow = {
  id: 'r1', user_id: null, account_id: 'a1', name: 't', sender_mode: 'exact', sender_pattern: 'x@y.com',
  schedule_mode: 'interval', interval_minutes: 60, fields_json: '[]', dedupe: 1, enabled: 1,
  last_run_at: null, created_at: 0, updated_at: 0,
};

const now = Date.now();

describe('isRuleDue', () => {
  it('on_receive 始终到期', () => {
    expect(isRuleDue({ ...base, schedule_mode: 'on_receive', last_run_at: Math.floor(now / 1000) }, now)).toBe(true);
  });

  it('interval：首次运行立即到期', () => {
    expect(isRuleDue(base, now)).toBe(true);
  });

  it('interval：未到间隔跳过', () => {
    expect(isRuleDue({ ...base, last_run_at: Math.floor(now / 1000) - 30 }, now)).toBe(false);
  });

  it('interval：超过间隔到期', () => {
    expect(isRuleDue({ ...base, last_run_at: Math.floor(now / 1000) - 3600 }, now)).toBe(true);
  });

  it('停用规则永不到期', () => {
    expect(isRuleDue({ ...base, enabled: 0 }, now)).toBe(false);
  });
});
