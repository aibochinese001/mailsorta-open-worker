import type { Env } from '../env';
import type { Connector, FullMessage, ListOptions, MessageSummary } from './types';
import { getOauthConfig } from '../oauth/config';
import { getAccount } from '../db/queries';

/**
 * Agently Mail (QQ) 连接器。
 * 腾讯官方仅提供本地 CLI / MCP 形态（无服务端 REST API），
 * 因此本连接器通过自托管桥接层（bridge/）的 HTTP 接口访问：
 *   POST /rpc  { tool: 'me' | 'message.list' | 'message.search' | 'message.get', params }
 *   Authorization: Bearer <AGENTLY_BRIDGE_TOKEN>
 * 桥接层内部调用 agently-cli（stdout 为结构化 JSON，列表为 NDJSON 逐行解析）。
 * 字段做多别名映射：agently-cli 输出 message_id / from / received_at 等，
 * 统一为 id / sender / receivedAt 等内部结构。
 */

interface BridgeRpcParams {
  me: Record<string, never>;
  'message.list': { since?: number; limit?: number; folder?: string };
  'message.search': { query: string; limit?: number };
  'message.get': { id: string };
}

type BridgeResponse = Record<string, unknown> | unknown[] | string | number | boolean | null;

interface BridgeMe {
  email: string;
  displayName?: string;
  constraints?: Record<string, unknown>;
}

/** agently-cli / 桥接层可能返回的字段名（多别名归一化） */
type BridgeMessageItem = Record<string, unknown>;

function firstOf(...vals: unknown[]): unknown {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

/** from 可能是字符串 "a@b.com" 或对象 { address, name } */
function fromParts(v: unknown): { address?: string; name?: string } {
  if (typeof v === 'string') return { address: v };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return {
      address: str(firstOf(o.address, o.email, o.mailbox)),
      name: str(firstOf(o.name, o.displayName)),
    };
  }
  return {};
}

/** 解析时间：number(ms/s) | ISO 字符串 | Date 字符串 */
function toTimestamp(v: unknown): number {
  if (v === undefined || v === null || v === '') return Date.now();
  if (typeof v === 'number') {
    // 秒级时间戳（10 位）转毫秒
    return v < 1e12 ? v * 1000 : v;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : Date.now();
}

/** 桥接层消息 → 内部 MessageSummary（多别名归一化） */
export function toSummary(m: BridgeMessageItem): MessageSummary {
  const rawId = firstOf(m.id, m.message_id, m.msg_id, m.messageId);
  const from = fromParts(firstOf(m.sender, m.from, m.from_address, m.address));
  const senderName = str(firstOf(m.senderName, m.sender_name, m.from_name, from.name, m.displayName));
  return {
    id: str(rawId) ?? '',
    threadId: str(firstOf(m.threadId, m.thread_id, m.conversation_id)) ?? undefined,
    sender: str(firstOf(m.sender, from.address, m.sender_address)) ?? '',
    senderName,
    subject: str(firstOf(m.subject, m.title)) ?? '',
    receivedAt: toTimestamp(firstOf(m.receivedAt, m.received_at, m.date, m.timestamp, m.sentAt, m.sent_at)),
  };
}

function bodyOf(m: BridgeMessageItem): string {
  return str(firstOf(m.bodyText, m.body_text, m.body, m.text, m.textContent, m.plainText)) ?? '';
}

export async function bridgeUrl(env: Env): Promise<string> {
  const cfg = await getOauthConfig(env);
  if (!cfg.agently_bridge_url) {
    throw new Error('未配置 Agently 桥接层地址：请在管理后台「系统设置 → 邮箱接入」填写桥接层 URL');
  }
  return cfg.agently_bridge_url.replace(/\/$/, '');
}

async function rpc<T = BridgeResponse>(env: Env, tool: string, params: Record<string, unknown> = {}, user?: string): Promise<T> {
  const cfg = await getOauthConfig(env);
  const url = `${(await bridgeUrl(env))}/rpc`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.agently_bridge_token}`,
    },
    body: JSON.stringify({ tool, params, ...(user ? { user } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // 专门处理未登录错误，给出明确的重新绑定指引（409 或响应体含 NOT_LOGGED_IN）
    if (res.status === 409 || /NOT_LOGGED_IN|未登录|尚未绑定/i.test(text)) {
      throw new Error(
        'Agently Mail 登录状态已失效，请在「邮箱账号」页面重新点击「连接 Agently Mail (QQ)」扫码绑定。' +
        '（桥接层服务器重启或 session 过期会导致此问题）',
      );
    }
    throw new Error(`bridge /rpc ${tool} 失败: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as T;
  // 桥接层返回 { raw: ... } 说明 agently-cli 输出无法解析（未登录 / 命令不匹配），必须暴露而不是静默
  if (data && typeof data === 'object' && !Array.isArray(data) && 'raw' in (data as Record<string, unknown>)) {
    const raw = String((data as Record<string, unknown>).raw ?? '').slice(0, 300);
    throw new Error(`bridge /rpc ${tool} 返回无法解析的 CLI 输出${raw ? `：${raw}` : ''}，请检查桥接层上 agently-cli 是否已登录（agently-cli auth status）`);
  }
  return data;
}

/** 从对象结构中提取邮件数组（兼容 {messages:[...]} / {data:[...]} / {data:{messages:[...]}} 等常见包装，递归一层） */
function extractList(v: unknown): BridgeMessageItem[] | null {
  if (Array.isArray(v)) return v as BridgeMessageItem[];
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['messages', 'data', 'list', 'items', 'result', 'emails', 'rows']) {
      const val = o[k];
      if (Array.isArray(val)) return val as BridgeMessageItem[];
    }
    // 嵌套一层：data/result/payload 等对象内部再找数组（如 {ok:true, data:{messages:[...]}}）
    for (const k of ['data', 'result', 'payload', 'body', 'response']) {
      const val = o[k];
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const inner = extractList(val as Record<string, unknown>);
        if (inner) return inner;
      }
    }
  }
  return null;
}

/** 描述响应结构（键名+类型），用于同步日志诊断 */
function describeShape(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).slice(0, 10);
    return `{${keys.map((k) => `${k}:${Array.isArray(o[k]) ? `array[${(o[k] as unknown[]).length}]` : typeof o[k]}`).join(', ')}}`;
  }
  return typeof v;
}

export const agentlyConnector: Connector = {
  provider: 'agently',

  async listSummaries(env, accountId, opts) {
    // 多槽：按账号所属用户定位桥接层登录槽
    const acct = await getAccount(env.DB, accountId);
    const user = acct?.user_id ?? undefined;
    // 桥接层暂不支持服务端发件人过滤，取最近 N 封由编排器本地匹配
    const items = await rpc<unknown>(env, 'message.list', {
      since: opts.since ?? undefined,
      limit: opts.maxResults ?? 50,
    }, user);
    const arr = extractList(items);
    if (!arr) {
      throw new Error(`bridge message.list 未返回邮件数组（响应：${describeShape(items)}），请检查桥接层上 agently-cli 是否已登录并存在收件箱邮件`);
    }
    return arr.map(toSummary);
  },

  async getMessage(env, accountId, messageId) {
    const acct = await getAccount(env.DB, accountId);
    const user = acct?.user_id ?? undefined;
    const raw = await rpc<unknown>(env, 'message.get', { id: messageId }, user);
    // 解包常见包装：{data:{message:{...}}} / {data:{...}} / {message:{...}} / 原对象
    let m: BridgeMessageItem | null = null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      for (const k of ['data', 'result', 'payload', 'message']) {
        const v = o[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const inner = v as Record<string, unknown>;
          m = (inner.message && typeof inner.message === 'object' && !Array.isArray(inner.message)
            ? inner.message
            : inner) as BridgeMessageItem;
          break;
        }
      }
      if (!m) m = o as BridgeMessageItem;
    }
    if (!m || typeof m !== 'object') return null;
    const summary = toSummary(m);
    if (!summary.id) return null;
    return {
      summary,
      bodyText: bodyOf(m),
    } satisfies FullMessage;
  },
};

/** 查询桥接层当前授权账号（me） */
export async function bridgeMe(env: Env): Promise<BridgeMe> {
  const res = await rpc<Record<string, unknown>>(env, 'me');
  const email = String(res?.email ?? res?.account ?? '');
  if (!email) throw new Error('桥接层未返回邮箱地址，请先在 bridge 上完成 agently-cli auth login');
  return {
    email,
    displayName: res?.displayName ? String(res.displayName) : undefined,
    constraints: typeof res?.constraints === 'object' && res.constraints ? (res.constraints as Record<string, unknown>) : undefined,
  };
}

export type { BridgeRpcParams };
