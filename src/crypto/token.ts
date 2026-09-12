/**
 * 令牌静态加密：AES-256-GCM。
 * refresh token 等长期凭据必须先加密再落 D1；
 * 密钥 TOKEN_ENCRYPTION_KEY 为 base64 编码的 32 字节随机数（见 scripts/gen-encryption-key.mjs）。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToBytes(secret), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(secret: string, plaintext: string): Promise<string> {
  const key = await getKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
  const cipherBytes = new Uint8Array(cipher);
  const out = new Uint8Array(iv.length + cipherBytes.length);
  out.set(iv, 0);
  out.set(cipherBytes, iv.length);
  return bytesToBase64(out);
}

export async function decryptSecret(secret: string, payload: string): Promise<string> {
  const key = await getKey(secret);
  const raw = base64ToBytes(payload);
  const iv = raw.subarray(0, 12);
  const cipher = raw.subarray(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return decoder.decode(plain);
}
