<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { api, fmtTime } from '../api';
import type { CheckoutResponse, MemberInfo, Order, Plan, PlansResponse, Quota } from '../types';
import { MEMBER_LEVEL_LABEL, ORDER_STATUS_LABEL, PLAN_PERIOD_LABEL } from '../types';

const props = defineProps<{ member: MemberInfo | null; quota: Quota | null }>();
const emit = defineEmits<{ (e: 'member-changed'): void }>();

const plans = ref<Plan[]>([]);
const payTypes = ref<{ key: string; label: string }[]>([]);
const currency = ref('USD');

/** 支付方式品牌元数据：官方品牌色 + 内联 SVG 图标 */
const PAY_META: Record<string, { color: string; bg: string; svg: string }> = {
  alipay: {
    color: '#1677FF',
    bg: 'rgba(22,119,255,0.08)',
    svg: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><rect width="24" height="24" rx="5" fill="#1677FF"/><path d="M7 7.5h10M7 7.5v9a1.5 1.5 0 001.5 1.5h7a1.5 1.5 0 001.5-1.5v-9" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><text x="12" y="16.5" text-anchor="middle" fill="#fff" font-size="9" font-weight="700" font-family="Arial">支</text></svg>`,
  },
  wxpay: {
    color: '#07C160',
    bg: 'rgba(7,193,96,0.08)',
    svg: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><rect width="24" height="24" rx="5" fill="#07C160"/><path d="M9.5 8C6.46 8 4 9.79 4 12c0 1.25.68 2.37 1.75 3.12L5 17l2.1-1.05c.74.2 1.53.3 2.4.3.2 0 .4-.01.6-.02-.13-.4-.2-.82-.2-1.23 0-2.2 2.46-4 5.5-4 .2 0 .4.01.6.03C15.5 8.86 12.78 8 9.5 8z" fill="#fff"/><path d="M15.5 12.5c-2.76 0-5 1.34-5 3s2.24 3 5 3c.62 0 1.22-.08 1.78-.23L19 19l-.5-1.38c.92-.6 1.5-1.52 1.5-2.62 0-1.66-2.24-3-4.5-3z" fill="#fff"/><circle cx="7.5" cy="11.5" r=".7" fill="#07C160"/><circle cx="11.5" cy="11.5" r=".7" fill="#07C160"/></svg>`,
  },
  gmpay: {
    color: '#26A17B',
    bg: 'rgba(38,161,123,0.08)',
    svg: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><rect width="24" height="24" rx="5" fill="#26A17B"/><path d="M12 4l5.5 2.5v5c0 3.5-2.3 6.5-5.5 8-3.2-1.5-5.5-4.5-5.5-8v-5L12 4z" fill="#fff"/><path d="M9.5 9.5h5M9.5 12h5M9.5 14.5h3.5" stroke="#26A17B" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  },
  fiatstripe: {
    color: '#635BFF',
    bg: 'rgba(99,91,255,0.08)',
    svg: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><rect width="24" height="24" rx="5" fill="#635BFF"/><path d="M7 8.5h10M7 12h10M7 15.5h6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="17.5" cy="15.5" r="1.2" fill="#fff"/></svg>`,
  },
  ecny: {
    color: '#E60012',
    bg: 'rgba(230,0,18,0.08)',
    svg: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><rect width="24" height="24" rx="5" fill="#E60012"/><text x="12" y="14.6" text-anchor="middle" fill="#fff" font-size="8" font-weight="700" font-family="Arial, sans-serif">e-CNY</text></svg>`,
  },
};
const orders = ref<Order[]>([]);
const visibleOrderCount = ref(5);
const selectedPlan = ref('');
const selectedPay = ref('');
const msg = ref('');
const paying = ref(false);
const pollTimer = ref<number | null>(null);

async function loadPlans() {
  const res = await api.get<PlansResponse>('/billing/plans');
  plans.value = res.plans;
  currency.value = res.currency || 'USD';
  payTypes.value = res.pay_types;
  if (!selectedPlan.value && plans.value.length) selectedPlan.value = plans.value[0].id;
  if (!selectedPay.value && payTypes.value.length) selectedPay.value = payTypes.value[0].key;
}

async function loadOrders() {
  const res = await api.get<{ orders: Order[] }>('/billing/orders');
  orders.value = res.orders;
  visibleOrderCount.value = 5;
}

async function checkout() {
  msg.value = '';
  if (!selectedPlan.value || !selectedPay.value) {
    msg.value = '请选择套餐与支付方式';
    return;
  }
  paying.value = true;
  try {
    const res = await api.post<CheckoutResponse>('/billing/checkout', {
      plan_id: selectedPlan.value,
      pay_type: selectedPay.value,
    });
    // 打开易支付收银台
    window.open(res.payUrl, '_blank', 'noopener');
    msg.value = '请在打开的支付页面完成付款；支付完成后本页会自动更新。';
    pollOrder(res.order.id);
  } catch (e) {
    msg.value = e instanceof Error ? e.message : '下单失败';
  } finally {
    paying.value = false;
  }
}

async function pollOrder(orderId: string) {
  if (pollTimer.value) window.clearInterval(pollTimer.value);
  let tries = 0;
  const tick = async () => {
    tries += 1;
    try {
      const res = await api.get<{ order: Order }>(`/billing/orders/${orderId}`);
      if (res.order.status === 'paid') {
        if (pollTimer.value) window.clearInterval(pollTimer.value);
        pollTimer.value = null;
        msg.value = '支付成功，会员已生效';
        emit('member-changed');
        await loadOrders();
        return;
      }
      if (res.order.status === 'expired') {
        if (pollTimer.value) window.clearInterval(pollTimer.value);
        pollTimer.value = null;
        msg.value = '订单已过期，请重新下单';
        await loadOrders();
        return;
      }
    } catch {
      /* 忽略瞬时错误 */
    }
    if (tries >= 40) {
      if (pollTimer.value) window.clearInterval(pollTimer.value);
      pollTimer.value = null;
      return;
    }
    pollTimer.value = window.setTimeout(tick, 3000);
  };
  tick();
}

function memberExpiryText(): string {
  const m = props.member;
  if (!m) return '';
  if (m.level === 'lifetime') return '永久有效';
  if (m.level === 'free') return '已到期或未开通';
  return m.expires_at ? `至 ${fmtTime(m.expires_at)}` : '';
}

onMounted(async () => {
  await loadPlans();
  await loadOrders();
  // 支付回调返回时，URL 带 ?pay=out_trade_no，自动轮询确认订单
  try {
    const hash = window.location.hash;
    const qIdx = hash.indexOf('?');
    if (qIdx >= 0) {
      const qs = new URLSearchParams(hash.substring(qIdx + 1));
      const payOutTradeNo = qs.get('pay');
      if (payOutTradeNo) {
        const order = orders.value.find((o) => o.out_trade_no === payOutTradeNo);
        if (order && order.status === 'pending') {
          msg.value = '正在确认支付结果，请稍候…';
          pollOrder(order.id);
        } else if (order?.status === 'paid') {
          msg.value = '支付成功，会员已生效';
          emit('member-changed');
        }
        // 清理 URL 参数
        const cleanHash = hash.substring(0, qIdx);
        if (cleanHash) window.history.replaceState(null, '', cleanHash);
      }
    }
  } catch { /* 忽略 URL 解析错误 */ }
});
onUnmounted(() => {
  if (pollTimer.value) window.clearInterval(pollTimer.value);
});
</script>

<template>
  <div>
    <div class="card">
      <h3 style="margin-top: 0">我的会员</h3>
      <div class="row">
        <span class="tag" :class="member?.level === 'free' ? 'gray' : 'green'">{{ MEMBER_LEVEL_LABEL[member?.level ?? 'free'] }}</span>
        <span class="muted small">{{ memberExpiryText() }}</span>
        <span v-if="quota" class="muted small">
          配额：账号 {{ quota.accounts }} 个 · 规则 {{ quota.rules }} 条
        </span>
      </div>
      <p class="small muted" style="margin-bottom: 0">
        新注册用户默认 7 天免费试用，试用期与会员享相同配额。续费按当前到期日顺延，永久会员一次开通、长期有效。
      </p>
    </div>

    <div class="plans">
      <div v-for="p in plans" :key="p.id" class="plan-card" :class="{ selected: selectedPlan === p.id }" @click="selectedPlan = p.id">
        <div class="plan-name">{{ p.name }}</div>
        <div class="plan-price">
          ${{ p.price_usd }}
          <span class="small muted">{{ currency }}</span>
        </div>
        <div class="small muted">{{ PLAN_PERIOD_LABEL[p.period_type] }}<template v-if="p.duration_months">（{{ p.duration_months }} 个月）</template></div>
        <div v-if="p.description" class="small muted">{{ p.description }}</div>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top: 0">支付方式</h3>
      <div class="pay-types">
        <label v-for="pt in payTypes" :key="pt.key" class="pay-option" :class="{ selected: selectedPay === pt.key }" :style="{ '--pay-color': PAY_META[pt.key]?.color ?? '#888', '--pay-bg': PAY_META[pt.key]?.bg ?? '#f5f5f5' }">
          <input v-model="selectedPay" type="radio" :value="pt.key" />
          <span class="pay-icon" v-html="PAY_META[pt.key]?.svg ?? ''"></span>
          <span class="pay-label">{{ pt.label }}</span>
          <span class="pay-check" v-if="selectedPay === pt.key">✓</span>
        </label>
      </div>
      <div class="row" style="margin-top: 12px">
        <button class="primary" :disabled="paying || !plans.length" @click="checkout">
          {{ paying ? '下单中…' : '立即购买' }}
        </button>
        <span class="muted small">美元计价，易支付通道直接收款（微信/支付宝自带汇率换算）；支付方式以管理员后台开启为准</span>
      </div>
      <p v-if="msg" class="small" :class="{ error: msg.includes('失败') || msg.includes('过期') }">{{ msg }}</p>
    </div>

    <h3 style="margin: 20px 0 8px">我的订单</h3>
    <table v-if="orders.length">
      <thead>
        <tr><th>订单号</th><th>套餐</th><th>金额</th><th>支付方式</th><th>状态</th><th>下单时间</th></tr>
      </thead>
      <tbody>
        <tr v-for="o in orders.slice(0, visibleOrderCount)" :key="o.id">
          <td class="small muted">{{ o.out_trade_no }}</td>
          <td>{{ o.plan_name }}</td>
          <td>${{ o.price_usd }}</td>
          <td>{{ o.pay_type }}</td>
          <td><span class="tag" :class="o.status === 'paid' ? 'green' : o.status === 'pending' ? 'orange' : 'gray'">{{ ORDER_STATUS_LABEL[o.status] }}</span></td>
          <td class="small muted">{{ fmtTime(o.created_at) }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="!orders.length" class="empty">暂无订单</div>
    <div v-if="orders.length > visibleOrderCount" style="text-align:center;margin-top:12px;">
      <button class="primary" style="padding:6px 20px;font-size:13px;" @click="visibleOrderCount += 5">查看更多（共 {{ orders.length }} 条）</button>
    </div>
  </div>
</template>

<style scoped>
.plans { display: flex; flex-wrap: wrap; gap: 12px; margin: 14px 0; }
.plan-card { flex: 1 1 180px; min-width: 0; border: 1px solid var(--line); border-radius: 12px; padding: 14px; cursor: pointer; background: var(--card); }
.plan-card.selected { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(47, 111, 159, 0.2); }
.plan-name { font-weight: 600; }
.plan-price { font-size: 22px; font-weight: 700; margin: 6px 0; }
.pay-types { display: flex; flex-wrap: wrap; gap: 10px; }
.pay-option {
  position: relative;
  display: inline-flex; align-items: center; gap: 8px;
  border: 2px solid var(--line); border-radius: 10px;
  padding: 10px 16px 10px 12px; background: #fff; cursor: pointer;
  font-size: 13.5px; font-weight: 500; color: #333;
  transition: all 0.15s ease;
}
.pay-option input[type="radio"] { display: none; }
.pay-option:hover { border-color: var(--pay-color); background: var(--pay-bg); }
.pay-option.selected {
  border-color: var(--pay-color);
  background: var(--pay-bg);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--pay-color) 18%, transparent);
  color: var(--pay-color);
}
.pay-icon { display: inline-flex; align-items: center; line-height: 0; }
.pay-label { white-space: nowrap; }
.pay-check {
  position: absolute; top: -6px; right: -6px;
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--pay-color); color: #fff;
  font-size: 11px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
</style>
