import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../src/crypto/token';

// 32 字节 base64（测试固定密钥）
const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

describe('token 加解密', () => {
  it('AES-256-GCM 往返一致', async () => {
    const secret = 'ya29.refresh-token-测试-1234567890';
    const enc = await encryptSecret(KEY, secret);
    expect(enc).not.toContain('ya29');
    const dec = await decryptSecret(KEY, enc);
    expect(dec).toBe(secret);
  });

  it('密文每次不同（随机 IV）', async () => {
    const a = await encryptSecret(KEY, 'same');
    const b = await encryptSecret(KEY, 'same');
    expect(a).not.toBe(b);
  });

  it('篡改密文导致解密失败', async () => {
    const enc = await encryptSecret(KEY, 'hello');
    const tampered = (enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA'));
    await expect(decryptSecret(KEY, tampered)).rejects.toThrow();
  });
});
