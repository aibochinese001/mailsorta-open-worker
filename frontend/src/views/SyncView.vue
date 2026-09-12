<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, fmtTime } from '../api';
import type { SyncLog } from '../types';

const logs = ref<SyncLog[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 15;
const running = ref(false);
const msg = ref('');
const lastOutcomes = ref<{ ruleId: string; inserted: number; fetched: number; error?: string }[] | null>(null);

async function load() {
  const data = await api.get<{ logs: SyncLog[]; total: number }>(
    `/sync/logs?page=${page.value}&page_size=${pageSize}`,
  );
  logs.value = data.logs;
  total.value = data.total;
}

async function run() {
  running.value = true;
  msg.value = '';
  lastOutcomes.value = null;
  try {
    const res = await api.post<{ outcomes: { ruleId: string; inserted: number; fetched: number; error?: string }[] }>('/sync/run');
    lastOutcomes.value = res.outcomes;
  } catch (e) {
    msg.value = e instanceof Error ? e.message : '触发失败';
  } finally {
    running.value = false;
    page.value = 1;
    await load();
  }
}

const totalPages = () => Math.max(1, Math.ceil(total.value / pageSize));

function go(p: number) {
  if (p < 1 || p > totalPages()) return;
  page.value = p;
  load();
}

/** 可点击页码窗口：当前页前后各 2 页，最多 5 个 */
const pageItems = () => {
  const tp = totalPages();
  const start = Math.max(1, Math.min(page.value - 2, tp - 4));
  const end = Math.min(tp, start + 4);
  const items: (number | '...')[] = [];
  if (start > 1) items.push(1, '...');
  for (let i = start; i <= end; i++) items.push(i);
  if (end < tp) items.push('...', tp);
  return items;
};

const TRIGGER_LABEL: Record<string, string> = { cron: '定时', webhook: '推送', manual: '手动' };

onMounted(load);
</script>

<template>
  <div>
    <div class="card">
      <div class="row">
        <button class="primary" :disabled="running" @click="run">{{ running ? '整理中…' : '立即整理（所有到期规则）' }}</button>
        <span class="muted small">Cron 每分钟自动触发；也可由 QQ IMAP/Agently Webhook 实时触发。</span>
      </div>
      <p v-if="msg" class="error small">{{ msg }}</p>
      <div v-if="lastOutcomes" class="small" style="margin-top: 8px">
        <div v-for="o in lastOutcomes" :key="o.ruleId">
          <span class="tag gray">{{ o.ruleId }}</span>
          拉取 {{ o.fetched }} · 入库 {{ o.inserted }}
          <span v-if="o.error" class="error">（{{ o.error }}）</span>
        </div>
      </div>
    </div>

    <table>
      <thead>
        <tr><th>时间</th><th>触发</th><th>账号</th><th>规则</th><th>拉取</th><th>入库</th><th>跳过</th><th>错误</th></tr>
      </thead>
      <tbody>
        <tr v-for="l in logs" :key="l.id">
          <td class="small" style="white-space: nowrap">{{ fmtTime(l.run_at) }}</td>
          <td><span class="tag gray">{{ TRIGGER_LABEL[l.trigger] ?? l.trigger }}</span></td>
          <td class="small">{{ l.account_id.slice(0, 10) }}</td>
          <td class="small">{{ l.rule_id?.slice(0, 10) ?? '—' }}</td>
          <td class="small">{{ l.fetched }}</td>
          <td class="small">{{ l.inserted }}</td>
          <td class="small">{{ l.skipped }}</td>
          <td class="small error">{{ l.error ?? '' }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="!logs.length && !running" class="empty">暂无同步记录</div>

    <div v-if="total > pageSize" class="pager">
      <button class="secondary" :disabled="page <= 1" @click="go(page - 1)">上一页</button>
      <template v-for="(p, i) in pageItems()" :key="i">
        <button v-if="p === '...'" class="link small muted" disabled style="cursor: default">…</button>
        <button v-else class="secondary" :class="{ active: p === page }" @click="go(p)">{{ p }}</button>
      </template>
      <button class="secondary" :disabled="page >= totalPages()" @click="go(page + 1)">下一页</button>
      <span class="small muted">共 {{ total }} 条 · 第 {{ page }} / {{ totalPages() }} 页</span>
    </div>
  </div>
</template>
