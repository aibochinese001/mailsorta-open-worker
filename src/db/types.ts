/** D1 行类型（与 migrations 对应） */

export interface AccountRow {
  id: string;
  user_id: string | null;
  provider: 'gmail' | 'outlook' | 'agently' | 'imap';
  email: string;
  display_name: string | null;
  status: 'active' | 'expired' | 'revoked';
  scopes: string | null;
  token_enc: string | null; // refresh token / IMAP 授权码（AES-256-GCM 加密后）；agently 为 null（凭据在桥接层）
  token_expires_at: number | null;
  imap_host: string | null;
  imap_port: number | null;
  created_at: number;
  updated_at: number;
}

export interface RuleRow {
  id: string;
  user_id: string | null;
  account_id: string;
  name: string;
  sender_mode: 'exact' | 'domain' | 'regex';
  sender_pattern: string;
  schedule_mode: 'interval' | 'on_receive';
  interval_minutes: number | null;
  fields_json: string; // FieldDef[]
  dedupe: number; // 0 | 1
  enabled: number; // 0 | 1
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface EmailRow {
  id: string;
  user_id: string | null;
  account_id: string;
  rule_id: string;
  message_id: string;
  thread_id: string | null;
  sender: string | null;
  sender_name: string | null;
  subject: string | null;
  received_at: number | null;
  extracted_json: string | null;
  raw_url: string | null;
  created_at: number;
}

export interface SyncLogRow {
  id: string;
  user_id: string | null;
  account_id: string;
  rule_id: string | null;
  run_at: number;
  trigger: 'cron' | 'webhook' | 'manual';
  fetched: number;
  inserted: number;
  skipped: number;
  error: string | null;
}

export type UserRole = 'user' | 'admin';
export type MemberPlan = 'none' | 'trial' | 'paid' | 'lifetime';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  role: UserRole;
  status: 'active' | 'disabled';
  member_plan: MemberPlan;
  member_expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  llm_api_url: string | null;
  llm_api_key_enc: string | null; // LLM API Key（AES-256-GCM 加密后）
  llm_model: string | null;
}

export type PlanPeriod = 'month' | 'quarter' | 'year' | 'lifetime';

export interface PlanRow {
  id: string;
  name: string;
  price_usd: number;
  period_type: PlanPeriod;
  duration_months: number | null;
  description: string | null;
  sort: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export type OrderStatus = 'pending' | 'paid' | 'expired' | 'refunded';

export interface OrderRow {
  id: string;
  user_id: string;
  plan_id: string;
  plan_name: string;
  period_type: PlanPeriod;
  duration_months: number | null;
  price_usd: number;
  currency: string;
  status: OrderStatus;
  out_trade_no: string;
  epay_trade_no: string | null;
  pay_type: string | null;
  created_at: number;
  paid_at: number | null;
}

export interface SettingsRow {
  key: string;
  value: string;
  updated_at: number;
}

export const PROVIDERS = ['gmail', 'outlook', 'agently', 'imap'] as const;
export type Provider = (typeof PROVIDERS)[number];
