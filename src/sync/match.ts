/** 发件人本地匹配：连接器拉回候选后，由这里做最终裁决 */

export function matchSender(pattern: string, mode: 'exact' | 'domain' | 'regex', address: string): boolean {
  if (!address) return false;
  const addr = address.trim().toLowerCase();
  const p = pattern.trim().toLowerCase();

  if (mode === 'exact') return addr === p;
  if (mode === 'domain') {
    const base = p.startsWith('@') ? p.slice(1) : p;
    return addr === base || addr.endsWith(`@${base}`) || addr.endsWith(`.${base}`);
  }
  if (mode === 'regex') {
    try {
      return new RegExp(pattern, 'i').test(address);
    } catch {
      return false;
    }
  }
  return false;
}
