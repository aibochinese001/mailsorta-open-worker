/**
 * 极简 SMTP 客户端（Cloudflare Workers connect + TLS，零依赖）。
 * 兼容 QQ 邮箱 SMTP（smtp.qq.com:465，授权码 AUTH LOGIN）。
 * 配置存 D1 settings 表（管理后台维护）：smtp_host/smtp_port/smtp_secure/smtp_user/smtp_pass/smtp_from。
 * 未配置时 sendMail 返回 { sent: false, reason: 'not_configured' }，不抛错。
 */
import type { Env } from '../env';
import { getSetting } from '../db/queries';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export async function getSmtpConfig(env: Env): Promise<SmtpConfig | null> {
  const host = (await getSetting(env.DB, 'smtp_host')) ?? '';
  const user = (await getSetting(env.DB, 'smtp_user')) ?? '';
  const pass = (await getSetting(env.DB, 'smtp_pass')) ?? '';
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number((await getSetting(env.DB, 'smtp_port')) ?? '465') || 465,
    secure: ((await getSetting(env.DB, 'smtp_secure')) ?? '1') === '1',
    user,
    pass,
    from: (await getSetting(env.DB, 'smtp_from')) ?? `MailSorta <${user}>`,
  };
}

/** RFC2047 编码主题（中文） */
export function encodeSubject(subject: string): string {
  const enc = new TextEncoder();
  let bin = '';
  for (const b of enc.encode(subject)) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

/** 组装一封 MIME 邮件（纯函数，可单测） */
export function buildSmtpMessage(from: string, to: string, subject: string, html: string): string {
  const enc = new TextEncoder();
  let bin = '';
  for (const b of enc.encode(html)) bin += String.fromCharCode(b);
  const lines = [
    `From: ${from}`,
    `To: <${to}>`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    btoa(bin),
  ];
  return lines.join('\r\n');
}

export interface MailResult {
  sent: boolean;
  reason?: string;
}

/** 真实发送（仅在 Worker 运行时可用；vitest 不会执行到 connect） */
export async function sendMail(env: Env, cfg: SmtpConfig, to: string, subject: string, html: string): Promise<MailResult> {
  try {
    const { connect } = await import('cloudflare:sockets');
    const socket = connect(
      { hostname: cfg.host, port: cfg.port },
      { secureTransport: cfg.secure ? 'on' : 'off' } as Parameters<typeof connect>[1],
    );
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    const enc = new TextEncoder();
    const timeout = AbortSignal.timeout(20_000);
    let closed = false;
    const closeTimer = setTimeout(() => {
      if (!closed) {
        try { socket.close(); } catch { /* ignore */ }
      }
    }, 20_000);
    timeout.addEventListener('abort', () => {
      if (!closed) {
        try { socket.close(); } catch { /* ignore */ }
      }
    });

    let buf = '';
    async function readResponse(): Promise<string> {
      const lines: string[] = [];
      for (;;) {
        while (!buf.includes('\n')) {
          const r = await reader.read();
          if (r.done) return lines.join(' | '); // 连接关闭，返回已有内容
          buf += new TextDecoder().decode(r.value);
        }
        const nl = buf.indexOf('\n');
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        lines.push(line);
        // 多行响应以 "code-" 续行
        if (line.length >= 4 && line[3] === '-') continue;
        break;
      }
      return lines.join(' | ');
    }

    async function cmd(line: string): Promise<string> {
      await writer.write(enc.encode(line + '\r\n'));
      return readResponse();
    }

    try {
      await readResponse(); // 220 欢迎
      await cmd(`EHLO mailsorta.local`);
      await cmd('AUTH LOGIN');
      await cmd(btoa(cfg.user));
      const authRes = await cmd(btoa(cfg.pass));
      if (!/^235/.test(authRes)) return { sent: false, reason: 'auth_failed' };
      await cmd(`MAIL FROM:<${cfg.from.replace(/^.*<|>.*$/g, '')}>`);
      const rcptRes = await cmd(`RCPT TO:<${to}>`);
      if (!/^2\d\d/.test(rcptRes)) return { sent: false, reason: 'recipient_rejected' };
      const dataRes = await cmd('DATA');
      if (!/^354/.test(dataRes)) return { sent: false, reason: 'data_rejected' };
      const body = buildSmtpMessage(cfg.from, to, subject, html);
      await writer.write(enc.encode(body + '\r\n.\r\n'));
      const finalRes = await readResponse();
      if (!/^2\d\d/.test(finalRes)) return { sent: false, reason: 'message_rejected' };
      try { await cmd('QUIT'); } catch { /* ignore */ }
      return { sent: true };
    } finally {
      clearTimeout(closeTimer);
      closed = true;
      try { socket.close(); } catch { /* ignore */ }
    }
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 发送一封模板邮件；SMTP 未配置时静默跳过（调用方决定是否告警） */
export async function sendTemplateMail(env: Env, to: string, subject: string, html: string): Promise<MailResult> {
  const cfg = await getSmtpConfig(env);
  if (!cfg) return { sent: false, reason: 'not_configured' };
  return sendMail(env, cfg, to, subject, html);
}

// ---------------- 邮件模板 ----------------

export function verifyCodeMail(code: string, minutes: number): { subject: string; html: string } {
  return {
    subject: '【MailSorta】验证码',
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e4e3dd;border-radius:12px;">
      <h2 style="margin:0 0 12px;color:#1a1b1c;">MailSorta 邮箱验证</h2>
      <p style="color:#444;line-height:1.6;">您的验证码是：</p>
      <p style="font-size:30px;font-weight:700;letter-spacing:6px;color:#2f6f9f;margin:12px 0;">${code}</p>
      <p style="color:#888;font-size:13px;">验证码 ${minutes} 分钟内有效。若非本人操作，请忽略本邮件。</p>
    </div>`,
  };
}

export function paymentSuccessMail(planName: string, untilText: string): { subject: string; html: string } {
  return {
    subject: '【MailSorta】支付成功',
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e4e3dd;border-radius:12px;">
      <h2 style="margin:0 0 12px;color:#1a1b1c;">支付成功 🎉</h2>
      <p style="color:#444;line-height:1.6;">您已开通 <b>${planName}</b> 会员。</p>
      <p style="color:#444;line-height:1.6;">会员有效期至：<b style="color:#2f6f9f;">${untilText}</b></p>
      <p style="color:#888;font-size:13px;">感谢您对 MailSorta 的支持。</p>
    </div>`,
  };
}
