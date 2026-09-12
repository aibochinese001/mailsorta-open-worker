<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, fmtTime } from '../api';
import type { Account } from '../types';

const accounts = ref<Account[]>([]);
const loading = ref(false);
const msg = ref('');
const agentlyAuthUrl = ref('');
const agentlySession = ref('');
const polling = ref(false);

const PROVIDER_LABEL: Record<string, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  agently: 'Agently Mail (QQ)',
  imap: 'IMAP 邮箱',
};

// ---------------- IMAP（QQ / 163 / 126） ----------------
const IMAP_PRESETS: Record<string, { host: string; port: number; placeholder: string }> = {
  qq: { host: 'imap.qq.com', port: 993, placeholder: 'xxx@qq.com' },
  '163': { host: 'imap.163.com', port: 993, placeholder: 'xxx@163.com' },
  '126': { host: 'imap.126.com', port: 993, placeholder: 'xxx@126.com' },
};
const showImapForm = ref(false);
const imapType = ref<'qq' | '163' | '126'>('qq');
const imapEmail = ref('');
const imapCode = ref('');
const imapHost = ref('imap.qq.com');
const imapPort = ref(993);
const imapTest = ref(true);
const imapBusy = ref(false);
const imapMsg = ref('');

function openImap(type: 'qq' | '163' | '126') {
  imapType.value = type;
  const p = IMAP_PRESETS[type];
  imapHost.value = p.host;
  imapPort.value = p.port;
  imapEmail.value = '';
  imapCode.value = '';
  imapMsg.value = '';
  showImapForm.value = true;
}

async function saveImap() {
  imapBusy.value = true;
  imapMsg.value = '';
  try {
    const r = await api.post<{ ok: boolean; tested: boolean }>('/accounts/imap', {
      email: imapEmail.value,
      auth_code: imapCode.value,
      host: imapHost.value,
      port: imapPort.value,
      test: imapTest.value,
    });
    showImapForm.value = false;
    msg.value = r.tested ? 'IMAP 账号已保存，连接测试通过' : 'IMAP 账号已保存';
    await load();
  } catch (e) {
    imapMsg.value = e instanceof Error ? e.message : '保存失败';
  } finally {
    imapBusy.value = false;
  }
}

async function load() {
  const data = await api.get<{ accounts: Account[] }>('/accounts');
  accounts.value = data.accounts;
}

async function connect(provider: 'gmail' | 'outlook' | 'agently') {
  msg.value = '';
  try {
    const res = await api.post<{
      authorizeUrl?: string;
      authUrl?: string | null;
      session?: string;
      alreadyLoggedIn?: boolean;
      email?: string | null;
      status?: string | null;
    }>(`/accounts/oauth/${provider}/start`);
    if (provider === 'agently') {
      if (res.alreadyLoggedIn || res.status === 'done') {
        // 形态 B：该用户槽已登录，直接显示绑定成功，不走扫码
        msg.value = `Agently Mail 已连接：${res.email ?? '已授权'}`;
        agentlyAuthUrl.value = '';
        agentlySession.value = '';
        polling.value = false;
        await load();
      } else if (res.authUrl) {
        // 形态 A/C：展示扫码链接并轮询
        agentlyAuthUrl.value = res.authUrl;
        agentlySession.value = res.session ?? '';
        polling.value = true;
        pollAgently();
      } else {
        // 真正的捕获失败
        msg.value = `桥接层未捕获到授权链接：${res.session ? '请检查桥接层 agently-cli 登录状态' : '请确认已安装 agently-cli 并在桥接层所在机器手动执行一次 agently-cli auth login'}`;
      }
    } else if (res.authorizeUrl) {
      window.location.href = res.authorizeUrl;
    }
  } catch (e) {
    msg.value = e instanceof Error ? e.message : '发起授权失败';
  }
}

async function pollAgently() {
  if (!agentlySession.value) return;
  try {
    const st = await api.get<{ status: 'pending' | 'done' | 'expired'; email?: string }>(
      `/accounts/oauth/agently/status?session=${encodeURIComponent(agentlySession.value)}`,
    );
    if (st.status === 'done') {
      msg.value = `Agently 授权完成：${st.email}`;
      agentlyAuthUrl.value = '';
      polling.value = false;
      await load();
      return;
    }
    if (st.status === 'expired' || st.status === 'error') {
      msg.value = st.status === 'expired' ? '授权会话已过期，请重新发起' : '授权失败，请重新发起';
      agentlyAuthUrl.value = '';
      polling.value = false;
      return;
    }
  } catch {
    /* 继续轮询 */
  }
  if (polling.value) setTimeout(pollAgently, 3000);
}

async function createSubscription(a: Account) {
  msg.value = '';
  try {
    await api.post(`/accounts/${a.id}/subscription`);
    msg.value = 'Outlook 新邮件订阅已创建（3 天有效，Worker 会自动续期）';
  } catch (e) {
    msg.value = e instanceof Error ? e.message : '创建订阅失败';
  }
}

async function remove(a: Account) {
  if (!confirm(`确定删除账号 ${a.email}？其下所有规则与整理记录将一并删除。`)) return;
  await api.del(`/accounts/${a.id}`);
  await load();
}

onMounted(load);
</script>

<template>
  <div>
    <div class="card">
      <h3 style="margin-top: 0">连接邮箱</h3>
      <div class="row">
        <button class="primary" @click="connect('agently')">连接 Agently Mail (QQ)</button>
        <button class="primary" @click="openImap('qq')">QQ 邮箱 (IMAP)</button>
      </div>
      <p v-if="agentlyAuthUrl" class="small">
        <a :href="agentlyAuthUrl" target="_blank" rel="noopener">打开授权链接</a>，用<strong>微信扫码</strong>完成登录授权（链接应在
        <code>open.weixin.qq.com</code> 等微信/OAuth 授权页；若打开后是普通网页或登录页，说明桥接层抓取链接异常，请检查桥接层版本）。授权完成后页面将自动刷新。
      </p>
      <p v-if="msg" class="small" :class="{ error: msg.includes('失败') || msg.includes('过期') }">{{ msg }}</p>
    </div>

    <!-- IMAP 添加表单 -->
    <div v-if="showImapForm" class="card">
      <h3 style="margin-top: 0">添加 {{ { qq: 'QQ 邮箱', 163: '网易 163', 126: '网易 126' }[imapType] }}（IMAP）</h3>
      <div class="grid2">
        <label>邮箱
          <input v-model="imapEmail" :placeholder="IMAP_PRESETS[imapType].placeholder" />
        </label>
        <label>授权码
          <input v-model="imapCode" type="password" placeholder="网页端开启 IMAP 服务后生成的授权码（非登录密码）" />
        </label>
        <label>IMAP 服务器
          <input v-model="imapHost" />
        </label>
        <label>端口
          <input v-model.number="imapPort" type="number" />
        </label>
      </div>
      <div class="row" style="margin-top: 8px">
        <label class="small" style="display: flex; align-items: center; gap: 6px">
          <input v-model="imapTest" type="checkbox" /> 保存时测试连接
        </label>
      </div>
      <p class="small muted" style="margin: 8px 0 0">
        授权码获取：QQ 邮箱「设置 → 账号 → 开启 IMAP/SMTP 服务」，按提示生成客户端授权码。
        授权码以加密形式存储，仅用于拉取邮件。
      </p>
      <div class="row" style="margin-top: 10px">
        <button class="primary" :disabled="imapBusy" @click="saveImap">{{ imapBusy ? '保存中…' : '保存' }}</button>
        <button class="secondary" @click="showImapForm = false">取消</button>
        <span v-if="imapMsg" class="small error">{{ imapMsg }}</span>
      </div>
    </div>

    <table>
      <thead>
        <tr><th>Provider</th><th>邮箱</th><th>状态</th><th>授权范围</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="a in accounts" :key="a.id">
          <td>{{ PROVIDER_LABEL[a.provider] ?? a.provider }}</td>
          <td>{{ a.email }}<div v-if="a.display_name" class="small muted">{{ a.display_name }}</div></td>
          <td><span class="tag" :class="a.status === 'active' ? 'green' : 'red'">{{ a.status }}</span></td>
          <td class="small muted">{{ a.scopes ?? '—' }}</td>
          <td>
            <div class="row">
              <button v-if="a.provider === 'outlook' && a.status === 'active'" class="secondary" @click="createSubscription(a)">创建推送订阅</button>
              <button class="danger" @click="remove(a)">删除</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!accounts.length" class="empty">尚未连接任何邮箱。Agently Mail 走微信扫码授权；QQ 邮箱使用授权码（IMAP）。</div>
  </div>
</template>
