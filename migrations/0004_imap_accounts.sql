-- IMAP 邮箱账号（QQ/163/126）：provider 扩展 + 服务器配置列
-- SQLite 无法直接修改 CHECK 约束，重建 accounts 表
-- 注意：必须保留全部原列（含 user_id），否则数据会随 DROP 丢失
CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook', 'agently', 'imap')),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  scopes TEXT,
  token_enc TEXT,
  token_expires_at INTEGER,
  imap_host TEXT,
  imap_port INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO accounts_new (id, user_id, provider, email, display_name, status, scopes, token_enc, token_expires_at, imap_host, imap_port, created_at, updated_at)
  SELECT id, user_id, provider, email, display_name, status, scopes, token_enc, token_expires_at, NULL, NULL, created_at, updated_at FROM accounts;

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
