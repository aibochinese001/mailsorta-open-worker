import type { Env } from '../env';
import type { FullMessage } from '../connectors/types';
import type { FieldDef } from './extractor';
import type { LlmConfig } from '../llm/config';

/**
 * 可选 LLM 字段提取：OpenAI 兼容 chat/completions 端点（豆包 / DeepSeek / OpenAI 等）。
 * 使用规则所属用户自己的模型配置；一次请求批量提取所有 llm 字段；失败或超时返回全部 null（不阻塞入库）。
 */
export async function llmExtractFields(
  env: Env,
  cfg: LlmConfig,
  fields: FieldDef[],
  msg: FullMessage,
): Promise<Record<string, string | null>> {
  const base = cfg.api_url.replace(/\/$/, '');
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;

  const fieldSpec = fields
    .map((f) => `- "${f.key}"（${f.label}${f.required ? '，必填，缺失填 null' : '，可选' }）`)
    .join('\n');

  const system =
    '你是邮件信息抽取器。只根据提供的邮件内容提取指定字段，输出一个 JSON 对象，' +
    '键名严格使用给定的 key；字段缺失或无法确定时值为 null。不要输出任何解释或多余内容。';

  const user = [
    `发件人: ${msg.summary.sender}${msg.summary.senderName ? `（${msg.summary.senderName}）` : ''}`,
    `主题: ${msg.summary.subject ?? ''}`,
    `时间: ${msg.summary.receivedAt ? new Date(msg.summary.receivedAt).toISOString() : ''}`,
    `正文:\n${msg.bodyText.slice(0, 3000)}`,
    '',
    '需要提取的字段：',
    fieldSpec,
  ].join('\n');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.api_key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) throw new Error(`LLM 提取失败: HTTP ${res.status}（${cfg.model} @ ${cfg.api_url}）`);

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 返回为空');

  // 容错解析：截取第一个 { 到最后一个 }
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('LLM 返回非 JSON');
  const parsed = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;

  const out: Record<string, string | null> = {};
  for (const f of fields) {
    const v = parsed[f.key];
    out[f.key] = v === null || v === undefined ? null : String(v);
  }
  return out;
}
