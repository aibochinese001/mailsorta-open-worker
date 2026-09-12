<script setup lang="ts">
import { reactive, ref, onMounted, watch } from 'vue';
import { api, fmtTime } from '../api';
import type { Account, EmailItem, Rule } from '../types';

const accounts = ref<Account[]>([]);
const rules = ref<Rule[]>([]);
const items = ref<EmailItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const loading = ref(false);
const msg = ref('');
const expanded = ref<string | null>(null);
const reExtracting = ref<string | null>(null);

const filters = reactive({
  rule_id: '',
  account_id: '',
  sender: '',
  subject: '',
  q: '',
  date_from: '',
  date_to: '',
});

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page.value), page_size: String(pageSize) });
    if (filters.rule_id) params.set('rule_id', filters.rule_id);
    if (filters.account_id) params.set('account_id', filters.account_id);
    if (filters.sender) params.set('sender', filters.sender);
    if (filters.subject) params.set('subject', filters.subject);
    if (filters.q) params.set('q', filters.q);
    if (filters.date_from) params.set('date_from', String(new Date(filters.date_from).getTime()));
    if (filters.date_to) params.set('date_to', String(new Date(filters.date_to + 'T23:59:59').getTime()));
    const data = await api.get<{ items: EmailItem[]; total: number }>(`/emails?${params}`);
    items.value = data.items;
    total.value = data.total;
  } catch (e) {
    msg.value = e instanceof Error ? e.message : '查询失败';
  } finally {
    loading.value = false;
  }
}

function resetPage() {
  page.value = 1;
  load();
}

watch(filters, () => resetPage());

async function download(fmt: 'xlsx' | 'csv') {
  msg.value = '';
  const params = new URLSearchParams();
  if (filters.rule_id) params.set('rule_id', filters.rule_id);
  if (filters.account_id) params.set('account_id', filters.account_id);
  if (filters.sender) params.set('sender', filters.sender);
  if (filters.subject) params.set('subject', filters.subject);
  if (filters.q) params.set('q', filters.q);
  if (filters.date_from) params.set('date_from', String(new Date(filters.date_from).getTime()));
  if (filters.date_to) params.set('date_to', String(new Date(filters.date_to + 'T23:59:59').getTime()));

  try {
    const res = await fetch(`/api/export/${fmt}?${params}`);
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(j?.error ?? '导出失败');
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) {
      const j = (await res.json()) as { downloadUrl?: string };
      msg.value = `数据量较大，已生成导出任务：${j.downloadUrl ?? ''}（在浏览器新开标签页下载）`;
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mailsorta.${fmt}`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    msg.value = e instanceof Error ? e.message : '导出失败';
  }
}

const totalPages = () => Math.max(1, Math.ceil(total.value / pageSize));

async function reExtract(e: EmailItem) {
  reExtracting.value = e.id;
  msg.value = '';
  try {
    const r = await api.post<{ extracted: Record<string, string | null>; llm_error?: string | null }>(
      `/emails/${e.id}/re-extract`,
    );
    e.extracted = r.extracted;
    e.llm_error = r.llm_error ?? null;
    msg.value = '重新提取完成';
  } catch (err) {
    msg.value = err instanceof Error ? err.message : '重新提取失败';
  } finally {
    reExtracting.value = null;
  }
}

onMounted(async () => {
  const [a, r] = await Promise.all([
    api.get<{ accounts: Account[] }>('/accounts'),
    api.get<{ rules: Rule[] }>('/rules'),
  ]);
  accounts.value = a.accounts;
  rules.value = r.rules;
  await load();
});
</script>

<template>
  <div>
    <div class="card">
      <div class="grid2">
        <label>规则
          <select v-model="filters.rule_id">
            <option value="">全部规则</option>
            <option v-for="r in rules" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
        </label>
        <label>账号
          <select v-model="filters.account_id">
            <option value="">全部账号</option>
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.email }}</option>
          </select>
        </label>
        <label>发件人包含<input v-model="filters.sender" placeholder="关键词" /></label>
        <label>主题包含<input v-model="filters.subject" placeholder="关键词" /></label>
        <label>提取内容包含<input v-model="filters.q" placeholder="如 FORTUNE OCEAN（匹配船东/船名等提取字段值）" /></label>
        <label>起始日期<input v-model="filters.date_from" type="date" /></label>
        <label>结束日期<input v-model="filters.date_to" type="date" /></label>
      </div>
      <div class="row" style="margin-top: 12px">
        <button class="primary" @click="resetPage">查询</button>
        <button class="secondary" @click="download('xlsx')">导出 Excel</button>
        <button class="secondary" @click="download('csv')">导出 CSV</button>
        <span class="muted small">共 {{ total }} 条</span>
      </div>
      <p v-if="msg" class="small" :class="{ error: msg.includes('失败') }">{{ msg }}</p>
    </div>

    <table>
      <thead>
        <tr><th>收件时间</th><th>规则</th><th>发件人</th><th>主题</th><th>提取结果</th></tr>
      </thead>
      <tbody>
        <template v-for="e in items" :key="e.id">
          <tr @click="expanded = expanded === e.id ? null : e.id" style="cursor: pointer">
            <td class="small" style="white-space: nowrap">{{ fmtTime(e.received_at) }}</td>
            <td><span class="tag gray">{{ e.rule_name ?? '—' }}</span></td>
            <td class="small">{{ e.sender_name ? `${e.sender_name} <${e.sender}>` : e.sender }}</td>
            <td class="small">{{ e.subject }}</td>
            <td class="small muted">{{ Object.values(e.extracted).filter((v) => v != null).length }} 个字段</td>
          </tr>
          <tr v-if="expanded === e.id">
            <td colspan="5">
              <div class="grid2">
                <div v-if="e.llm_error" class="small error" style="grid-column: 1 / -1; margin-bottom: 6px">{{ e.llm_error }}</div>
                <div v-for="f in e.fields" :key="f.key" class="small">
                  <b>{{ f.label }}</b>：{{ e.extracted[f.key] ?? '—' }}
                </div>
              </div>
              <div class="row" style="margin-top: 8px">
                <button class="secondary small" :disabled="reExtracting === e.id" @click="reExtract(e)">
                  {{ reExtracting === e.id ? '提取中…' : '重新提取' }}
                </button>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <div v-if="!items.length && !loading" class="empty">没有匹配的邮件记录</div>

    <div class="pager">
      <button class="secondary" :disabled="page <= 1" @click="page--; load()">上一页</button>
      <span class="small muted">第 {{ page }} / {{ totalPages() }} 页</span>
      <button class="secondary" :disabled="page >= totalPages()" @click="page++; load()">下一页</button>
    </div>
  </div>
</template>
