import type { Env } from '../env';
import type { RuleRow, SyncLogRow } from '../db/types';
import {
  emailExists, findEmailIdByKey, getAccount, getUserById, insertEmail, insertSyncLog, listRules, listRulesByAccount,
  updateAccountStatus, updateEmailExtracted, updateRuleRunAt, getRule,
} from '../db/queries';
import { getConnector } from '../connectors/registry';
import { AuthExpiredError, type FullMessage } from '../connectors/types';
import { matchSender } from './match';
import { isRuleDue } from './scheduler';
import { parseFields, extractFields } from './extractor';
import { rateLimitCheck, releaseSyncLock, tryAcquireSyncLock } from './rate-limit';
import { memberStatus } from '../billing/service';

export type SyncTrigger = SyncLogRow['trigger'];

export interface SyncOutcome {
  ruleId: string;
  accountId: string;
  trigger: SyncTrigger;
  fetched: number;
  inserted: number;
  skipped: number;
  error?: string;
}

function logFromOutcome(o: SyncOutcome, userId: string | null): Parameters<typeof insertSyncLog>[1] {
  return {
    user_id: userId,
    account_id: o.accountId,
    rule_id: o.ruleId,
    trigger: o.trigger,
    fetched: o.fetched,
    inserted: o.inserted,
    skipped: o.skipped,
    error: o.error,
  };
}

/** 单条规则的完整同步流水线：令牌 → 拉列表 → 本地匹配 → 去重 → 取全文 → 提取 → 入库 */
export async function runSyncForRule(env: Env, rule: RuleRow, trigger: SyncTrigger): Promise<SyncOutcome> {
  const outcome: SyncOutcome = {
    ruleId: rule.id,
    accountId: rule.account_id,
    trigger,
    fetched: 0,
    inserted: 0,
    skipped: 0,
  };
  const nowMs = Date.now();

  try {
    const account = await getAccount(env.DB, rule.account_id);
    if (!account) {
      outcome.error = '账号不存在';
      await insertSyncLog(env.DB, logFromOutcome(outcome, null));
      return outcome;
    }
    if (account.status !== 'active') {
      outcome.error = `账号状态 ${account.status}，跳过`;
      await insertSyncLog(env.DB, logFromOutcome(outcome, account.user_id));
      return outcome;
    }

    await rateLimitCheck(env, account.provider);
    const connector = getConnector(account.provider);
    const cursor = Number((await env.KV.get(`cursor:${account.id}`)) ?? 0) || undefined;

    const summaries = await connector.listSummaries(env, account.id, {
      senderPattern: rule.sender_pattern,
      senderMode: rule.sender_mode,
      since: cursor,
      maxResults: 50,
    });

    const fields = parseFields(rule.fields_json);
    let maxReceived = cursor ?? 0;

    for (const s of summaries) {
      if (!matchSender(rule.sender_pattern, rule.sender_mode, s.sender)) continue;
      outcome.fetched += 1;
      if (s.receivedAt > maxReceived) maxReceived = s.receivedAt;

      // 先查重：命中时按规则语义处理——勾选去重则跳过；未勾选去重则走"重新提取覆盖"（本轮已拉全文）
      if (await emailExists(env.DB, account.id, rule.id, s.id)) {
        if (rule.dedupe) {
          outcome.skipped += 1;
          continue;
        }
      }

      let full: FullMessage | null = null;
      try {
        full = await connector.getMessage(env, account.id, s.id);
      } catch (e) {
        if (e instanceof AuthExpiredError) throw e;
        // 单封失败不中断整轮，但不再入库；记录首个失败原因便于诊断
        outcome.error ??= e instanceof Error ? e.message : String(e);
        outcome.skipped += 1;
        continue;
      }
      if (!full) {
        outcome.error ??= `message.get 未返回有效邮件（id=${s.id}）`;
        outcome.skipped += 1;
        continue;
      }

      const extracted = await extractFields(env, fields, full, account.user_id);
      if (full.bodyText.length === 0) {
        console.warn(`[sync] 邮件正文为空: account=${account.id} provider=${account.provider} msgId=${s.id} subject=${s.subject}`);
      }
      const inserted = await insertEmail(env.DB, {
        user_id: account.user_id,
        account_id: account.id,
        rule_id: rule.id,
        message_id: s.id,
        thread_id: s.threadId ?? null,
        sender: full.summary.sender || s.sender || null,
        sender_name: full.summary.senderName ?? s.senderName ?? null,
        subject: full.summary.subject ?? s.subject ?? null,
        received_at: full.summary.receivedAt || s.receivedAt || nowMs,
        extracted_json: JSON.stringify(extracted),
        raw_url: null,
      });
      if (inserted) {
        outcome.inserted += 1;
      } else {
        // 数据库唯一约束兜底命中（并发竞态或提前查重漏过的重复）：不再抛 UNIQUE 错误
        if (!rule.dedupe) {
          // 未勾选去重：以最新提取结果覆盖已存在记录
          const existingId = await findEmailIdByKey(env.DB, account.id, rule.id, s.id);
          if (existingId) await updateEmailExtracted(env.DB, existingId, JSON.stringify(extracted));
          outcome.inserted += 1;
        } else {
          outcome.skipped += 1;
        }
      }
    }

    if (maxReceived > 0) {
      await env.KV.put(`cursor:${account.id}`, String(maxReceived));
    }
    await updateRuleRunAt(env.DB, rule.id, Math.floor(nowMs / 1000));
  } catch (e) {
    outcome.error = e instanceof Error ? e.message : String(e);
    if (e instanceof AuthExpiredError) {
      await updateAccountStatus(env.DB, rule.account_id, 'expired');
    }
  }

  const account = await getAccount(env.DB, rule.account_id).catch(() => null);
  await insertSyncLog(env.DB, logFromOutcome(outcome, account?.user_id ?? null));
  return outcome;
}

export interface RunAllOptions {
  trigger: SyncTrigger;
  ruleId?: string;
  accountId?: string;
  userId?: string;
}

/** 全量调度入口：锁 + 取规则 + 到期裁决 + 逐条执行 */
export async function runSyncAll(env: Env, opts: RunAllOptions): Promise<SyncOutcome[]> {
  const outcomes: SyncOutcome[] = [];
  if (!(await tryAcquireSyncLock(env))) {
    return outcomes; // 已有任务在跑
  }
  try {
    let rules: RuleRow[];
    if (opts.ruleId) {
      const rule = await getRule(env.DB, opts.ruleId);
      if (rule && (!opts.userId || rule.user_id === opts.userId)) {
        rules = [rule];
      } else {
        rules = [];
      }
    } else if (opts.accountId) {
      rules = await listRulesByAccount(env.DB, opts.accountId);
    } else {
      rules = await listRules(env.DB, opts.userId, true);
    }

    const nowMs = Date.now();
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (!isRuleDue(rule, nowMs)) continue;
      // 会员到期（free）：跳过该用户的整理任务（历史数据仍可查询/导出），不写日志防刷屏
      if (rule.user_id) {
        const owner = await getUserById(env.DB, rule.user_id);
        if (owner && memberStatus(owner).level === 'free') continue;
      }
      outcomes.push(await runSyncForRule(env, rule, opts.trigger));
    }
  } finally {
    await releaseSyncLock(env);
  }
  return outcomes;
}
