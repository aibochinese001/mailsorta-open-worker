import type { Env } from '../env';
import type { EmailRow, RuleRow } from '../db/types';
import { listEmails } from '../db/queries';
import { parseFields } from '../sync/extractor';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME = 'text/csv; charset=utf-8';

export interface ExportFilters {
  user_id?: string;
  rule_id?: string;
  account_id?: string;
  sender?: string;
  subject?: string;
  date_from?: number;
  date_to?: number;
}

let xlsxPromise: Promise<typeof import('xlsx')> | null = null;
function getXlsx(): Promise<typeof import('xlsx')> {
  xlsxPromise ??= import('xlsx');
  return xlsxPromise;
}

/** 构建导出行：核心列 + 该规则自定义字段列 */
export function emailToRow(email: EmailRow, rulesById: Map<string, RuleRow>): Record<string, unknown> {
  const row: Record<string, unknown> = {
    收件时间: email.received_at ? new Date(email.received_at).toISOString() : '',
    发件人: email.sender ?? '',
    发件人名称: email.sender_name ?? '',
    主题: email.subject ?? '',
  };
  const rule = rulesById.get(email.rule_id);
  if (rule) {
    const fields = parseFields(rule.fields_json);
    let extracted: Record<string, string | null> = {};
    try {
      extracted = email.extracted_json ? (JSON.parse(email.extracted_json) as Record<string, string | null>) : {};
    } catch {
      extracted = {};
    }
    for (const f of fields) {
      row[f.label] = extracted[f.key] ?? '';
    }
  }
  return row;
}

/** 生成 .xlsx 的 ArrayBuffer（SheetJS 内存构建） */
export async function buildXlsxBuffer(rows: Record<string, unknown>[], sheetName = '邮件整理'): Promise<ArrayBuffer> {
  const XLSX = await getXlsx();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return out;
}

/** 生成 CSV（UTF-8，带 BOM，Excel 可直接打开） */
export async function buildCsv(rows: Record<string, unknown>[]): Promise<string> {
  const XLSX = await getXlsx();
  const ws = XLSX.utils.json_to_sheet(rows);
  return XLSX.utils.sheet_to_csv(ws);
}

export interface ExportResult {
  kind: 'direct' | 'r2';
  buffer?: ArrayBuffer;
  csv?: string;
  total: number;
  exportId?: string;
}

/** 按筛选条件全量导出：小数据直接返回 buffer；大数据写入 R2（按用户隔离）走异步下载 */
export async function exportEmails(
  env: Env,
  filters: ExportFilters,
  rulesById: Map<string, RuleRow>,
  userId?: string,
): Promise<ExportResult> {
  const rows: Record<string, unknown>[] = [];
  let total = 0;
  let page = 1;
  const pageSize = 500;

  for (;;) {
    const emails = await listEmails(env.DB, filters, page, pageSize);
    if (emails.length === 0) break;
    for (const e of emails) rows.push(emailToRow(e, rulesById));
    total += emails.length;
    if (emails.length < pageSize) break;
    page += 1;
  }

  if (total > 20_000) {
    const exportId = crypto.randomUUID();
    const buffer = await buildXlsxBuffer(rows);
    const key = userId ? `exports/${userId}/${exportId}.xlsx` : `exports/${exportId}.xlsx`;
    await env.R2.put(key, buffer, {
      httpMetadata: { contentType: XLSX_MIME },
    });
    return { kind: 'r2', total, exportId };
  }

  return { kind: 'direct', buffer: await buildXlsxBuffer(rows), total };
}
