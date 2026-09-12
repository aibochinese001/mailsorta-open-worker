import { describe, it, expect } from 'vitest';
import { parseCliOutput } from '../bridge/parse.mjs';

describe('parseCliOutput（agently-cli 输出解析）', () => {
  it('整段 JSON 对象（+me）原样返回', () => {
    const out = JSON.stringify({ email: 'a@agent.qq.com', displayName: 'A' });
    expect(parseCliOutput(out)).toEqual({ email: 'a@agent.qq.com', displayName: 'A' });
  });

  it('整段 JSON 数组原样返回', () => {
    expect(parseCliOutput('[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('NDJSON 每行 {"message": {...}} 收集 message 本体', () => {
    const out = [
      '{"message": {"message_id": "msg_1", "subject": "S1"}}',
      '{"message": {"message_id": "msg_2", "subject": "S2"}}',
    ].join('\n');
    expect(parseCliOutput(out)).toEqual([
      { message_id: 'msg_1', subject: 'S1' },
      { message_id: 'msg_2', subject: 'S2' },
    ]);
  });

  it('NDJSON 混入非 JSON 提示行时跳过，仍返回有效行', () => {
    const out = 'Fetching messages...\n{"message": {"message_id": "msg_1"}}\nDone\n{"message": {"message_id": "msg_2"}}';
    const r = parseCliOutput(out);
    expect(Array.isArray(r)).toBe(true);
    expect((r as unknown[]).map((x) => (x as { message_id: string }).message_id)).toEqual(['msg_1', 'msg_2']);
  });

  it('空输出返回 {raw: ""}', () => {
    expect(parseCliOutput('')).toEqual({ raw: '' });
  });

  it('完全无法解析时返回 {raw} 且截断', () => {
    const r = parseCliOutput('Error: not logged in'.repeat(50));
    expect(r).toHaveProperty('raw');
    expect((r as { raw: string }).raw.length).toBeLessThanOrEqual(500);
  });
});
