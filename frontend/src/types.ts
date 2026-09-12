export interface Account {
  id: string;
  provider: 'gmail' | 'outlook' | 'agently' | 'imap';
  email: string;
  display_name: string | null;
  status: 'active' | 'expired' | 'revoked';
  scopes: string | null;
  created_at: number;
  updated_at: number;
}

export interface FieldDef {
  key: string;
  label: string;
  source: 'header' | 'body_regex' | 'llm';
  header?: string;
  pattern?: string;
  required?: boolean;
}

export interface Rule {
  id: string;
  account_id: string;
  account_email: string | null;
  name: string;
  sender_mode: 'exact' | 'domain' | 'regex';
  sender_pattern: string;
  schedule_mode: 'interval' | 'on_receive';
  interval_minutes: number | null;
  fields: FieldDef[];
  dedupe: number;
  enabled: number;
  last_run_at: number | null;
  created_at: number;
}

export interface EmailItem {
  id: string;
  account_id: string;
  rule_id: string;
  rule_name: string | null;
  message_id: string;
  sender: string | null;
  sender_name: string | null;
  subject: string | null;
  llm_error?: string | null;
  received_at: number | null;
  fields: FieldDef[];
  extracted: Record<string, string | null>;
}

export interface EmailsPage {
  items: EmailItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface SyncLog {
  id: string;
  account_id: string;
  rule_id: string | null;
  run_at: number;
  trigger: 'cron' | 'webhook' | 'manual';
  fetched: number;
  inserted: number;
  skipped: number;
  error: string | null;
}

export interface RuleTestSample {
  sender: string | null;
  subject: string | null;
  receivedAt: number | null;
  extracted: Record<string, string | null>;
}

// ---------------- 用户 / 会员 / 支付 ----------------

export type UserRole = 'user' | 'admin';
export type MemberPlan = 'none' | 'trial' | 'paid' | 'lifetime';
export type MemberLevel = 'free' | 'trial' | 'paid' | 'lifetime';
export type UserStatus = 'active' | 'disabled';

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  role: UserRole;
  status: UserStatus;
  member_plan: MemberPlan;
  member_expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  llm_api_url?: string | null;
  llm_model?: string | null;
  llm_key_configured?: boolean;
}

export interface MemberInfo {
  level: MemberLevel;
  plan: MemberPlan;
  expires_at: number | null;
}

export interface Quota {
  accounts: number;
  rules: number;
}

export interface MeResponse {
  authed: boolean;
  user?: User;
  member?: MemberInfo;
  quota?: Quota;
}

export interface PublicSettings {
  site_name: string;
  allow_registration: string;
  smtp_configured: string;
}

export type PlanPeriod = 'month' | 'quarter' | 'year' | 'lifetime';

export interface Plan {
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

export interface PayType {
  key: string;
  label: string;
}

export interface PlansResponse {
  plans: Plan[];
  currency: string;
  pay_types: PayType[];
}

export type OrderStatus = 'pending' | 'paid' | 'expired' | 'refunded';

export interface Order {
  id: string;
  user_id: string;
  plan_id: string;
  plan_name: string;
  period_type: PlanPeriod;
  duration_months: number | null;
  price_usd: number;
  pay_type: string;
  out_trade_no: string;
  trade_no: string | null;
  status: OrderStatus;
  created_at: number;
  paid_at: number | null;
}

export interface CheckoutResponse {
  order: Order;
  payUrl: string;
  currency: string;
}

export interface AdminStats {
  users: number;
  paid_users: number;
  orders: number;
  paid_orders: number;
  revenue_usd: number;
}

export type SettingsMap = Record<string, string>;

export const PLAN_PERIOD_LABEL: Record<PlanPeriod, string> = {
  month: '月付',
  quarter: '季付',
  year: '年付',
  lifetime: '永久',
};

export const MEMBER_LEVEL_LABEL: Record<MemberLevel, string> = {
  free: '未开通',
  trial: '试用中',
  paid: '会员',
  lifetime: '永久会员',
};

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: '待支付',
  paid: '已支付',
  expired: '已过期',
  refunded: '已退款',
};
