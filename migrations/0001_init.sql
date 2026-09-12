-- mailsorta-worker 初始迁移
-- 账号：已授权的邮箱源
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook', 'agently')),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  scopes TEXT,
  token_enc TEXT,
  token_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 规则：发件人 + 字段 + 调度
CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sender_mode TEXT NOT NULL CHECK (sender_mode IN ('exact', 'domain', 'regex')),
  sender_pattern TEXT NOT NULL,
  schedule_mode TEXT NOT NULL CHECK (schedule_mode IN ('interval', 'on_receive')),
  interval_minutes INTEGER,
  fields_json TEXT NOT NULL DEFAULT '[]',
  dedupe INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_rules_account ON rules(account_id);
CREATE INDEX idx_rules_enabled ON rules(enabled);

-- 邮件：整理结果（同规则同邮件唯一去重）
CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  thread_id TEXT,
  sender TEXT,
  sender_name TEXT,
  subject TEXT,
  received_at INTEGER,
  extracted_json TEXT,
  raw_url TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, rule_id, message_id)
);
CREATE INDEX idx_emails_rule_time ON emails(rule_id, received_at DESC);
CREATE INDEX idx_emails_account_time ON emails(account_id, received_at DESC);
CREATE INDEX idx_emails_sender ON emails(sender);

-- 同步日志
CREATE TABLE sync_logs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  rule_id TEXT,
  run_at INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'webhook', 'manual')),
  fetched INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_logs_time ON sync_logs(run_at DESC);
