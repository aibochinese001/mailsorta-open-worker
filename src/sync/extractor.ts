import type { Env } from '../env';
import type { FullMessage } from '../connectors/types';
import { llmExtractFields } from './llm';
import { getLlmConfig } from '../llm/config';

/** 字段定义（存在 rules.fields_json） */
export interface FieldDef {
  key: string;
  label: string;
  source: 'header' | 'body_regex' | 'llm';
  /** source=header 时：from / from_name / subject / date / to / message_id / thread_id */
  header?: string;
  /** source=body_regex 时：正则，含命名捕获组 ?<key> 或首个捕获组 */
  pattern?: string;
  required?: boolean;
}

const HEADER_MAP: Record<string, keyof FullMessage['summary'] & ('sender' | 'senderName' | 'subject' | 'id' | 'threadId')> = {
  from: 'sender',
  from_name: 'senderName',
  subject: 'subject',
  message_id: 'id',
  thread_id: 'threadId',
};

export function parseFields(json: string): FieldDef[] {
  try {
    const arr = JSON.parse(json) as FieldDef[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function extractField(field: FieldDef, msg: FullMessage): string | null {
  if (field.source === 'header') {
    const h = field.header ?? 'subject';
    if (h === 'date') {
      return msg.summary.receivedAt ? new Date(msg.summary.receivedAt).toISOString() : null;
    }
    if (h === 'to') return null; // 只读模式下收件人不可用，留空
    const v = msg.summary[HEADER_MAP[h] ?? 'subject'];
    return v ? String(v) : null;
  }

  if (field.source === 'body_regex') {
    const pattern = field.pattern;
    if (!pattern) return null;
    try {
      const re = new RegExp(pattern, 'ims');
      const m = re.exec(msg.bodyText);
      if (!m) return null;
      if (m.groups && field.key in m.groups && m.groups[field.key] !== undefined) {
        return m.groups[field.key] ?? null;
      }
      return m[1] ?? null;
    } catch {
      return null;
    }
  }

  return null; // llm 由 llmExtractFields 统一处理
}

/** 主入口：非 llm 字段同步提取，llm 字段批量调用（用户未配置 LLM 时置空，不阻塞入库） */
export async function extractFields(
  env: Env,
  fields: FieldDef[],
  msg: FullMessage,
  userId?: string | null,
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  const llmFields = fields.filter((f) => f.source === 'llm');

  for (const f of fields) {
    if (f.source === 'llm') continue;
    result[f.key] = extractField(f, msg);
  }

  if (llmFields.length > 0) {
    const cfg = userId ? await getLlmConfig(env, userId) : null;
    if (cfg) {
      try {
        const llm = await llmExtractFields(env, cfg, llmFields, msg);
        for (const f of llmFields) result[f.key] = llm[f.key] ?? null;
      } catch (e) {
        // LLM 提取失败不阻塞入库，字段置空；记录原因便于排查（_llm_error 不对外展示为业务字段）
        const reason = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
        result._llm_error = `LLM 提取失败：${reason}`;
        for (const f of llmFields) result[f.key] = null;
      }
    } else {
      result._llm_error = '未配置 LLM（账户设置 → AI 提取模型）';
      for (const f of llmFields) result[f.key] = null;
    }
  }

  return result;
}
