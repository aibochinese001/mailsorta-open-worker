/** 密码哈希与校验（PBKDF2-SHA256）。
 * 注意：Cloudflare Workers WebCrypto 的 PBKDF2 迭代上限为 100,000（Node 本地无此限制），
 * 为兼容生产环境，统一使用 100,000 次迭代。哈希格式内置迭代数，未来可平滑升级。 */

const ITERATIONS = 100_000;
const encoder = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

export function bytesFromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 生成 hashSpec：pbkdf2-sha256$iterations$saltB64$hashB64（与 scripts/gen-password-hash.mjs 同格式） */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, key, 256);
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

export async function verifyPassword(hashSpec: string, password: string): Promise<boolean> {
  const parts = hashSpec.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  const salt = bytesFromB64(parts[2]);
  const expected = parts[3];

  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  const actual = b64(new Uint8Array(bits));

  // 恒定时间比较
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function isValidPassword(p: string): boolean {
  return typeof p === 'string' && p.length >= 8 && p.length <= 128;
}
