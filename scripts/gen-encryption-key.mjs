// 生成 TOKEN_ENCRYPTION_KEY（base64 32 字节），写入 wrangler secret 或 .dev.vars
import { randomBytes } from 'node:crypto';
console.log(randomBytes(32).toString('base64'));
