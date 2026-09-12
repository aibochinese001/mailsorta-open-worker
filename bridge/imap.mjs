/**
 * IMAP 代理端点（QQ / 163 / 126）
 * ==============================
 * Cloudflare Worker 的出站 TCP 到国内邮箱服务器（imap.qq.com / imap.163.com 等）
 * 经常超时或被丢包；而本桥接层服务器位于可直连这些服务的网络环境，
 * 因此把 IMAP 连接动作放在桥接层执行，Worker 只传「授权码 + 查询参数」。
 *
 * 端点：
 *   POST /imap/list  { email, authCode, host, port, since?, from?, maxResults? }
 *                    → { ok, messages: [{ uid, sender, senderName, subject, receivedAt }] }
 *   POST /imap/get   { email, authCode, host, port, uid }
 *                    → { ok, message: { sender, senderName, subject, receivedAt, bodyText } }
 *                    → { ok:false, auth:true, error }  认证失败（授权码无效）
 *
 * 依赖：npm install imapflow（本机/服务器执行一次）
 */
import { ImapFlow } from 'imapflow';

/** IMAP 列表/取信：单次连接完成全部操作，超时统一 30s */
export async function imapList(params) {
  const { email, authCode, host, port, since, from, maxResults } = params;
  const client = await openImap(email, authCode, host, port);

  const search = { since: since ? new Date(since) : new Date(Date.now() - 7 * 86400_000) };
  if (from) search.from = from;

  const out = [];
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const m of client.fetch(search, { envelope: true, uid: true })) {
        const f = m.envelope?.from?.[0];
        if (!f?.address) continue;
        out.push({
          uid: m.uid,
          sender: f.address,
          senderName: f.name || undefined,
          subject: typeof m.envelope.subject === 'string' ? m.envelope.subject : Array.isArray(m.envelope.subject) ? m.envelope.subject.join('') : '',
          receivedAt: m.envelope?.date ? m.envelope.date.getTime() : Date.now(),
        });
      }
    } finally {
      await lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  out.reverse();
  const limit = Math.max(1, Number(maxResults) || 50);
  return out.slice(0, limit);
}

/** 按 UID 取一封邮件的正文文本（text/plain 优先，其次 text/html；source 回退） */
export async function imapGet(params) {
  const { email, authCode, host, port, uid } = params;
  const uidNum = Number(String(uid).replace(/^u:/, ''));
  if (!Number.isFinite(uidNum) || uidNum <= 0) return { ok: false, reason: `非法 uid: ${uid}` };
  const client = await openImap(email, authCode, host, port);

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      let envelope;
      let parts = [];
      for await (const m of client.fetch({ uid: uidNum }, { envelope: true, bodyStructure: true })) {
        envelope = m.envelope;
        collectTextParts(m.bodyStructure, parts);
      }
      if (!envelope) return { ok: false, reason: `uid ${uidNum} 不存在或已删除` };

      console.log(`[imap:get] uid=${uidNum} parts=${JSON.stringify(parts)}`);

      const preferred = parts.find((p) => p.subtype === 'plain') ?? parts[0];
      let bodyText = '';
      if (preferred) {
        for await (const m of client.fetch({ uid: uidNum }, { bodyParts: [preferred.partId] })) {
          const raw = m.bodyParts?.get(preferred.partId);
          if (raw) {
            bodyText = decodeTransfer(raw, preferred.encoding);
            console.log(`[imap:get] bodyParts 方式获取正文: partId=${preferred.partId} len=${bodyText.length}`);
          }
        }
      }

      // 回退：bodyStructure 方式未获取到正文时，用 source 获取原始邮件并解析
      if (!bodyText.trim()) {
        console.log(`[imap:get] bodyParts 方式为空，尝试 source 回退`);
        for await (const m of client.fetch({ uid: uidNum }, { source: true })) {
          const raw = m.source;
          if (raw) {
            bodyText = extractTextFromRaw(raw);
            console.log(`[imap:get] source 回退获取正文: len=${bodyText.length}`);
          }
        }
      }

      const f = envelope.from?.[0] ?? {};
      // HTML 正文转纯文本
      const finalText = preferred?.subtype === 'html' || /<\/?[a-z][\s\S]*>/i.test(bodyText.slice(0, 500)) ? stripHtml(bodyText) : bodyText.trim();
      return {
        ok: true,
        message: {
          sender: f.address ?? '',
          senderName: f.name || undefined,
          subject: typeof envelope.subject === 'string' ? envelope.subject : Array.isArray(envelope.subject) ? envelope.subject.join('') : '',
          receivedAt: envelope.date ? envelope.date.getTime() : Date.now(),
          bodyText: finalText,
        },
      };
    } finally {
      await lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function openImap(email, authCode, host, port) {
  const p = Math.max(1, Number(port) || 993);
  const client = new ImapFlow({
    host,
    port: p,
    secure: p === 993,
    auth: { user: email, pass: authCode },
    logger: false,
    connectionTimeout: 25_000,
    greetingTimeout: 25_000,
    socketTimeout: 35_000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // imapflow 错误对象携带服务器原始响应（response）、命令（command）、响应码（responseCode）
    const serverResp = e?.response ? `；服务器响应：${String(e.response)}` : '';
    const cmd = e?.command ? `（命令：${e.command}）` : '';
    const respCode = e?.responseCode ? `；响应码：${String(e.responseCode)}` : '';
    const detail = `${cmd}${serverResp}${respCode}`;
    // 连接阶段的命令失败基本是 LOGIN 认证失败（SELECT 失败极罕见）
    if (/auth|login|credentials|AUTHENTICATIONFAILED|Invalid credentials|Command failed/i.test(msg)) {
      throw new ImapProxyAuthError(`IMAP 认证失败（请检查授权码或是否已开启 IMAP 服务）${detail}：${msg.slice(0, 120)}`);
    }
    throw new Error(`IMAP 连接失败 ${host}:${p}${detail}：${msg.slice(0, 200)}`);
  }
  return client;
}

export class ImapProxyAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImapProxyAuthError';
  }
}

function collectTextParts(node, out) {
  if (!node) return;
  if (node.partId && node.type === 'text' && (node.subtype === 'plain' || node.subtype === 'html')) {
    out.push({ partId: node.partId, subtype: node.subtype, encoding: (node.encoding ?? '').toLowerCase() });
    return;
  }
  for (const c of node.childNodes ?? []) collectTextParts(c, out);
}

function decodeTransfer(bytes, encoding) {
  const enc = String(encoding ?? '').toLowerCase();
  if (enc === 'base64') {
    const b64 = new TextDecoder('latin1').decode(bytes).replace(/\s+/g, '');
    return new TextDecoder().decode(Buffer.from(b64, 'base64'));
  }
  if (enc === 'quoted-printable') {
    const s = new TextDecoder('latin1').decode(bytes);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=') {
        const hex = s.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
        if (s[i + 1] === '\r' && s[i + 2] === '\n') {
          i += 2;
          continue;
        }
      }
      out.push(s.charCodeAt(i));
    }
    return new TextDecoder().decode(Buffer.from(out));
  }
  return new TextDecoder().decode(bytes);
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 从原始邮件源（MIME）中提取 text/plain 或 text/html 正文。
 * 简化版 MIME 解析：支持 multipart/alternative、multipart/mixed、单部分 text。
 * 用于 bodyStructure 方式失败时的回退。
 */
function extractTextFromRaw(raw) {
  try {
    const text = raw instanceof Buffer ? raw.toString('utf8') : String(raw);
    const headerEnd = text.indexOf('\r\n\r\n');
    if (headerEnd < 0) return text.trim();

    const headerText = text.slice(0, headerEnd);
    const body = text.slice(headerEnd + 4);

    // 解析 Content-Type
    const ctMatch = headerText.match(/Content-Type:\s*([^;\r\n]+)/i);
    const contentType = ctMatch ? ctMatch[1].trim().toLowerCase() : 'text/plain';
    const boundaryMatch = headerText.match(/boundary="?([^";\r\n]+)"?/i);
    const boundary = boundaryMatch ? boundaryMatch[1] : null;

    // 单部分 text
    if (contentType.startsWith('text/') && !boundary) {
      const encMatch = headerText.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
      const encoding = encMatch ? encMatch[1].trim().toLowerCase() : '';
      return decodeTransferString(body, encoding);
    }

    // multipart：分割各部分，找 text/plain 优先，其次 text/html
    if (boundary && contentType.startsWith('multipart/')) {
      const parts = body.split(`--${boundary}`).filter((p) => p && p.trim() && !p.startsWith('--'));
      let htmlText = '';
      for (const part of parts) {
        const partHeaderEnd = part.indexOf('\r\n\r\n');
        if (partHeaderEnd < 0) continue;
        const partHeader = part.slice(0, partHeaderEnd);
        const partBody = part.slice(partHeaderEnd + 4);
        const partCtMatch = partHeader.match(/Content-Type:\s*([^;\r\n]+)/i);
        const partCt = partCtMatch ? partCtMatch[1].trim().toLowerCase() : '';
        if (!partCt.startsWith('text/')) continue;
        const encMatch = partHeader.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
        const encoding = encMatch ? encMatch[1].trim().toLowerCase() : '';
        const decoded = decodeTransferString(partBody, encoding);
        if (partCt === 'text/plain') return decoded;
        if (partCt === 'text/html' && !htmlText) htmlText = decoded;
      }
      if (htmlText) return htmlText;
    }

    // 兜底：返回原始 body
    return body.trim();
  } catch (e) {
    console.error('[imap:extractRaw] 解析失败', e instanceof Error ? e.message : String(e));
    return '';
  }
}

/** 字符串版解码（用于 source 回退） */
function decodeTransferString(str, encoding) {
  const enc = String(encoding ?? '').toLowerCase();
  if (enc === 'base64') {
    try {
      const b64 = String(str).replace(/\s+/g, '');
      return Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      return String(str);
    }
  }
  if (enc === 'quoted-printable') {
    try {
      const s = String(str);
      const out = [];
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '=') {
          const hex = s.slice(i + 1, i + 3);
          if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
            out.push(parseInt(hex, 16));
            i += 2;
            continue;
          }
          if (s[i + 1] === '\r' && s[i + 2] === '\n') {
            i += 2;
            continue;
          }
        }
        out.push(s.charCodeAt(i));
      }
      return Buffer.from(out).toString('utf8');
    } catch {
      return String(str);
    }
  }
  return String(str);
}
