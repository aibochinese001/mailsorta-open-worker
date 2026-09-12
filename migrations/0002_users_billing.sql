-- 多用户 / 会员 / 支付 / 设置
-- 兼容已有部署：对 0001 的表做增量 ALTER（首次部署同样按序执行）

-- 用户表
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  member_plan TEXT NOT NULL DEFAULT 'trial' CHECK (member_plan IN ('none','trial','paid','lifetime')),
  member_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_member ON users(member_plan, member_expires_at);

-- 会员套餐（管理员后台维护）
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_usd REAL NOT NULL,
  period_type TEXT NOT NULL CHECK (period_type IN ('month','quarter','year','lifetime')),
  duration_months INTEGER,          -- lifetime 为 NULL
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 支付订单（易支付，USD 直接计价，通道自带汇率换算）
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  period_type TEXT NOT NULL,
  duration_months INTEGER,
  price_usd REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','refunded')),
  out_trade_no TEXT NOT NULL UNIQUE,
  epay_trade_no TEXT,
  pay_type TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_orders_user ON orders(user_id, created_at);
CREATE INDEX idx_orders_out_trade ON orders(out_trade_no);
CREATE INDEX idx_orders_status ON orders(status, created_at);

-- 站点设置（SMTP / 易支付 / 配额）
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 数据归属用户（多租户隔离）
ALTER TABLE accounts ADD COLUMN user_id TEXT;
ALTER TABLE rules ADD COLUMN user_id TEXT;
ALTER TABLE emails ADD COLUMN user_id TEXT;
ALTER TABLE sync_logs ADD COLUMN user_id TEXT;

CREATE INDEX idx_accounts_user ON accounts(user_id);
CREATE INDEX idx_rules_user ON rules(user_id);
CREATE INDEX idx_emails_user ON emails(user_id);
CREATE INDEX idx_sync_logs_user ON sync_logs(user_id);
