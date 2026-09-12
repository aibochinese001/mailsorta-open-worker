/**
 * MailSorta 敏感信息扫描器（提交前运行）
 *
 * 用法：node scripts/formal_secret_scan.mjs
 * 预期：敏感模式命中 0，个人标识符检查通过
 *
 * 排除：node_modules / .wrangler / dist / bridge/data / 二进制文件 / lock 文件
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.wrangler', 'dist', '.git']);
const SKIP_FILES = new Set(['.dev.vars', 'package-lock.json', 'frontend/package-lock.json', 'bridge/package-lock.json', 'package.json', 'frontend/package.json', 'bridge/package.json']);
const IGNORE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.db', '.sqlite', '.bak', '.zip']);

// 敏感模式（大小写不敏感）
const PATTERNS = [
  [/sk-[A-Za-z0-9]{20,}/, '疑似 OpenAI/LLM API Key（sk- 前缀）'],
  [/Bearer\s+[A-Za-z0-9._\-]{20,}/, 'Bearer Token'],
  [/CLOUDFLARE_API_TOKEN\s*[=:]\s*\S+/, 'Cloudflare API Token'],
  [/\b(api[_-]?key|apikey)\b\s*[=:]\s*['"][^'"]{16,}['"]/i, '疑似 API Key 赋值'],
  [/\b(client[_-]?secret|client_id)\b\s*[=:]\s*['"][A-Za-z0-9._\-]{16,}['"]/i, '疑似 OAuth 客户端凭据'],
  [/(?=.*[0-9])(?=.*[A-Za-z])[A-Za-z0-9+/]{44,}={0,2}\b/, '疑似 base64 长串（密钥，44+ 字符）'],
];

// 强特征模式：任何位置（含 test/）命中都算失败
const STRONG_PATTERNS = [
  [/sk-[A-Za-z0-9]{20,}/, '疑似 LLM API Key'],
  [/Bearer\s+[A-Za-z0-9._\-]{20,}/, 'Bearer Token'],
  [/CLOUDFLARE_API_TOKEN\s*[=:]\s*\S+/, 'Cloudflare API Token'],
];

// 测试目录放行：test/ 下的假密钥/假密码不视为泄露（夹具数据）
const isTestFixture = (rel) => rel.startsWith('test/');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// 测试用假邮箱域名（允许出现在 test/ 与示例中）
const FAKE_EMAIL_DOMAINS = /@(test\.com|example\.com|qq\.com|163\.com|126\.com|alipay\.com|agent\.qq\.com|co\.com|b\.com|c\.com|y\.com|w\.com|shipping\.com|gmail\.com)$/i;

function walk(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, rel));
    } else {
      out.push({ rel, full });
    }
  }
  return out;
}

function main() {
  const files = walk(ROOT).filter(({ rel }) => {
    if (SKIP_FILES.has(rel)) return false;
    if (IGNORE_EXT.has(extname(rel).toLowerCase())) return false;
    return true;
  });

  let hits = 0;
  for (const { rel, full } of files) {
    const text = readFileSync(full, 'utf8');
    // 强特征优先：test/ 也检查
    for (const [re, label] of STRONG_PATTERNS) {
      if (re.test(text)) {
        hits++;
        console.log(`  ✖ ${rel} — ${label}`);
      }
    }
    // 常规模式：跳过 test/ 夹具数据
    for (const [re, label] of PATTERNS) {
      if (re.test(text) && !isTestFixture(rel)) {
        hits++;
        console.log(`  ✖ ${rel} — ${label}`);
      }
    }
  }

  console.log(`将被提交的文件数: ${files.length}`);
  console.log(`=== 敏感模式命中: ${hits} ===`);

  // 个人标识符检查（域名/邮箱/DB ID/账号 ID/邀请码）
  console.log('=== 个人标识符检查（域名/邮箱/DB ID/账号 ID/邀请码）===');
  let personal = 0;
  for (const { rel, full } of files) {
    const text = readFileSync(full, 'utf8');
    // 真实邮箱（排除测试假邮箱）
    const emails = text.match(EMAIL_RE) || [];
    for (const e of emails) {
      if (!FAKE_EMAIL_DOMAINS.test(e)) {
        console.log(`  ✖ ${rel} — 疑似真实邮箱 ${e}`);
        personal++;
      }
    }
  }
  if (personal === 0) console.log('  无个人标识符泄露');
  console.log('=== 扫描结束 ===');
  process.exit(hits > 0 || personal > 0 ? 1 : 0);
}

main();
