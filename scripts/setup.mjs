/**
 * MailSorta 一键初始化（幂等）
 *
 * 作用：
 *   1. 校验前置（Node / wrangler / CLOUDFLARE_API_TOKEN）
 *   2. 创建 D1 mailsorta-db、KV MAILSORTA_KV、R2 mailsorta-exports（已存在则跳过）
 *   3. 把返回的 database_id / namespace id 回填 wrangler.jsonc 占位符
 *   4. 执行 D1 迁移（0001..0004）
 *   5. 生成 SESSION_SECRET / TOKEN_ENCRYPTION_KEY 写入 .dev.vars（不覆盖已有值）
 *
 * 用法：npm run setup
 * 需要：已登录 Cloudflare（wrangler login）或 CLOUDFLARE_API_TOKEN 环境变量
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WRANGLER = path.join(ROOT, 'wrangler.jsonc');
const DEV_VARS = path.join(ROOT, '.dev.vars');

const ok = (msg) => console.log(`\x1b[32m✔\x1b[0m ${msg}`);
const info = (msg) => console.log(`\x1b[36mℹ\x1b[0m ${msg}`);
const warn = (msg) => console.log(`\x1b[33m⚠\x1b[0m ${msg}`);

function run(args, opts = {}) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function ensureWrangler() {
  try {
    run(['--version']);
  } catch {
    console.error('✖ 未找到 wrangler，请先 `npm install`');
    process.exit(1);
  }
  try {
    const who = run(['whoami']);
    if (/You are not authenticated|✘|error/i.test(who)) {
      console.error('✖ 未登录 Cloudflare：请先 `npx wrangler login` 或设置 CLOUDFLARE_API_TOKEN');
      process.exit(1);
    }
    ok('Cloudflare 已认证');
  } catch {
    // whoami 失败也视为未认证
    console.error('✖ 无法确认 Cloudflare 登录态：请先 `npx wrangler login` 或设置 CLOUDFLARE_API_TOKEN');
    process.exit(1);
  }
}

function readJsonc() {
  return readFileSync(WRANGLER, 'utf8');
}

function patchJsonc(text, from, to) {
  if (!text.includes(from)) return text;
  warn(`${from} → ${to}`);
  return text.replace(from, to);
}

function firstUuid(text) {
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

async function ensureD1() {
  const conf = readJsonc();
  if (!conf.includes('REPLACE_WITH_D1_DATABASE_ID')) {
    ok('D1 database_id 已配置，跳过创建');
    return;
  }
  info('创建 D1 数据库 mailsorta-db …');
  let out = '';
  try {
    out = run(['d1', 'create', 'mailsorta-db']);
  } catch (e) {
    warn('D1 创建报错（可能已存在），尝试从列表复用…');
  }
  let id = firstUuid(out);
  if (!id) {
    try {
      const list = run(['d1', 'list']);
      const ids = [...list.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)];
      // d1 list 输出表格式，取名称含 mailsorta-db 的行
      const rows = list.split('\n').filter((l) => l.includes('mailsorta-db'));
      const rowId = rows.length ? (rows[0].match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] : null;
      id = rowId || (ids.length ? ids[ids.length - 1][0] : null);
      if (!id) throw new Error('无法从 d1 list 解析 id');
      ok(`D1 已存在，复用 ${id}`);
    } catch (err) {
      console.error('✖ 创建/查找 D1 失败。请手动执行：');
      console.error('   npx wrangler d1 create mailsorta-db');
      console.error('   然后把返回的 database_id 填入 wrangler.jsonc 的 REPLACE_WITH_D1_DATABASE_ID');
      process.exit(1);
    }
  }
  if (id) writeFileSync(WRANGLER, patchJsonc(conf, 'REPLACE_WITH_D1_DATABASE_ID', id));
}

async function ensureKV() {
  const conf = readJsonc();
  if (!conf.includes('REPLACE_WITH_KV_NAMESPACE_ID')) {
    ok('KV namespace id 已配置，跳过创建');
    return;
  }
  info('创建 KV 命名空间 MAILSORTA_KV …');
  let out = '';
  try {
    out = run(['kv', 'namespace', 'create', 'MAILSORTA_KV']);
  } catch (e) {
    warn('KV 创建报错（可能已存在），尝试从列表复用…');
  }
  let m = out.match(/"id"\s*:\s*"([0-9a-f]{32})"/);
  if (!m) {
    try {
      const list = run(['kv', 'namespace', 'list']);
      const rows = list.split('\n').filter((l) => l.includes('MAILSORTA_KV'));
      const rowId = rows.length ? (rows[0].match(/[0-9a-f]{32}/i) || [])[0] : null;
      if (!rowId) throw new Error('无法解析 KV id');
      m = [null, rowId];
      ok(`KV 已存在，复用 ${rowId}`);
    } catch (err) {
      console.error('✖ 创建/查找 KV 失败。请手动执行：');
      console.error('   npx wrangler kv namespace create MAILSORTA_KV');
      console.error('   然后把返回的 id 填入 wrangler.jsonc 的 REPLACE_WITH_KV_NAMESPACE_ID');
      process.exit(1);
    }
  }
  if (m?.[1]) writeFileSync(WRANGLER, patchJsonc(conf, 'REPLACE_WITH_KV_NAMESPACE_ID', m[1]));
}

async function ensureR2() {
  info('创建 R2 桶 mailsorta-exports …');
  try {
    run(['r2', 'bucket', 'create', 'mailsorta-exports']);
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (/already exists/i.test(msg)) {
      ok('R2 桶已存在，跳过');
    } else {
      console.error('✖ 创建 R2 失败：\n' + msg);
      process.exit(1);
    }
  }
  ok('R2 桶就绪');
}

async function migrate() {
  info('执行 D1 迁移（0001..0004）…');
  run(['d1', 'migrations', 'apply', 'mailsorta-db']);
  ok('迁移完成');
}

function ensureDevVars() {
  const has = existsSync(DEV_VARS);
  const cur = has ? readFileSync(DEV_VARS, 'utf8') : '';
  const lines = [];
  let session = false;
  let encKey = false;

  if (!has || !cur.includes('SESSION_SECRET=') || /^SESSION_SECRET=\s*$/m.test(cur)) {
    lines.push(`SESSION_SECRET=${randomBytes(32).toString('base64url')}`);
    session = true;
  } else {
    session = true; // 已有值视为满足
  }
  if (!has || !cur.includes('TOKEN_ENCRYPTION_KEY=') || /^TOKEN_ENCRYPTION_KEY=\s*$/m.test(cur)) {
    lines.push(`TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
    encKey = true;
  } else {
    encKey = true;
  }

  if (session && encKey) {
    if (!lines.length && has) {
      ok('.dev.vars 已含 SESSION_SECRET 与 TOKEN_ENCRYPTION_KEY，跳过');
      return;
    }
    writeFileSync(DEV_VARS, (has ? cur.replace(/\s*$/, '') + '\n' : '') + lines.join('\n') + '\n');
    ok(`.dev.vars 已写入 ${lines.length} 个密钥` + (has ? '（保留原内容）' : ''));
  }
}

async function main() {
  console.log('=== MailSorta 一键初始化 ===\n');
  ensureWrangler();
  await ensureD1();
  await ensureKV();
  await ensureR2();
  await migrate();
  ensureDevVars();
  console.log('\n=== 完成 ===');
  console.log('下一步：');
  console.log('  1) 检查 wrangler.jsonc 的 APP_BASE_URL：');
  console.log('     首次部署可用 workers.dev 域名（部署后从输出复制）；绑定自定义域名后改回 https://你的域名');
  console.log('  2) 部署：npm run deploy');
  console.log('  3) 生产 secrets：');
  console.log('     npx wrangler secret put SESSION_SECRET');
  console.log('     npx wrangler secret put TOKEN_ENCRYPTION_KEY');
  console.log('     npx wrangler secret put GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  （Gmail，可选）');
  console.log('     npx wrangler secret put MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET  （Outlook，可选）');
  console.log('     npx wrangler secret put AGENTLY_BRIDGE_URL / AGENTLY_BRIDGE_TOKEN  （Agently 桥接层，可选）');
}

main().catch((e) => {
  console.error('✖ 初始化失败：', e.message);
  process.exit(1);
});
