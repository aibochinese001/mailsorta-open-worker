<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from './api';
import type { MemberInfo, MeResponse, PublicSettings, Quota, User } from './types';
import { MEMBER_LEVEL_LABEL } from './types';
import AccountsView from './views/AccountsView.vue';
import RulesView from './views/RulesView.vue';
import EmailsView from './views/EmailsView.vue';
import SyncView from './views/SyncView.vue';
import PlansView from './views/PlansView.vue';
import AdminView from './views/AdminView.vue';

const tabs = [
  { key: 'accounts', label: '邮箱账号' },
  { key: 'rules', label: '整理规则' },
  { key: 'emails', label: '邮件查询' },
  { key: 'sync', label: '同步日志' },
  { key: 'billing', label: '套餐与订单' },
  { key: 'admin', label: '管理后台', adminOnly: true },
];

const authed = ref<null | boolean>(null);
const me = ref<MeResponse | null>(null);
const settings = ref<PublicSettings | null>(null);
const banner = ref('');
const bannerType = ref<'info' | 'error'>('info');

// ---------------- 账户设置（昵称 / 密码 / AI 提取模型） ----------------
const accountModal = ref(false);
const accDisplayName = ref('');
const accMsg = ref('');
const pwOld = ref('');
const pwNew = ref('');
const pwNew2 = ref('');
const pwMsg = ref('');
const accBusy = ref(false);
const llmUrl = ref('');
const llmModel = ref('');
const llmKey = ref('');
const llmKeySet = ref(false);

// ---------------- 认证表单 ----------------
type AuthMode = 'login' | 'register' | 'forgot';
const authMode = ref<AuthMode>('login');
const formEmail = ref('');
const formPassword = ref('');
const formPassword2 = ref('');
const formDisplayName = ref('');
const formCode = ref('');
const authMsg = ref('');
const devCodeHint = ref('');
const authBusy = ref(false);

const member = computed<MemberInfo | null>(() => me.value?.member ?? null);
const quota = computed<Quota | null>(() => me.value?.quota ?? null);
const user = computed<User | null>(() => me.value?.user ?? null);

function currentTab(): string {
  const h = location.hash.replace(/^#\/?/, '').split('?')[0];
  return tabs.some((t) => t.key === h) ? h : 'accounts';
}
const tab = ref(currentTab());

function setTab(key: string) {
  tab.value = key;
  location.hash = `#/${key}`;
}

function showBanner(msg: string, type: 'info' | 'error' = 'info') {
  banner.value = msg;
  bannerType.value = type;
  setTimeout(() => (banner.value = ''), 6000);
}

async function refreshMe() {
  try {
    me.value = await api.get<MeResponse>('/auth/me');
    authed.value = me.value?.authed ?? false;
  } catch {
    authed.value = false;
  }
}

async function loadPublicSettings() {
  try {
    settings.value = await api.get<PublicSettings>('/settings/public');
  } catch {
    settings.value = null;
  }
}

async function sendCode(purpose: 'register' | 'reset') {
  authMsg.value = '';
  devCodeHint.value = '';
  if (!formEmail.value || !formEmail.value.includes('@')) {
    authMsg.value = '请先填写正确的邮箱';
    return;
  }
  authBusy.value = true;
  try {
    const res = await api.post<{ ok: boolean; devCode?: string; smtp: boolean }>('/auth/send-code', {
      email: formEmail.value,
      purpose,
    });
    if (!res.smtp && res.devCode) {
      devCodeHint.value = `SMTP 未配置（本地开发）：验证码 ${res.devCode}，请在下方直接输入。`;
    } else {
      showBanner('验证码已发送，请查收邮件');
    }
  } catch (e) {
    authMsg.value = e instanceof Error ? e.message : '发送失败';
  } finally {
    authBusy.value = false;
  }
}

async function doAuth() {
  authMsg.value = '';
  devCodeHint.value = '';
  if (authMode.value === 'register') {
    if (formPassword.value.length < 8) {
      authMsg.value = '密码至少 8 位';
      return;
    }
    if (formPassword.value !== formPassword2.value) {
      authMsg.value = '两次输入的密码不一致';
      return;
    }
    if (!formCode.value) {
      authMsg.value = '请先获取并填写验证码';
      return;
    }
  }
  if (authMode.value === 'forgot') {
    if (formPassword.value.length < 8) {
      authMsg.value = '密码至少 8 位';
      return;
    }
    if (formPassword.value !== formPassword2.value) {
      authMsg.value = '两次输入的密码不一致';
      return;
    }
    if (!formCode.value) {
      authMsg.value = '请先获取并填写验证码';
      return;
    }
  }
  authBusy.value = true;
  try {
    if (authMode.value === 'login') {
      await api.post('/auth/login', { email: formEmail.value, password: formPassword.value });
    } else if (authMode.value === 'register') {
      const res = await api.post<{ isAdmin?: boolean; trialDays?: number }>('/auth/register', {
        email: formEmail.value,
        password: formPassword.value,
        code: formCode.value,
        display_name: formDisplayName.value || undefined,
      });
      if (res.isAdmin) showBanner('该邮箱为管理员白名单，已授予管理员权限。新用户默认 7 天免费试用。');
      else showBanner('注册成功，默认 7 天免费试用，试用结束后可购买会员。');
    } else {
      await api.post('/auth/reset', { email: formEmail.value, code: formCode.value, password: formPassword.value });
      showBanner('密码已重置，请使用新密码登录');
      authMode.value = 'login';
    }
    formPassword.value = '';
    formPassword2.value = '';
    formCode.value = '';
    await refreshMe();
  } catch (e) {
    authMsg.value = e instanceof Error ? e.message : '操作失败';
  } finally {
    authBusy.value = false;
  }
}

async function doLogout() {
  await api.post('/auth/logout').catch(() => undefined);
  authed.value = false;
  me.value = null;
}

// ---------------- 账户设置 ----------------
function openAccountModal() {
  accDisplayName.value = user.value?.display_name ?? '';
  accMsg.value = '';
  pwMsg.value = '';
  pwOld.value = '';
  pwNew.value = '';
  pwNew2.value = '';
  llmUrl.value = user.value?.llm_api_url ?? '';
  llmModel.value = user.value?.llm_model ?? '';
  llmKey.value = '';
  llmKeySet.value = !!user.value?.llm_key_configured;
  accountModal.value = true;
}

async function saveProfile() {
  accMsg.value = '';
  accBusy.value = true;
  try {
    await api.patch('/auth/profile', {
      display_name: accDisplayName.value,
      llm_api_url: llmUrl.value,
      llm_model: llmModel.value,
      llm_api_key: llmKey.value || (llmKeySet.value ? '********' : ''),
    });
    accMsg.value = '已保存';
    await refreshMe();
    llmKey.value = '';
    llmKeySet.value = !!user.value?.llm_key_configured;
  } catch (e) {
    accMsg.value = e instanceof Error ? e.message : '保存失败';
  } finally {
    accBusy.value = false;
  }
}

async function savePassword() {
  pwMsg.value = '';
  if (pwNew.value.length < 8) {
    pwMsg.value = '新密码至少 8 位';
    return;
  }
  if (pwNew.value !== pwNew2.value) {
    pwMsg.value = '两次输入的新密码不一致';
    return;
  }
  accBusy.value = true;
  try {
    await api.post('/auth/change-password', { old_password: pwOld.value, new_password: pwNew.value });
    pwMsg.value = '';
    accMsg.value = '密码已修改';
    pwOld.value = '';
    pwNew.value = '';
    pwNew2.value = '';
  } catch (e) {
    pwMsg.value = e instanceof Error ? e.message : '修改失败';
  } finally {
    accBusy.value = false;
  }
}

function switchMode(m: AuthMode) {
  authMode.value = m;
  authMsg.value = '';
  devCodeHint.value = '';
}

function onHashChange() {
  tab.value = currentTab();
}

function onAuthRequired() {
  authed.value = false;
  me.value = null;
}

onMounted(async () => {
  loadPublicSettings();
  await refreshMe();
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('auth:required', onAuthRequired);
  const params = new URLSearchParams(location.search);
  if (params.get('oauth') === 'ok') {
    showBanner('邮箱授权成功');
    history.replaceState(null, '', location.pathname + location.hash);
  } else if (params.get('oauth') === 'failed' || params.get('oauth') === 'error') {
    showBanner('邮箱授权失败，请重试', 'error');
    history.replaceState(null, '', location.pathname + location.hash);
  }
});

onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange);
  window.removeEventListener('auth:required', onAuthRequired);
});

const loading = computed(() => authed.value === null);
const siteName = computed(() => settings.value?.site_name || 'MailSorta');
const visibleTabs = computed(() => tabs.filter((t) => !t.adminOnly || user.value?.role === 'admin'));
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand" title="回到首页" @click="setTab('accounts')">
        <img class="brand-logo" src="/icons/icon.svg" alt="MailSorta logo" width="28" height="28" />
        <span>{{ siteName }}</span>
        <span class="sub">AI自动整理邮件信息和检索系统</span>
      </div>
      <div v-if="authed" class="actions">
        <nav class="tabs">
          <button
            v-for="t in visibleTabs"
            :key="t.key"
            class="tab"
            :class="{ active: tab === t.key }"
            @click="setTab(t.key)"
          >
            {{ t.label }}
          </button>
        </nav>
        <div class="userbox">
          <span class="tag" :class="member?.level === 'free' ? 'gray' : 'green'">{{ MEMBER_LEVEL_LABEL[member?.level ?? 'free'] }}</span>
          <span class="email">{{ user?.email }}</span>
          <button class="link" @click="openAccountModal">账户设置</button>
          <button class="link" @click="doLogout">退出</button>
        </div>
      </div>
    </header>

    <div v-if="banner" class="banner" :class="bannerType">{{ banner }}</div>

    <!-- 会员到期提示：自动整理已暂停，历史数据仍可查询导出 -->
    <div
      v-if="authed && member && member.level === 'free' && (member.plan === 'trial' || member.plan === 'paid')"
      class="banner error expiry-banner"
    >
      你的会员已到期，自动整理已暂停（历史数据仍可查询与导出）。
      <button class="link" @click="setTab('billing')">立即续费</button>
    </div>

    <div v-if="authed && member?.level === 'free' && me?.user" class="banner error" @click="setTab('billing')" style="cursor: pointer">
      会员已到期或未开通：免费版仅可连接 {{ quota?.accounts ?? 1 }} 个账号、{{ quota?.rules ?? 5 }} 条规则。点击前往套餐页升级 →
    </div>

    <main v-if="loading" class="center">加载中…</main>

    <main v-else-if="!authed" class="login-wrap">
      <form class="login-card" @submit.prevent="doAuth">
        <div class="login-brand">
          <img class="brand-logo" src="/icons/icon.svg" alt="MailSorta logo" width="56" height="56" />
          <h1>{{ siteName }}</h1>
        </div>
        <p class="muted">
          <template v-if="authMode === 'login'">登录你的账号，管理邮件整理</template>
          <template v-else-if="authMode === 'register'">注册新账号，新用户默认 7 天免费试用</template>
          <template v-else>通过邮箱验证码重置密码</template>
        </p>

        <input v-model="formEmail" type="email" placeholder="邮箱" autocomplete="username" />
        <input v-if="authMode === 'register'" v-model="formDisplayName" type="text" placeholder="昵称（可选）" />

        <div v-if="authMode === 'register' || authMode === 'forgot'" class="code-row">
          <input v-model="formCode" type="text" placeholder="邮箱验证码" class="grow" />
          <button type="button" class="secondary" :disabled="authBusy" @click="sendCode(authMode === 'register' ? 'register' : 'reset')">
            获取验证码
          </button>
        </div>
        <p v-if="devCodeHint" class="small devcode">{{ devCodeHint }}</p>

        <input v-model="formPassword" type="password" placeholder="密码（至少 8 位）" autocomplete="current-password" />
        <input v-if="authMode !== 'login'" v-model="formPassword2" type="password" placeholder="确认密码" />

        <button type="submit" class="primary" :disabled="authBusy">
          {{ authMode === 'login' ? '登录' : authMode === 'register' ? '注册并试用' : '重置密码' }}
        </button>

        <p v-if="authMsg" class="error">{{ authMsg }}</p>

        <div class="auth-switch">
          <button type="button" class="link" v-if="authMode !== 'login'" @click="switchMode('login')">已有账号？去登录</button>
          <button type="button" class="link" v-if="authMode === 'login'" @click="switchMode('register')">没有账号？去注册</button>
          <button type="button" class="link" v-if="authMode === 'login'" @click="switchMode('forgot')">忘记密码？</button>
        </div>
      </form>
    </main>

    <main v-else class="content">
      <AccountsView v-if="tab === 'accounts'" />
      <RulesView v-else-if="tab === 'rules'" />
      <EmailsView v-else-if="tab === 'emails'" />
      <SyncView v-else-if="tab === 'sync'" />
      <PlansView v-else-if="tab === 'billing'" :member="member" :quota="quota" @member-changed="refreshMe" />
      <AdminView v-else-if="tab === 'admin'" />
    </main>

    <footer class="foot">
      <div style="margin-bottom: 10px">
        <a class="tutorial-btn" href="https://opcgrow.org/article.php?id=141" target="_blank" rel="noopener">系统使用教程</a>
      </div>
      <a href="https://opcgrow.org" target="_blank" rel="noopener">Mailsorta · 查看 OPCGrow,专研一人公司潜力发挥和技术支持！</a>
    </footer>

    <!-- 账户设置弹窗 -->
    <div v-if="accountModal" class="modal-mask" @click.self="accountModal = false">
      <div class="modal">
        <h3 style="margin-top: 0">账户设置</h3>
        <div class="grid2">
          <label class="field">邮箱<input :value="user?.email" disabled /></label>
          <label class="field">昵称<input v-model="accDisplayName" placeholder="昵称（可选）" /></label>
        </div>
        <div class="row" style="margin-top: 8px">
          <button class="secondary" :disabled="accBusy" @click="saveProfile">保存昵称</button>
          <span v-if="accMsg" class="small" :class="{ error: accMsg.includes('失败') || accMsg.includes('TOKEN') }">{{ accMsg }}</span>
        </div>

        <hr style="border: none; border-top: 1px solid var(--line); margin: 16px 0" />
        <h3 style="margin: 0 0 4px">AI 提取模型（处理你规则中的「LLM 提取」字段）</h3>
        <p class="small muted">使用你自己的大模型，配置仅用于你的邮件整理。支持任何 OpenAI 兼容 /chat/completions 端点。</p>
        <div class="grid2">
          <label class="field">API 地址<input v-model="llmUrl" placeholder="https://ark.cn-beijing.volces.com/api/v3" /></label>
          <label class="field">模型 ID<input v-model="llmModel" placeholder="doubao-seed-1-6-250615 / deepseek-chat / gpt-4o-mini" /></label>
          <label class="field">API Key（留空保持不变）<input v-model="llmKey" type="password" :placeholder="llmKeySet ? '已配置，留空不修改' : '未配置'" autocomplete="off" /></label>
        </div>
        <div class="row" style="margin-top: 8px">
          <button class="secondary" :disabled="accBusy" @click="saveProfile">保存 AI 模型</button>
        </div>

        <hr style="border: none; border-top: 1px solid var(--line); margin: 16px 0" />
        <h3 style="margin: 0 0 4px">修改密码</h3>
        <div class="grid2">
          <label class="field">原密码<input v-model="pwOld" type="password" autocomplete="current-password" /></label>
          <label class="field">新密码（至少 8 位）<input v-model="pwNew" type="password" autocomplete="new-password" /></label>
          <label class="field">确认新密码<input v-model="pwNew2" type="password" autocomplete="new-password" /></label>
        </div>
        <div class="row" style="margin-top: 8px">
          <button class="primary" :disabled="accBusy" @click="savePassword">修改密码</button>
          <span v-if="pwMsg" class="small error">{{ pwMsg }}</span>
        </div>
        <p class="small muted">密码修改后请妥善保管；如忘记密码，可在登录页通过邮箱验证码重置。</p>

        <div class="row" style="margin-top: 14px">
          <button class="secondary" @click="accountModal = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
:root {
  --bg: #f4f3ee;
  --card: #ffffff;
  --line: #e4e3dd;
  --text: #1a1b1c;
  --muted: #6b7280;
  --accent: #2f6f9f;
  --danger: #c0392b;
  --ok: #2e7d32;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: 'Roboto', 'PingFang SC', 'Segoe UI', Arial, sans-serif; font-size: 14px; line-height: 1.5; }
.shell { max-width: 1180px; margin: 0 auto; padding: 16px; }
.topbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 700; cursor: pointer; user-select: none; }
.brand-logo { display: block; border-radius: 8px; object-fit: contain; }
.brand .sub { font-size: 12px; font-weight: 400; color: var(--muted); }
.login-brand { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-bottom: 8px; }
.login-brand h1 { margin: 0; font-size: 20px; }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; }
.tab { border: 1px solid var(--line); background: var(--card); color: var(--text); padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.tab.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.link { border: none; background: none; color: var(--accent); cursor: pointer; font-size: 13px; }
.center { text-align: center; padding: 60px 0; color: var(--muted); }
.login-wrap { display: flex; justify-content: center; padding: 48px 0; }
.login-card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 28px; width: 360px; max-width: 100%; }
.login-card h1 { margin: 0 0 4px; font-size: 20px; }
.login-card input { width: 100%; padding: 10px; margin: 8px 0; border: 1px solid var(--line); border-radius: 8px; font-size: 14px; }
.login-card .primary { margin-top: 10px; width: 100%; }
.code-row { display: flex; gap: 8px; align-items: center; }
.code-row input { flex: 1 1 120px; min-width: 0; }
.auth-switch { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
.devcode { background: #fff8e1; border: 1px solid #ffe082; color: #8a6d1a; padding: 6px 10px; border-radius: 8px; }
.content { padding: 16px 0 32px; }
.banner { background: #e8f5e9; color: var(--ok); border: 1px solid #a5d6a7; border-radius: 8px; padding: 8px 12px; margin: 10px 0; }
.banner.error { background: #fdecea; color: var(--danger); border-color: #f2c4c0; }
.expiry-banner { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.foot { color: var(--muted); font-size: 12px; text-align: center; padding: 16px 0; border-top: 1px solid var(--line); }
.foot a { color: inherit; text-decoration: none; }
.foot a:hover { text-decoration: underline; color: var(--accent); }
.foot .tutorial-btn {
  display: inline-block;
  background: var(--accent);
  color: #fff;
  text-decoration: none;
  padding: 8px 24px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  transition: opacity 0.15s ease;
}
.foot .tutorial-btn:hover { opacity: 0.88; text-decoration: none; color: #fff; }
.userbox { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.userbox .email { font-size: 12px; color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 12px 0; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.grow { flex: 1 1 160px; min-width: 0; }
button.primary { background: var(--accent); color: #fff; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; }
button.primary:disabled { opacity: 0.6; cursor: not-allowed; }
button.secondary { background: var(--card); color: var(--text); border: 1px solid var(--line); padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; }
button.danger { background: #fff; color: var(--danger); border: 1px solid #f2c4c0; padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
input, select, textarea { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit; background: #fff; color: var(--text); }
input:focus, select:focus { outline: 2px solid rgba(47, 111, 159, 0.35); outline-offset: 0; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); font-size: 13px; vertical-align: top; }
th { background: #faf9f6; font-weight: 600; white-space: nowrap; }
tr:last-child td { border-bottom: none; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.error { color: var(--danger); }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
.tag { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 12px; background: #eef4fa; color: var(--accent); }
.tag.gray { background: #f0f0f0; color: var(--muted); }
.tag.green { background: #e8f5e9; color: var(--ok); }
.tag.red { background: #fdecea; color: var(--danger); }
.tag.orange { background: #fff3e0; color: #e65100; }
.pager { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.pager .secondary.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.empty { color: var(--muted); padding: 24px; text-align: center; }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.35); display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px; z-index: 20; }
.modal { background: #fff; border-radius: 12px; max-width: 720px; width: 100%; max-height: 86vh; overflow: auto; padding: 20px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }

/* ---------------- 响应式（移动端） ---------------- */
@media (max-width: 768px) {
  .shell { padding: 12px; }
  .topbar { flex-direction: column; align-items: stretch; gap: 8px; }
  .brand { justify-content: center; }
  .brand .sub { display: none; }
  .actions { display: flex; flex-direction: column; gap: 8px; }
  .tabs { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 4px; scrollbar-width: thin; }
  .tab { flex: 0 0 auto; min-height: 40px; padding: 8px 14px; }
  .userbox { justify-content: center; }
  .content { padding: 12px 0 24px; }
  .login-wrap { padding: 24px 0; }
  .login-card { padding: 20px 16px; }
  .card { padding: 12px; margin: 10px 0; }
  .modal-mask { padding: 16px 10px; }
  .modal { padding: 14px; }
  .grid2 { grid-template-columns: 1fr; }
  /* 表格在窄屏下横向滚动，避免内容挤压 */
  table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; white-space: nowrap; }
  th, td { min-width: 96px; }
}
@media (max-width: 480px) {
  .brand { font-size: 16px; }
  button.primary, button.secondary, button.danger { min-height: 40px; padding: 8px 14px; }
  input, select, textarea { font-size: 16px; } /* 防 iOS 聚焦缩放 */
}
</style>
