// MD5（易支付签名用）。使用久经验证的纯 JS 实现（blueimp/md5），
// 兼容 Cloudflare Workers 与 Node 测试环境（不依赖 WebCrypto 的 MD5 支持）。
import md5 from 'md5';

/** 计算字符串的 MD5（UTF-8），返回 32 位小写十六进制 */
export function md5Hex(input: string): string {
  return md5(input) as string;
}
