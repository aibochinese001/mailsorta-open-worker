// 生成密码哈希：用法 node scripts/gen-password-hash.mjs [密码]
// 不传密码时从环境变量 MAILSORTA_PASSWORD 读取；都缺省则随机生成并打印。
// 迭代数必须与 src/crypto/password.ts 一致（Workers WebCrypto 上限 100,000）。
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const password = process.argv[2] || process.env.MAILSORTA_PASSWORD || randomBytes(12).toString('base64url');
const iterations = 100000;
const salt = randomBytes(16).toString('base64');
const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64');
console.log(`pbkdf2-sha256$${iterations}$${salt}$${hash}`);
if (!process.argv[2] && !process.env.MAILSORTA_PASSWORD) {
  console.error(`（已随机生成密码：${password}，请妥善保存）`);
}
