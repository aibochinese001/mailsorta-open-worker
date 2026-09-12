/**
 * 网易 163 / QQ IMAP 本地诊断脚本
 * ================================
 * 用途：在你自己的电脑上直接测试 IMAP 连接，区分是授权码问题还是桥接层 IP 风控问题。
 * 用法：
 *   cd bridge
 *   node diagnose-imap.mjs
 *   按提示输入邮箱、授权码、服务器（默认 imap.163.com:993）
 *
 * 如果本地能连接成功 → 授权码正确，问题在桥接层服务器 IP 被 163 风控
 * 如果本地也认证失败 → 授权码或账号设置有问题（按脚本输出的服务器响应排查）
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ImapFlow } from 'imapflow';

const rl = readline.createInterface({ input, output });

async function ask(q, def) {
  const a = await rl.question(def ? `${q}（默认 ${def}）：` : `${q}：`);
  return a.trim() || def;
}

console.log('\n=== IMAP 本地诊断 ===\n');
const email = await ask('邮箱地址（如 xxx@163.com）');
const authCode = await ask('授权码（163 邮箱设置里生成的客户端授权码，不是登录密码）');
const host = await ask('IMAP 服务器', 'imap.163.com');
const port = Number(await ask('端口', '993'));

console.log(`\n正在连接 ${host}:${port}，用户 ${email} ...\n`);

const client = new ImapFlow({
  host,
  port,
  secure: port === 993,
  auth: { user: email, pass: authCode },
  logger: false,
  connectionTimeout: 25_000,
  greetingTimeout: 25_000,
  socketTimeout: 35_000,
});

client.on('error', (e) => {
  // 连接失败后的 socket 超时等，忽略主错误已输出
});

try {
  await client.connect();
  console.log('✅ 连接 + 登录成功！授权码正确。');

  // 尝试列出最近 3 封邮件
  const lock = await client.getMailboxLock('INBOX');
  try {
    const messages = [];
    for await (const m of client.fetch({ all: true }, { envelope: true, uid: true })) {
      messages.push(m);
      if (messages.length >= 3) break;
    }
    console.log(`\n收件箱最近 ${messages.length} 封邮件：`);
    for (const m of messages) {
      const from = m.envelope?.from?.[0];
      console.log(`  - [uid:${m.uid}] ${from?.address ?? '(未知发件人)'}：${m.envelope?.subject ?? '(无主题)'}`);
    }
  } finally {
    await lock.release();
  }
  await client.logout();
  console.log('\n✅ 诊断完成：本地连接完全正常。如果桥接层仍报认证失败，说明是桥接层服务器 IP 被 163 风控。');
} catch (e) {
  console.log('❌ 连接失败\n');
  console.log('错误名称：', e.name);
  console.log('错误信息：', e.message);
  if (e.response) console.log('服务器响应：', e.response);
  if (e.responseCode) console.log('响应码：', e.responseCode);
  if (e.command) console.log('失败命令：', e.command);
  console.log('\n--- 诊断建议 ---');
  if (/Login error or password error/i.test(e.response ?? '')) {
    console.log('163 返回"密码错误"。请检查：');
    console.log('  1. 授权码是否复制完整（16 位字母数字，无多余空格）');
    console.log('  2. 是否在 163 邮箱「设置 → POP3/SMTP/IMAP」里真正开启了 IMAP 服务');
    console.log('  3. 授权码是否已失效（重新生成过新授权码，旧的会失效）');
    console.log('  4. 登录用户名是否是完整邮箱地址（含 @163.com）');
  } else if (/locked|frozen|disabled/i.test(e.response ?? '')) {
    console.log('163 返回账号锁定/冻结相关错误。请登录 163 网页版检查账号状态。');
  } else if (/environment|abnormal|risk/i.test(e.response ?? '')) {
    console.log('163 返回登录环境异常/风控。可能是当前 IP 被临时限制，等几分钟再试，或换网络。');
  } else {
    console.log('请把上方"服务器响应"完整内容发给开发者进一步诊断。');
  }
  process.exit(1);
} finally {
  rl.close();
}
