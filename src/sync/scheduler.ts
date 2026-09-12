import type { RuleRow } from '../db/types';

/** 规则是否本轮该跑：
 *  - on_receive：每次都跑（配合 webhook/高频 cron 实现"收到即整理"）
 *  - interval：按 last_run_at + interval_minutes 裁决
 */
export function isRuleDue(rule: RuleRow, nowMs: number): boolean {
  if (!rule.enabled) return false;
  if (rule.schedule_mode === 'on_receive') return true;
  const intervalMs = (rule.interval_minutes ?? 60) * 60_000;
  if (!rule.last_run_at) return true;
  return nowMs - rule.last_run_at * 1000 >= intervalMs;
}
