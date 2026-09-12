import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { buildXlsxBuffer, emailToRow } from '../src/export/xlsx';
import type { EmailRow, RuleRow } from '../src/db/types';

const rule: RuleRow = {
  id: 'r1', user_id: null, account_id: 'a1', name: '发票整理', sender_mode: 'exact', sender_pattern: 'b@c.com',
  schedule_mode: 'interval', interval_minutes: 60,
  fields_json: JSON.stringify([
    { key: 'order_no', label: '订单号', source: 'body_regex', pattern: '订单号[：:]\\s*(?<order_no>[\\w-]+)' },
    { key: 'amount', label: '金额', source: 'body_regex', pattern: '金额[：:]\\s*([\\d.]+)' },
  ]),
  dedupe: 1, enabled: 1, last_run_at: null, created_at: 0, updated_at: 0,
};

const email: EmailRow = {
  id: 'e1', user_id: null, account_id: 'a1', rule_id: 'r1', message_id: 'm1', thread_id: null,
  sender: 'b@c.com', sender_name: 'B', subject: '订单 20260905001',
  received_at: Date.parse('2026-09-05T08:00:00Z'),
  extracted_json: JSON.stringify({ order_no: 'ALI-8821', amount: '128.00' }),
  raw_url: null, created_at: 0,
};

describe('Excel 导出', () => {
  it('emailToRow 合并规则字段 label 列', () => {
    const row = emailToRow(email, new Map([[rule.id, rule]]));
    expect(row['发件人']).toBe('b@c.com');
    expect(row['订单号']).toBe('ALI-8821');
    expect(row['金额']).toBe('128.00');
  });

  it('buildXlsxBuffer 生成可被 SheetJS 读回的工作簿', async () => {
    const rows = [emailToRow(email, new Map([[rule.id, rule]]))];
    const buf = await buildXlsxBuffer(rows, '邮件整理');
    expect(buf.byteLength).toBeGreaterThan(0);

    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
    expect(data).toHaveLength(1);
    expect(data[0]['订单号']).toBe('ALI-8821');
    expect(data[0]['发件人']).toBe('b@c.com');
  });
});
