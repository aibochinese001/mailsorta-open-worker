import type { Env } from '../env';
import type { Provider } from '../db/types';

/** 邮箱连接器统一只读契约：三个数据源都实现同一接口，编排器不关心底层协议 */

export interface MessageSummary {
  id: string;
  threadId?: string;
  sender: string;
  senderName?: string;
  subject?: string;
  receivedAt: number; // 毫秒时间戳
}

export interface FullMessage {
  summary: MessageSummary;
  bodyText: string;
}

export interface ListOptions {
  senderPattern: string;
  senderMode: 'exact' | 'domain' | 'regex';
  /** 增量游标：只取该时间之后收到的邮件（毫秒） */
  since?: number;
  maxResults?: number;
}

export interface Connector {
  provider: Provider;
  /** 列出候选邮件摘要。Provider 侧尽力原生过滤，最终匹配由编排器本地裁决。 */
  listSummaries(env: Env, accountId: string, opts: ListOptions): Promise<MessageSummary[]>;
  /** 拉取单封邮件全文（正文纯文本） */
  getMessage(env: Env, accountId: string, messageId: string): Promise<FullMessage | null>;
}

export class ConnectorError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export class AuthExpiredError extends ConnectorError {
  constructor(message: string) {
    super(message, false);
    this.name = 'AuthExpiredError';
  }
}

export class RateLimitHitError extends ConnectorError {
  constructor(message: string) {
    super(message, false);
    this.name = 'RateLimitHitError';
  }
}
