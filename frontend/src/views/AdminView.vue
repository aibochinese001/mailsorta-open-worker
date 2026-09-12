<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { api, fmtTime } from '../api';
import type { AdminStats, Order, OrderStatus, Plan, PlanPeriod, SettingsMap, User } from '../types';
import { MEMBER_LEVEL_LABEL, ORDER_STATUS_LABEL, PLAN_PERIOD_LABEL } from '../types';

type Section = 'stats' | 'users' | 'plans' | 'orders' | 'settings';
const section = ref<Section>('stats');

// ---------------- 统计 ----------------
const stats = ref<AdminStats | null>(null);

// ---------------- 用户管理 ----------------
const users = ref<User[]>([]);
const userPage = ref(1);
const userSearch = ref('');
const userMsg = ref('');

// ---------------- 套餐管理 ----------------
const plans = ref<Plan[]>([]);
const showPlanForm = ref(false);
const planMsg = ref('');
const planForm = reactive({
  id: '',
  name: '',
  price_usd: 4.99,
  period_type: 'month' as PlanPeriod,
  duration_months: 1,
  description: '',
  sort: 0,
  enabled: true,
});

// ---------------- 订单管理 ----------------
const orders = ref<Order[]>([]);
const orderFilter = ref<'' | OrderStatus>('');

// ---------------- 设置 ----------------
const SETTING_KEYS = [
  'site_name', 'allow_registration', 'admin_emails',
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from',
  'epay_api_url', 'epay_pid', 'epay_key', 'epay_pay_types', 'epay_sign_mode',
  'google_client_id', 'google_client_secret', 'microsoft_client_id', 'microsoft_client_secret',
  'agently_bridge_url', 'agently_bridge_token',
  'quota_free_accounts', 'quota_free_rules', 'quota_paid_accounts', 'quota_paid_rules',
] as const;
const PAY_TYPE_OPTIONS = [
  { key: 'alipay', label: '支付宝' },
  { key: 'wxpay', label: '微信支付' },
  { key: 'gmpay', label: 'USDT' },
  { key: 'fiatstripe', label: 'Stripe' },
  { key: 'ecny', label: 'e-CNY（数字人民币）' },
];
const settingsMap = ref<SettingsMap>({});
const settingsMsg = ref('');
const saving = ref(false);
const locationOrigin = window.location.origin;

function setSection(s: Section) {
  section.value = s;
  if (s === 'stats') loadStats();
  if (s === 'users') loadUsers(1);
  if (s === 'plans') loadPlans();
  if (s === 'orders') loadOrders();
  if (s === 'settings') loadSettings();
}

// ---------------- 统计 ----------------
async function loadStats() {
  stats.value = await api.get<AdminStats>('/admin/stats');
}

// ---------------- 用户管理 ----------------
async function loadUsers(page: number) {
  userPage.value = page;
  const q = userSearch.value.trim() ? `&search=${encodeURIComponent(userSearch.value.trim())}` : '';
  const res = await api.get<{ users: User[] }>(`/admin/users?page=${page}${q}`);
  users.value = res.users;
}

async function patchUser(u: User, patch: Partial<Pick<User, 'status' | 'role' | 'member_plan' | 'member_expires_at' | 'password'>>) {
  userMsg.value = '';
  try {
    const res = await api.patch<{ user: User }>(`/admin/users/${u.id}`, patch);
    Object.assign(u, res.user);
    userMsg.value = '已保存';
  } catch (e) {
    userMsg.value = e instanceof Error ? e.message : '保存失败';
  }
}

function toggleStatus(u: User) {
  patchUser(u, { status: u.status === 'active' ? 'disabled' : 'active' });
}

function toggleRole(u: User) {
  patchUser(u, { role: u.role === 'admin' ? 'user' : 'admin' });
}

/** 管理员重置指定用户密码 */
function resetPassword(u: User) {
  const password = window.prompt(`为用户 ${u.email} 设置新密码（至少 8 位）`, '');
  if (password === null) return;
  if (password.length < 8) {
    window.alert('密码至少 8 位');
    return;
  }
  patchUser(u, { password });
}

function setMember(u: User, plan: User['member_plan']) {
  const expires = plan === 'lifetime' ? null : u.member_expires_at && u.member_expires_at > Date.now() ? u.member_expires_at : Date.now() + 7 * 86400_000;
  patchUser(u, { member_plan: plan, member_expires_at: expires });
}

/** 管理员直接修改用户会员到期时间（输入 YYYY-MM-DD） */
function setMemberExpiry(u: User) {
  if (u.member_plan === 'lifetime') {
    window.alert('永久会员无需设置到期时间');
    return;
  }
  const cur = u.member_expires_at ? new Date(u.member_expires_at).toISOString().slice(0, 10) : '';
  const input = window.prompt(
    `为用户 ${u.email} 设置新的会员到期日期（YYYY-MM-DD）。\n留空表示清除到期时间（需配合套餐状态）`,
    cur,
  );
  if (input === null) return;
  const d = input.trim();
  if (!d) {
    patchUser(u, { member_expires_at: null });
    return;
  }
  const ms = new Date(`${d}T23:59:59`).getTime();
  if (Number.isNaN(ms)) {
    window.alert('日期格式不正确，应为 YYYY-MM-DD');
    return;
  }
  // 到期时间有值且原套餐为 none 时，自动转为付费会员，保证等级判断生效
  const plan: User['member_plan'] = u.member_plan === 'none' ? 'paid' : u.member_plan;
  patchUser(u, { member_plan: plan, member_expires_at: ms });
}

// ---------------- 套餐管理 ----------------
async function loadPlans() {
  plans.value = (await api.get<{ plans: Plan[] }>('/admin/plans')).plans;
}

function openPlanCreate() {
  Object.assign(planForm, { id: '', name: '', price_usd: 4.99, period_type: 'month', duration_months: 1, description: '', sort: 0, enabled: true });
  showPlanForm.value = true;
}

function openPlanEdit(p: Plan) {
  Object.assign(planForm, {
    id: p.id, name: p.name, price_usd: p.price_usd, period_type: p.period_type,
    duration_months: p.duration_months ?? 1, description: p.description ?? '', sort: p.sort, enabled: !!p.enabled,
  });
  showPlanForm.value = true;
}

async function savePlan() {
  planMsg.value = '';
  const payload = {
    name: planForm.name,
    price_usd: Number(planForm.price_usd),
    period_type: planForm.period_type,
    duration_months: planForm.period_type === 'lifetime' ? null : Number(planForm.duration_months) || 1,
    description: planForm.description,
    sort: Number(planForm.sort) || 0,
    enabled: planForm.enabled,
  };
  try {
    if (planForm.id) await api.put(`/admin/plans/${planForm.id}`, payload);
    else await api.post('/admin/plans', payload);
    showPlanForm.value = false;
    await loadPlans();
  } catch (e) {
    planMsg.value = e instanceof Error ? e.message : '保存失败';
  }
}

async function removePlan(p: Plan) {
  if (!confirm(`确定删除套餐「${p.name}」？已有订单不受影响。`)) return;
  await api.del(`/admin/plans/${p.id}`);
  await loadPlans();
}

// ---------------- 订单管理 ----------------
async function loadOrders() {
  const q = orderFilter.value ? `?status=${orderFilter.value}` : '';
  orders.value = (await api.get<{ orders: Order[] }>(`/admin/orders${q}`)).orders;
}

// ---------------- 设置 ----------------
async function loadSettings() {
  const res = await api.get<{ settings: SettingsMap }>('/admin/settings');
  settingsMap.value = { ...res.settings };
  // 确保支付方式勾选项有默认值
  if (!settingsMap.value['epay_pay_types']) settingsMap.value['epay_pay_types'] = 'alipay,wxpay,gmpay,fiatstripe';
  if (!settingsMap.value['epay_sign_mode']) settingsMap.value['epay_sign_mode'] = 'standard';
}

function payTypesList(): string[] {
  return (settingsMap.value['epay_pay_types'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function togglePayType(key: string, checked: boolean) {
  const list = payTypesList();
  const i = list.indexOf(key);
  if (checked && i < 0) list.push(key);
  if (!checked && i >= 0) list.splice(i, 1);
  settingsMap.value['epay_pay_types'] = list.join(',');
}

async function saveSettings() {
  settingsMsg.value = '';
  saving.value = true;
  try {
    // 掩码值 '*' 表示保留原值
    const payload: SettingsMap = { ...settingsMap.value };
    for (const k of ['smtp_pass', 'epay_key', 'google_client_secret', 'microsoft_client_secret', 'agently_bridge_token'] as const) {
      if (payload[k] === '********') payload[k] = '*';
    }
    const res = await api.put<{ settings: SettingsMap }>('/admin/settings', payload);
    settingsMap.value = { ...res.settings };
    settingsMsg.value = '设置已保存';
  } catch (e) {
    settingsMsg.value = e instanceof Error ? e.message : '保存失败';
  } finally {
    saving.value = false;
  }
}

onMounted(loadStats);
</script>

<template>
  <div>
    <div class="card">
      <div class="admin-tabs">
        <button
          v-for="s in ([{ k: 'stats', l: '概览' }, { k: 'users', l: '用户管理' }, { k: 'plans', l: '套餐管理' }, { k: 'orders', l: '订单管理' }, { k: 'settings', l: '系统设置' }] as const)"
          :key="s.k"
          class="tab"
          :class="{ active: section === s.k }"
          @click="setSection(s.k)"
        >
          {{ s.l }}
        </button>
      </div>
    </div>

    <!-- 概览 -->
    <template v-if="section === 'stats'">
      <div class="grid2">
        <div class="stat-card"><div class="label">注册用户</div><div class="num">{{ stats?.users ?? '…' }}</div></div>
        <div class="stat-card"><div class="label">付费/会员用户</div><div class="num">{{ stats?.paid_users ?? '…' }}</div></div>
        <div class="stat-card"><div class="label">订单总数</div><div class="num">{{ stats?.orders ?? '…' }}</div></div>
        <div class="stat-card"><div class="label">已支付订单</div><div class="num">{{ stats?.paid_orders ?? '…' }}</div></div>
        <div class="stat-card"><div class="label">收入（USD）</div><div class="num">${{ stats?.revenue_usd ?? '…' }}</div></div>
      </div>
      <p class="small muted">收入按最近 1000 笔已支付订单累计（USD 直接计价，易支付通道收款）。</p>
    </template>

    <!-- 用户管理 -->
    <template v-if="section === 'users'">
      <div class="card">
        <div class="row">
          <input v-model="userSearch" placeholder="搜索邮箱/昵称" class="grow" @keyup.enter="loadUsers(1)" />
          <button class="secondary" @click="loadUsers(1)">搜索</button>
          <button class="primary" @click="loadUsers(1)">刷新</button>
        </div>
        <p v-if="userMsg" class="small muted">{{ userMsg }}</p>
      </div>
      <table>
        <thead>
          <tr><th>邮箱</th><th>角色</th><th>状态</th><th>会员</th><th>到期时间</th><th>注册时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>{{ u.email }}<div v-if="u.display_name" class="small muted">{{ u.display_name }}</div></td>
            <td><span class="tag" :class="u.role === 'admin' ? 'orange' : 'gray'">{{ u.role === 'admin' ? '管理员' : '用户' }}</span></td>
            <td><span class="tag" :class="u.status === 'active' ? 'green' : 'red'">{{ u.status === 'active' ? '正常' : '禁用' }}</span></td>
            <td><span class="tag" :class="u.member_plan === 'lifetime' ? 'orange' : 'green'">{{ MEMBER_LEVEL_LABEL[u.member_plan] }}</span></td>
            <td class="small muted">{{ u.member_expires_at ? fmtTime(u.member_expires_at) : u.member_plan === 'lifetime' ? '永久' : '—' }}</td>
            <td class="small muted">{{ fmtTime(u.created_at) }}</td>
            <td>
              <div class="row">
                <button class="secondary" @click="toggleRole(u)">{{ u.role === 'admin' ? '取消管理' : '设为管理' }}</button>
                <button class="secondary" @click="resetPassword(u)">重置密码</button>
                <button class="secondary" @click="toggleStatus(u)">{{ u.status === 'active' ? '禁用' : '启用' }}</button>
                <button class="secondary" @click="setMember(u, 'lifetime')">送永久</button>
                <button class="secondary" @click="setMember(u, 'trial')">送 7 天试用</button>
                <button class="secondary" @click="setMemberExpiry(u)">改到期</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="pager">
        <button class="secondary" :disabled="userPage <= 1" @click="loadUsers(userPage - 1)">上一页</button>
        <span class="small muted">第 {{ userPage }} 页</span>
        <button class="secondary" @click="loadUsers(userPage + 1)">下一页</button>
      </div>
    </template>

    <!-- 套餐管理 -->
    <template v-if="section === 'plans'">
      <div class="card">
        <div class="row">
          <button class="primary" @click="openPlanCreate">+ 新建套餐</button>
          <span class="small muted">价格 USD 直接计价，易支付通道收款（微信/支付宝自带汇率换算）。</span>
        </div>
        <p v-if="planMsg" class="small error">{{ planMsg }}</p>
      </div>
      <table>
        <thead>
          <tr><th>名称</th><th>价格(USD)</th><th>周期</th><th>时长(月)</th><th>排序</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="p in plans" :key="p.id">
            <td>{{ p.name }}<div v-if="p.description" class="small muted">{{ p.description }}</div></td>
            <td>${{ p.price_usd }}</td>
            <td>{{ PLAN_PERIOD_LABEL[p.period_type] }}</td>
            <td>{{ p.duration_months ?? '—' }}</td>
            <td>{{ p.sort }}</td>
            <td><span class="tag" :class="p.enabled ? 'green' : 'gray'">{{ p.enabled ? '上架' : '下架' }}</span></td>
            <td>
              <div class="row">
                <button class="secondary" @click="openPlanEdit(p)">编辑</button>
                <button class="danger" @click="removePlan(p)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!plans.length" class="empty">还没有套餐，点击「新建套餐」创建第一个。</div>

      <div v-if="showPlanForm" class="modal-mask" @click.self="showPlanForm = false">
        <div class="modal">
          <h3 style="margin-top: 0">{{ planForm.id ? '编辑套餐' : '新建套餐' }}</h3>
          <div class="grid2">
            <label class="field">名称<input v-model="planForm.name" placeholder="如：月度会员" /></label>
            <label class="field">价格（USD）<input v-model.number="planForm.price_usd" type="number" min="0.01" step="0.01" /></label>
            <label class="field">周期
              <select v-model="planForm.period_type">
                <option value="month">月付</option>
                <option value="quarter">季付</option>
                <option value="year">年付</option>
                <option value="lifetime">永久</option>
              </select>
            </label>
            <label class="field" v-if="planForm.period_type !== 'lifetime'">时长（月）<input v-model.number="planForm.duration_months" type="number" min="1" /></label>
            <label class="field">排序<input v-model.number="planForm.sort" type="number" /></label>
            <label class="field checkbox"><input v-model="planForm.enabled" type="checkbox" /> 上架销售</label>
            <label class="field full">描述<input v-model="planForm.description" placeholder="如：适合轻量用户的月度订阅" /></label>
          </div>
          <div class="row" style="margin-top: 14px">
            <button class="primary" @click="savePlan">保存</button>
            <button class="secondary" @click="showPlanForm = false">取消</button>
          </div>
          <p v-if="planMsg" class="small error">{{ planMsg }}</p>
        </div>
      </div>
    </template>

    <!-- 订单管理 -->
    <template v-if="section === 'orders'">
      <div class="card">
        <div class="row">
          <span class="muted small">状态筛选：</span>
          <select v-model="orderFilter" @change="loadOrders">
            <option value="">全部</option>
            <option value="pending">待支付</option>
            <option value="paid">已支付</option>
            <option value="expired">已过期</option>
            <option value="refunded">已退款</option>
          </select>
          <button class="secondary" @click="loadOrders">刷新</button>
        </div>
      </div>
      <table>
        <thead>
          <tr><th>订单号</th><th>用户ID</th><th>套餐</th><th>金额</th><th>支付方式</th><th>状态</th><th>下单时间</th><th>支付流水</th></tr>
        </thead>
        <tbody>
          <tr v-for="o in orders" :key="o.id">
            <td class="small muted">{{ o.out_trade_no }}</td>
            <td class="small muted">{{ o.user_id.slice(0, 8) }}…</td>
            <td>{{ o.plan_name }}</td>
            <td>${{ o.price_usd }}</td>
            <td>{{ o.pay_type }}</td>
            <td><span class="tag" :class="o.status === 'paid' ? 'green' : o.status === 'pending' ? 'orange' : 'gray'">{{ ORDER_STATUS_LABEL[o.status] }}</span></td>
            <td class="small muted">{{ fmtTime(o.created_at) }}</td>
            <td class="small muted">{{ o.trade_no ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="!orders.length" class="empty">暂无订单</div>
    </template>

    <!-- 系统设置 -->
    <template v-if="section === 'settings'">
      <div class="card">
        <h3 style="margin-top: 0">站点设置</h3>
        <div class="grid2">
          <label class="field">站点名称<input v-model="settingsMap['site_name']" placeholder="MailSorta" /></label>
          <label class="field checkbox"><input v-model="settingsMap['allow_registration']" type="checkbox" true-value="1" false-value="0" /> 开放注册</label>
          <label class="field">管理员邮箱白名单（逗号分隔，注册命中自动授予管理权限）<input v-model="settingsMap['admin_emails']" placeholder="admin@example.com" /></label>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-top: 0">QQ SMTP 邮件（验证码 / 支付通知）</h3>
        <div class="grid2">
          <label class="field">SMTP 服务器<input v-model="settingsMap['smtp_host']" placeholder="smtp.qq.com" /></label>
          <label class="field">端口<input v-model="settingsMap['smtp_port']" placeholder="465" /></label>
          <label class="field checkbox"><input v-model="settingsMap['smtp_secure']" type="checkbox" true-value="1" false-value="0" /> SSL/TLS 加密</label>
          <label class="field">发件邮箱（账号）<input v-model="settingsMap['smtp_user']" placeholder="you@qq.com" /></label>
          <label class="field">授权码/密码<input v-model="settingsMap['smtp_pass']" placeholder="********" /></label>
          <label class="field">发件人名称<input v-model="settingsMap['smtp_from']" placeholder="MailSorta 团队" /></label>
        </div>
        <p class="small muted">QQ 邮箱：设置 → 账户 → 开启 SMTP 服务，使用生成的授权码。smtp_secure 勾选对应 465(SMTPS)；如用 587 STARTTLS 请保持勾选并确认服务器支持。</p>
      </div>

      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <h3 style="margin:0">易支付网关配置</h3>
          <a
            href="https://api.payone.uk"
            target="_blank"
            rel="noopener"
            style="display:inline-block;background:linear-gradient(135deg,#1e6fff,#4f8fff);color:#fff;text-decoration:none;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;white-space:nowrap;box-shadow:0 2px 8px rgba(30,111,255,0.35);transition:opacity .15s ease;"
            onmouseover="this.style.opacity='0.88'"
            onmouseout="this.style.opacity='1'"
          >开通商户 ↗</a>
        </div>
        <div class="grid2" style="margin-top:12px">
          <label class="field">易支付接口地址<input v-model="settingsMap['epay_api_url']" placeholder="https://pay.example.com" /></label>
          <label class="field">商户ID（pid）<input v-model="settingsMap['epay_pid']" /></label>
          <label class="field">商户密钥（key）<input v-model="settingsMap['epay_key']" placeholder="********" /></label>
        </div>
        <div class="field" style="margin-top: 10px">
          <label style="display:inline-flex;align-items:center;gap:8px;">
            签名模式：
            <select v-model="settingsMap['epay_sign_mode']" style="padding:4px 8px;border-radius:6px;border:1px solid var(--line);">
              <option value="standard">标准（&amp;key=密钥，彩虹易支付默认）</option>
              <option value="direct">直接拼接密钥（payone.uk 等）</option>
            </select>
          </label>
        </div>
        <div class="field" style="margin-top: 10px">
          <span class="muted small">启用支付方式（可多选）：</span>
          <div class="pay-check">
            <label v-for="opt in PAY_TYPE_OPTIONS" :key="opt.key" class="checkbox">
              <input
                type="checkbox"
                :checked="payTypesList().includes(opt.key)"
                @change="(e: Event) => togglePayType(opt.key, (e.target as HTMLInputElement).checked)"
              />
              {{ opt.label }}
            </label>
          </div>
        </div>
        <p class="small muted">易支付 type 调用值：支付宝 alipay、微信 wxpay、USDT gmpay、Stripe 法币 fiatstripe、数字人民币 e-CNY ecny。未勾选的方式将不出现在用户支付页面。下单金额为套餐 USD 原价，微信/支付宝通道自带汇率换算。</p>
      </div>

      <div class="card">
        <h3 style="margin-top: 0">邮箱接入（OAuth 凭据）</h3>
        <div class="grid2">
          <label class="field">Google Client ID<input v-model="settingsMap['google_client_id']" placeholder="Gmail OAuth 客户端 ID" /></label>
          <label class="field">Google Client Secret<input v-model="settingsMap['google_client_secret']" placeholder="********" /></label>
          <label class="field">Microsoft Client ID<input v-model="settingsMap['microsoft_client_id']" placeholder="Outlook 应用 ID" /></label>
          <label class="field">Microsoft Client Secret<input v-model="settingsMap['microsoft_client_secret']" placeholder="********" /></label>
          <label class="field">Agently 桥接层 URL<input v-model="settingsMap['agently_bridge_url']" placeholder="https://your-bridge.example.com" /></label>
          <label class="field">Agently 桥接层 Token<input v-model="settingsMap['agently_bridge_token']" placeholder="********" /></label>
        </div>
        <p class="small muted">
          Gmail：Google Cloud Console 创建 Web 类型 OAuth 客户端，重定向 URI 填
          <code>{{ locationOrigin }}/api/accounts/oauth/gmail/callback</code>。Outlook：Azure 应用注册，重定向 URI 填
          <code>{{ locationOrigin }}/api/accounts/oauth/outlook/callback</code>，并添加 Mail.Read 权限。
          Agently：先在本机运行 bridge/ 桥接层（agently-cli + node bridge），再用 cloudflared/frp 暴露 HTTPS 后填 URL 与 Token。
          凭据写入数据库设置（管理员可见），开源部署无需修改环境变量。
        </p>
      </div>

      <div class="card">
        <h3 style="margin-top: 0">配额（免费 / 会员）</h3>
        <div class="grid2">
          <label class="field">免费账号数<input v-model="settingsMap['quota_free_accounts']" type="number" min="0" /></label>
          <label class="field">免费规则数<input v-model="settingsMap['quota_free_rules']" type="number" min="0" /></label>
          <label class="field">会员账号数<input v-model="settingsMap['quota_paid_accounts']" type="number" min="0" /></label>
          <label class="field">会员规则数<input v-model="settingsMap['quota_paid_rules']" type="number" min="0" /></label>
        </div>
      </div>

      <div class="row">
        <button class="primary" :disabled="saving" @click="saveSettings">{{ saving ? '保存中…' : '保存设置' }}</button>
        <span v-if="settingsMsg" class="small" :class="{ error: settingsMsg.includes('失败') }">{{ settingsMsg }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.admin-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.stat-card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
.stat-card .label { color: var(--muted); font-size: 12px; }
.stat-card .num { font-size: 24px; font-weight: 700; margin-top: 4px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
.field.full { grid-column: 1 / -1; }
.field.checkbox { flex-direction: row; align-items: center; gap: 6px; color: var(--text); }
.pay-check { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 6px; }
.pay-check .checkbox { display: inline-flex; align-items: center; gap: 6px; color: var(--text); }
</style>
