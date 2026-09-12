/**
 * Agently Mail (QQ) 本地桥接层（多槽版）
 * ============================
 * 腾讯官方目前只提供本地 CLI / MCP 形态（无服务端 REST API），
 * 因此本服务把 agently-cli 封装成 Worker 可调用的 HTTP 接口：
 *
 *   POST /rpc            { tool, params, user? }   → 执行 CLI 并返回 JSON（user 指定登录槽）
 *   POST /auth/start     { session, user? }        → 触发 agently-cli auth login，返回微信扫码链接
 *   GET  /auth/status    ?session=                 → 轮询授权结果
 *   POST /watch/register { callback, secret, user? } → 启动 message +watch 并把新邮件推送到 callback
 *
 * 多用户隔离：每个 user 一个独立登录槽（slot），通过 HOME/XDG_* 环境变量把 agently-cli
 * 的配置目录隔离到 DATA_DIR/slots/<user>/ 下，互不共享登录态。
 * 不传 user 时使用 default 槽（兼容旧调用）。
 *
 * 依赖：npm install -g @tencent-qqmail/agently-cli && agently-cli auth login
 * 运行：AGENTLY_BRIDGE_TOKEN=xxx node index.mjs
 *
 * 迁移：把服务器上现有的全局登录态（~/.agently-cli 等）归到某个槽，启动时设置
 *   AGENTLY_MIGRATE_TO=<userId> node index.mjs   （执行一次即可，成功后建议移除该变量）
 *
 * ⚠️ CLI 子命令以你本机 `agently-cli --help` 输出为准；
 *    本文件底部 TOOL_MAP 是唯一的命令映射点，一行即可调整。
 */
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseCliOutput } from './parse.mjs';
import { imapList, imapGet, ImapProxyAuthError } from './imap.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const PORT = Number(process.env.BRIDGE_PORT ?? 9876);
const TOKEN = process.env.AGENTLY_BRIDGE_TOKEN ?? process.env.BRIDGE_TOKEN ?? '';
const CLI = process.env.AGENTLY_CLI ?? 'agently-cli';
const CONFIG_PATH = join(DATA_DIR, 'config.json');

// ---------------- 多槽（per-user 登录态隔离） ----------------

/** 槽名：user 参数规范化，空值回落 default */
function slotName(user) {
  const u = String(user ?? '').trim();
  return u ? u.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) : 'default';
}

/** 槽目录（agently-cli 的 HOME 指向这里） */
function slotHome(user) {
  const dir = join(DATA_DIR, 'slots', slotName(user));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 子进程环境：HOME/XDG 全部指向槽目录，隔离 CLI 配置 */
function cliEnv(user) {
  const home = slotHome(user);
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
  };
}

// ---------------- 配置持久化 ----------------

function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  return { watchers: [], authSessions: {} };
}

function saveConfig() {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const config = loadConfig();

// ---------------- 迁移：全局登录态归入指定槽 ----------------

function migrateGlobalLogin(toUser) {
  const target = slotHome(toUser);
  const candidates = [
    join(homedir(), '.agently-cli'),
    join(homedir(), '.config', 'agently-cli'),
    join(homedir(), '.local', 'share', 'agently-cli'),
  ];
  let copied = 0;
  for (const src of candidates) {
    if (!existsSync(src)) continue;
    const dest = join(target, src.slice(homedir().length).replace(/^[\\/]/, ''));
    mkdirSync(dirname(dest), { recursive: true });
    try {
      cpSync(src, dest, { recursive: true, force: true });
      copied += 1;
      console.log(`[migrate] ${src} -> ${dest}`);
    } catch (e) {
      console.error(`[migrate] 复制失败 ${src}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return copied;
}

if (process.env.AGENTLY_MIGRATE_TO) {
  const n = migrateGlobalLogin(process.env.AGENTLY_MIGRATE_TO);
  console.log(`[migrate] AGENTLY_MIGRATE_TO=${process.env.AGENTLY_MIGRATE_TO} 完成，复制 ${n} 个目录`);
}

// ---------------- CLI 执行（串行队列，避免凭据并发冲突） ----------------

let queue = Promise.resolve();

function runCli(args, { timeout = 60000, user } = {}) {
  const p = queue.then(
    () =>
      new Promise((resolve, reject) => {
        execFile(CLI, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: cliEnv(user) }, (err, stdout, stderr) => {
          if (err) return reject(new Error((stderr || err.message || '').slice(0, 500)));
          resolve(stdout);
        });
      }),
  );
  queue = p.catch(() => {});
  return p;
}

async function cliJson(args, user) {
  const out = await runCli(args, { user });
  return parseCliOutput(out);
}

// ⚠️ 命令映射点：以下为基于官方 SKILL.md 的默认映射（agently-cli 列表/读取/搜索命令带 "+" 前缀）。
//    若与 `agently-cli --help` 不一致，只需改这里。
const TOOL_MAP = {
  me: (params = {}, user) => cliJson(['+me'], user),
  'message.list': (params = {}, user) => {
    const args = ['message', '+list'];
    if (params.folder) args.push('--dir', String(params.folder));
    if (params.limit) args.push('--limit', String(params.limit));
    return cliJson(args, user);
  },
  'message.search': (params = {}, user) => cliJson(['message', '+search', '--q', String(params.query ?? '')], user),
  'message.get': (params = {}, user) => cliJson(['message', '+read', '--id', String(params.id ?? '')], user),
};

// ---------------- 授权链接提取 ----------------

/** 从 CLI 输出中提取授权链接（设备码模式，含扫码链接）。
 * 优先级：微信扫码 > OAuth/设备码 > 一般授权路径；黑名单域名（文档/仓库/示例）一律排除。 */
const AUTH_URL_PRIORITY = [
  (u) => /open\.weixin\.qq\.com/i.test(u.hostname) && /qrconnect|connect\/qr/i.test(u.pathname + u.search), // 微信扫码
  (u) => /oauth|authorize|device|qrconnect/i.test(u.pathname + u.search), // OAuth / 设备码
  (u) => true, // 兜底
];
const AUTH_URL_BLACKLIST_HOST = [
  /agent\.qq\.com\/doc/i, /^docs?\./, /github\.com/i, /npmjs\.com/i, /example\./i, /localhost/i,
];
const AUTH_URL_BLACKLIST = (u) =>
  AUTH_URL_BLACKLIST_HOST.some((re) => re.test(u.hostname + u.pathname)) ||
  /\.(png|jpg|jpeg|gif|svg|ico|css|js)$/i.test(u.pathname);

function pickAuthUrl(rawLines) {
  const urls = [];
  const seen = new Set();
  for (const line of rawLines) {
    const m = line.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [];
    for (const u of m) {
      const clean = u.replace(/[.,;:!?]+$/, '');
      if (seen.has(clean)) continue;
      seen.add(clean);
      try {
        const parsed = new URL(clean);
        if (AUTH_URL_BLACKLIST(parsed)) continue;
        urls.push(parsed);
      } catch {
        /* 跳过非法 URL */
      }
    }
  }
  for (const match of AUTH_URL_PRIORITY) {
    const hit = urls.find((u) => match(u));
    if (hit) return { authUrl: hit.href, urls: urls.map((u) => u.href) };
  }
  return { authUrl: null, urls: urls.map((u) => u.href) };
}

// ---------------- 新邮件监听（message +watch 推送，按 user 独立进程） ----------------

const watchProcesses = new Map(); // `user:${slot}` -> child

function ensureWatcher(key, user) {
  if (watchProcesses.has(key)) return;
  const child = spawn(CLI, ['message', '+watch'], { stdio: ['ignore', 'pipe', 'inherit'], env: cliEnv(user) });
  watchProcesses.set(key, child);
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        const messageId = evt.messageId ?? evt.id ?? evt.message?.id;
        if (messageId) dispatchToWatchers(messageId, evt, user);
      } catch {
        // 非 JSON 行（如 CLI 日志）忽略
      }
    }
  });
  child.on('exit', () => watchProcesses.delete(key));
}

function dispatchToWatchers(messageId, evt, user) {
  for (const w of config.watchers) {
    if (!w.callback) continue;
    if (w.user && user && slotName(w.user) !== slotName(user)) continue; // watcher 只收自己槽的事件
    fetch(w.callback, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': w.secret ?? '' },
      body: JSON.stringify({ messageId, accountEmail: evt.accountEmail, ts: Date.now(), user: slotName(user) }),
    }).catch(() => {});
  }
}

// ---------------- HTTP 服务 ----------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {});
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function auth(req) {
  const header = req.headers.authorization ?? '';
  return TOKEN && header === `Bearer ${TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  try {
    if (path === '/health') return json(res, 200, { ok: true, cli: CLI, port: PORT });

    if (!auth(req)) return json(res, 401, { error: '无效的 BRIDGE_TOKEN' });

    // ---- RPC：核心调用入口 ----
    if (req.method === 'POST' && path === '/rpc') {
      const body = await readBody(req);
      const tool = body.tool;
      if (!tool || typeof TOOL_MAP[tool] !== 'function') return json(res, 400, { error: `未知 tool: ${tool}` });
      const user = body.user;
      try {
        const data = await TOOL_MAP[tool](body.params ?? {}, user);
        return json(res, 200, data);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // agently-cli 未登录时的典型输出
        if (/not.?logged.?in|未登录|尚未绑定|auth.*login|需要登录/i.test(msg)) {
          return json(res, 409, {
            error: 'NOT_LOGGED_IN',
            user: slotName(user),
            hint: `该用户槽（${slotName(user)}）尚未绑定 Agently Mail，请先走 /auth/start 扫码流程`,
            detail: msg.slice(0, 300),
          });
        }
        return json(res, 502, { error: 'CLI 执行失败', detail: msg.slice(0, 500) });
      }
    }

    // ---- 授权 ----
    if (req.method === 'POST' && path === '/auth/start') {
      const body = await readBody(req);
      const user = body.user;
      const session = body.session ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // 单槽保护：该 user 已有一个正在进行的授权时，复用其链接，避免多个 CLI 实例争抢登录态
      const activeAuth = Object.entries(config.authSessions).find(
        ([, s]) => s.status === 'pending' && s.authUrl && slotName(s.user) === slotName(user),
      );
      if (activeAuth) {
        return json(res, 200, { authUrl: activeAuth[1].authUrl, session: activeAuth[0], reused: true, urls: activeAuth[1].urls ?? [], user: slotName(user) });
      }

      config.authSessions[session] = { status: 'pending', createdAt: Date.now(), authUrl: null, urls: [], user };
      saveConfig();

      // 触发 agently-cli auth login（该 user 的槽），抓取授权链接；进程保持运行直到登录完成
      const child = spawn(CLI, ['auth', 'login'], { stdio: ['ignore', 'pipe', 'inherit'], env: cliEnv(user) });
      let outLines = [];
      let outBuf = '';
      child.stdout.on('data', (d) => {
        outBuf += d.toString();
        outLines = outBuf.split(/\r?\n/);
        const picked = pickAuthUrl(outLines.slice(-60));
        if (picked.authUrl && !config.authSessions[session].authUrl) {
          config.authSessions[session].authUrl = picked.authUrl;
          config.authSessions[session].urls = picked.urls;
          saveConfig();
        }
      });
      child.on('error', (err) => {
        const msg =
          err.code === 'ENOENT'
            ? `未找到 CLI「${CLI}」：请先执行 npm install -g @tencent-qqmail/agently-cli 并确认命令可用`
            : `启动 CLI 失败：${err.message}`;
        config.authSessions[session].status = 'error';
        config.authSessions[session].error = msg;
        saveConfig();
        if (!res.headersSent) json(res, 500, { error: msg });
      });
      child.on('exit', () => {
        // 进程退出也可能已登录成功，立即同步一次状态
        pollAuth(session);
      });

      // 轮询授权完成（最多 5 分钟），成功后自动更新会话
      const pollAuth = async (sess) => {
        for (let i = 0; i < 150; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const me = await cliJson(['+me'], user);
            const email = me?.email ?? me?.alias ?? me?.aliases?.[0];
            if (email) {
              const s = config.authSessions[sess];
              if (s && s.status !== 'done') {
                s.status = 'done';
                s.email = email;
                s.displayName = me.displayName ?? me.name ?? null;
                saveConfig();
                notifyAuthDone(sess, email, s.displayName, user);
              }
              return;
            }
          } catch {
            // 未登录完成，继续等
          }
        }
      };

      // 给 CLI 一点时间输出 URL（最多 10 秒）
      for (let i = 0; i < 10 && !config.authSessions[session].authUrl; i++) {
        await new Promise((r) => setTimeout(r, 1000));
      }

      const s = config.authSessions[session];
      if (s.status === 'error') {
        // CLI 启动失败：错误已由 child.on('error') 返回
        if (!res.headersSent) return json(res, 500, { error: s.error ?? 'CLI 启动失败' });
        return;
      }
      if (!s.authUrl) {
        // 拿不到 URL 时给出提示；用户也可手动执行 agently-cli auth login
        return json(res, 200, {
          authUrl: null,
          session,
          urls: s.urls ?? [],
          user: slotName(user),
          hint: '未能自动捕获授权链接，请手动执行：agently-cli auth login',
        });
      }
      pollAuth(session);
      return json(res, 200, { authUrl: s.authUrl, session, urls: s.urls ?? [], user: slotName(user) });
    }

    if (req.method === 'GET' && path === '/auth/status') {
      const session = url.searchParams.get('session');
      const s = config.authSessions[session];
      if (!s) return json(res, 200, { status: 'expired' });
      return json(res, 200, { status: s.status, email: s.email, displayName: s.displayName, error: s.error ?? null, user: slotName(s.user) });
    }

    // ---- 新邮件推送注册 ----
    if (req.method === 'POST' && path === '/watch/register') {
      const body = await readBody(req);
      if (!body.callback) return json(res, 400, { error: '缺少 callback' });
      const user = body.user;
      const existing = config.watchers.find((w) => w.callback === body.callback && slotName(w.user) === slotName(user));
      if (existing) {
        existing.secret = body.secret ?? existing.secret;
        existing.user = user;
      } else {
        config.watchers.push({ callback: body.callback, secret: body.secret ?? null, user });
      }
      saveConfig();
      ensureWatcher(`user:${slotName(user)}`, user);
      return json(res, 200, { ok: true, watching: true, user: slotName(user) });
    }

    // ---- IMAP 代理（QQ / 163 / 126）----
    if (req.method === 'POST' && path === '/imap/list') {
      const body = await readBody(req);
      try {
        const messages = await imapList({
          email: body.email, authCode: body.authCode, host: body.host,
          port: body.port, since: body.since, from: body.from, maxResults: body.maxResults,
        });
        return json(res, 200, { ok: true, messages });
      } catch (e) {
        if (e instanceof ImapProxyAuthError) return json(res, 200, { ok: false, auth: true, error: e.message });
        return json(res, 200, { ok: false, auth: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (req.method === 'POST' && path === '/imap/get') {
      const body = await readBody(req);
      try {
        const r = await imapGet({
          email: body.email, authCode: body.authCode, host: body.host, port: body.port, uid: body.uid,
        });
        if (r.ok) return json(res, 200, { ok: true, message: r.message });
        return json(res, 200, { ok: false, auth: false, error: r.reason ?? '取信失败' });
      } catch (e) {
        if (e instanceof ImapProxyAuthError) return json(res, 200, { ok: false, auth: true, error: e.message });
        return json(res, 200, { ok: false, auth: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

function notifyAuthDone(session, email, displayName, user) {
  for (const w of config.watchers) {
    if (!w.callback || !w.secret) continue;
    if (w.user && user && slotName(w.user) !== slotName(user)) continue;
    const url = `${w.callback.replace(/\/$/, '')}/auth`;
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': w.secret },
      body: JSON.stringify({ session, email, displayName, user: slotName(user) }),
    }).catch(() => {});
  }
}

if (!TOKEN) {
  console.warn('⚠️ 未设置 AGENTLY_BRIDGE_TOKEN，将拒绝所有请求。启动方式：AGENTLY_BRIDGE_TOKEN=xxx node index.mjs');
}

server.listen(PORT, () => {
  console.log(`[agently-bridge] listening on http://127.0.0.1:${PORT}`);
  console.log(`[agently-bridge] CLI: ${CLI}（命令映射见 TOOL_MAP，可用 agently-cli --help 核对）`);
  console.log(`[agently-bridge] 多槽目录: ${join(DATA_DIR, 'slots')}`);
  // 已在配置文件中的 watcher 自动恢复（按 user 各自启动）
  for (const w of config.watchers) {
    if (w.user) ensureWatcher(`user:${slotName(w.user)}`, w.user);
  }
  if (config.watchers.length && !config.watchers.some((w) => w.user)) ensureWatcher('user:default');
});
