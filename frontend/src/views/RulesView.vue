<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { api, fmtTime } from '../api';
import type { Account, FieldDef, Rule, RuleTestSample } from '../types';

const PAGE_SIZE = 6;

const accounts = ref<Account[]>([]);
const rules = ref<Rule[]>([]);
const editing = ref<Rule | null>(null);
const showForm = ref(false);
const msg = ref('');
const testResult = ref<RuleTestSample[] | null>(null);
const testRuleName = ref('');
const searchQuery = ref('');
const currentPage = ref(1);

const emptyFields = (): FieldDef[] => [{ key: '', label: '', source: 'header', header: 'subject', pattern: '', required: false }];

/** 按创建时间倒序（最新添加的在前） */
const sortedRules = computed(() => [...rules.value].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)));

/** 搜索过滤：规则名、发件人匹配值、账号邮箱 */
const filteredRules = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return sortedRules.value;
  return sortedRules.value.filter((r) =>
    r.name.toLowerCase().includes(q) ||
    r.sender_pattern.toLowerCase().includes(q) ||
    (r.account_email ?? '').toLowerCase().includes(q) ||
    r.fields.some((f) => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q)),
  );
});

const totalPages = computed(() => Math.max(1, Math.ceil(filteredRules.value.length / PAGE_SIZE)));

const pagedRules = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE;
  return filteredRules.value.slice(start, start + PAGE_SIZE);
});

/** 页码列表（当前页前后各 1 页，省略号） */
const pageNumbers = computed(() => {
  const total = totalPages.value;
  const cur = currentPage.value;
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | '...')[] = [1];
  if (cur > 3) pages.push('...');
  for (let i = Math.max(2, cur - 1); i <= Math.min(total - 1, cur + 1); i++) pages.push(i);
  if (cur < total - 2) pages.push('...');
  pages.push(total);
  return pages;
});

function goToPage(p: number) {
  if (p < 1 || p > totalPages.value) return;
  currentPage.value = p;
}

function onSearch() {
  currentPage.value = 1;
}

const form = reactive({
  id: '' as string,
  account_id: '',
  name: '',
  sender_mode: 'exact' as 'exact' | 'domain' | 'regex',
  sender_pattern: '',
  schedule_mode: 'interval' as 'interval' | 'on_receive',
  interval_minutes: 60,
  dedupe: true,
  enabled: true,
  fields: emptyFields() as FieldDef[],
});

async function load() {
  const [a, r] = await Promise.all([
    api.get<{ accounts: Account[] }>('/accounts'),
    api.get<{ rules: Rule[] }>('/rules'),
  ]);
  accounts.value = a.accounts;
  rules.value = r.rules;
}

function openCreate() {
  Object.assign(form, {
    id: '', account_id: accounts.value[0]?.id ?? '', name: '', sender_mode: 'exact', sender_pattern: '',
    schedule_mode: 'interval', interval_minutes: 60, dedupe: true, enabled: true, fields: emptyFields(),
  });
  testResult.value = null;
  showForm.value = true;
}

function openEdit(r: Rule) {
  Object.assign(form, {
    id: r.id, account_id: r.account_id, name: r.name, sender_mode: r.sender_mode, sender_pattern: r.sender_pattern,
    schedule_mode: r.schedule_mode, interval_minutes: r.interval_minutes ?? 60, dedupe: !!r.dedupe, enabled: !!r.enabled,
    fields: r.fields.length ? JSON.parse(JSON.stringify(r.fields)) : emptyFields(),
  });
  testResult.value = null;
  showForm.value = true;
}

function addField() {
  form.fields.push({ key: '', label: '', source: 'header', header: 'subject', pattern: '', required: false });
}

function removeField(i: number) {
  form.fields.splice(i, 1);
  if (!form.fields.length) addField();
}

function moveFieldUp(i: number) {
  if (i <= 0) return;
  const tmp = form.fields[i];
  form.fields[i] = form.fields[i - 1];
  form.fields[i - 1] = tmp;
}

function moveFieldDown(i: number) {
  if (i >= form.fields.length - 1) return;
  const tmp = form.fields[i];
  form.fields[i] = form.fields[i + 1];
  form.fields[i + 1] = tmp;
}

async function save() {
  msg.value = '';
  const payload = {
    account_id: form.account_id,
    name: form.name,
    sender_mode: form.sender_mode,
    sender_pattern: form.sender_pattern,
    schedule_mode: form.schedule_mode,
    interval_minutes: form.schedule_mode === 'interval' ? form.interval_minutes : null,
    dedupe: form.dedupe,
    enabled: form.enabled,
    fields: form.fields.filter((f) => f.key && f.label),
  };
  try {
    if (form.id) await api.put(`/rules/${form.id}`, payload);
    else await api.post('/rules', payload);
    showForm.value = false;
    await load();
  } catch (e) {
    msg.value = e instanceof Error ? e.message : '保存失败';
  }
}

async function toggle(r: Rule) {
  await api.put(`/rules/${r.id}`, {
    account_id: r.account_id, name: r.name, sender_mode: r.sender_mode, sender_pattern: r.sender_pattern,
    schedule_mode: r.schedule_mode, interval_minutes: r.interval_minutes, dedupe: !!r.dedupe, enabled: !r.enabled,
    fields: r.fields,
  });
  await load();
}

async function remove(r: Rule) {
  if (!confirm(`确定删除规则「${r.name}」？该规则下 ${''}整理记录将一并删除。`)) return;
  await api.del(`/rules/${r.id}`);
  if (editing.value?.id === r.id) showForm.value = false;
  await load();
}

async function runTest(r: Rule) {
  testRuleName.value = r.name;
  testResult.value = null;
  try {
    const res = await api.post<{ samples: RuleTestSample[] }>(`/rules/${r.id}/test`);
    testResult.value = res.samples;
  } catch (e) {
    msg.value = e instanceof Error ? e.message : '测试失败';
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="row" style="justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
      <h3 style="margin: 8px 0">整理规则</h3>
      <div class="row" style="gap: 8px; align-items: center;">
        <input
          v-model="searchQuery"
          @input="onSearch"
          placeholder="搜索规则名 / 发件人 / 字段…"
          style="padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line); font-size: 13px; width: 200px;"
        />
        <button class="primary" @click="openCreate">+ 新建规则</button>
      </div>
    </div>
    <p v-if="msg" class="error small">{{ msg }}</p>

    <table>
      <thead>
        <tr>
          <th>规则</th><th>账号</th><th>发件人匹配</th><th>调度</th><th>字段</th><th>状态</th><th>上次运行</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in pagedRules" :key="r.id">
          <td>{{ r.name }}</td>
          <td class="small">{{ r.account_email ?? r.account_id }}</td>
          <td class="small">
            <span class="tag gray">{{ r.sender_mode }}</span> {{ r.sender_pattern }}
          </td>
          <td class="small">
            <template v-if="r.schedule_mode === 'interval'">{{ r.interval_minutes }} 分钟一次</template>
            <template v-else><span class="tag green">收到即整理</span></template>
          </td>
          <td class="small">{{ r.fields.map((f) => f.label).join('、') || '—' }}</td>
          <td><span class="tag" :class="r.enabled ? 'green' : 'gray'">{{ r.enabled ? '启用' : '停用' }}</span></td>
          <td class="small">{{ r.last_run_at ? fmtTime(r.last_run_at * 1000) : '—' }}</td>
          <td>
            <div class="row">
              <button class="secondary" @click="openEdit(r)">编辑</button>
              <button class="secondary" @click="runTest(r)">试跑</button>
              <button class="secondary" @click="toggle(r)">{{ r.enabled ? '停用' : '启用' }}</button>
              <button class="danger" @click="remove(r)">删除</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!filteredRules.length" class="empty">
      {{ searchQuery ? '没有匹配的规则' : '还没有规则。新建一条规则，指定发件人、提取字段与整理周期。' }}
    </div>

    <!-- 分页 -->
    <div v-if="filteredRules.length > PAGE_SIZE" class="row" style="justify-content: center; align-items: center; gap: 6px; margin-top: 16px;">
      <button
        class="secondary"
        :disabled="currentPage === 1"
        @click="goToPage(currentPage - 1)"
        style="padding: 6px 12px; font-size: 13px;"
      >上一页</button>
      <template v-for="(p, i) in pageNumbers" :key="i">
        <span v-if="p === '...'" style="padding: 0 4px; color: var(--muted);">…</span>
        <button
          v-else
          :class="['secondary']"
          @click="goToPage(p)"
          :style="p === currentPage ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : {}"
          style="padding: 6px 10px; font-size: 13px; min-width: 32px;"
        >{{ p }}</button>
      </template>
      <button
        class="secondary"
        :disabled="currentPage === totalPages"
        @click="goToPage(currentPage + 1)"
        style="padding: 6px 12px; font-size: 13px;"
      >下一页</button>
      <span class="small muted" style="margin-left: 8px;">共 {{ filteredRules.length }} 条</span>
    </div>

    <div v-if="testResult" class="card">
      <h4 style="margin-top: 0">试跑结果：{{ testRuleName }}</h4>
      <table>
        <thead>
          <tr><th>时间</th><th>发件人</th><th>主题</th><th>提取字段</th></tr>
        </thead>
        <tbody>
          <tr v-for="(s, i) in testResult" :key="i">
            <td class="small">{{ fmtTime(s.receivedAt) }}</td>
            <td class="small">{{ s.sender }}</td>
            <td class="small">{{ s.subject }}</td>
            <td class="small">
              <div v-for="(v, k) in s.extracted" :key="k"><b>{{ k }}</b>: {{ v ?? '—' }}</div>
              <div v-if="!Object.keys(s.extracted).length" class="muted">无字段</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showForm" class="modal-mask" @click.self="showForm = false">
      <div class="modal">
        <h3 style="margin-top: 0">{{ form.id ? '编辑规则' : '新建规则' }}</h3>

        <div class="grid2">
          <label>规则名称<input v-model="form.name" placeholder="如：发票整理" /></label>
          <label>邮箱账号
            <select v-model="form.account_id">
              <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.email }}</option>
            </select>
          </label>
        </div>

        <div class="grid2">
          <label>发件人匹配方式
            <select v-model="form.sender_mode">
              <option value="exact">精确地址</option>
              <option value="domain">域名（含子域）</option>
              <option value="regex">正则</option>
            </select>
          </label>
          <label>发件人匹配值<input v-model="form.sender_pattern" placeholder="invoice@alipay.com 或 example.com" /></label>
        </div>

        <div class="grid2">
          <label>整理调度
            <select v-model="form.schedule_mode">
              <option value="interval">按间隔周期</option>
              <option value="on_receive">收到即整理</option>
            </select>
          </label>
          <label v-if="form.schedule_mode === 'interval'">
            间隔分钟数
            <input v-model.number="form.interval_minutes" type="number" min="1" />
          </label>
        </div>

        <div class="row" style="margin: 8px 0">
          <label class="small"><input v-model="form.dedupe" type="checkbox" /> 去重（同邮件只入一次）</label>
          <label class="small"><input v-model="form.enabled" type="checkbox" /> 启用</label>
        </div>

        <h4>提取字段</h4>
        <table>
          <thead>
            <tr><th>字段名(label)</th><th>key</th><th>来源</th><th>取值/正则</th><th>必填</th><th>排序</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="(f, i) in form.fields" :key="i">
              <td><input v-model="f.label" placeholder="如：订单号" style="width: 110px" /></td>
              <td><input v-model="f.key" placeholder="order_no" style="width: 110px" /></td>
              <td>
                <select v-model="f.source" style="width: 120px">
                  <option value="header">邮件头</option>
                  <option value="body_regex">正文正则</option>
                  <option value="llm">LLM 提取</option>
                </select>
              </td>
              <td>
                <select v-if="f.source === 'header'" v-model="f.header" style="width: 130px">
                  <option value="from">发件人</option>
                  <option value="from_name">发件人名称</option>
                  <option value="subject">主题</option>
                  <option value="date">收件时间</option>
                  <option value="message_id">消息ID</option>
                </select>
                <input v-else-if="f.source === 'body_regex'" v-model="f.pattern" placeholder="(?&lt;order_no&gt;[\w-]+)" style="width: 240px" />
                <span v-else class="small muted">AI 根据字段名理解邮件全文提取，无需正则</span>
              </td>
              <td><input v-model="f.required" type="checkbox" /></td>
              <td>
                <div class="row" style="gap: 2px;">
                  <button
                    class="secondary"
                    :disabled="i === 0"
                    @click="moveFieldUp(i)"
                    title="上移"
                    style="padding: 2px 6px; font-size: 12px; min-width: 28px;"
                  >↑</button>
                  <button
                    class="secondary"
                    :disabled="i === form.fields.length - 1"
                    @click="moveFieldDown(i)"
                    title="下移"
                    style="padding: 2px 6px; font-size: 12px; min-width: 28px;"
                  >↓</button>
                </div>
              </td>
              <td><button class="danger" @click="removeField(i)">删</button></td>
            </tr>
          </tbody>
        </table>
        <button class="secondary" @click="addField">+ 添加字段</button>

        <div class="row" style="margin-top: 16px; justify-content: flex-end">
          <button class="secondary" @click="showForm = false">取消</button>
          <button class="primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>
