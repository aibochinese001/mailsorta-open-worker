/**
 * agently-cli 输出解析（纯函数，供 bridge/index.mjs 与测试使用）。
 *
 * agently-cli 的行为：
 *  - 单对象输出（如 +me）：整段 JSON，形如 {"email": "...", ...}
 *  - 列表输出（如 message +list）：每封邮件一行 NDJSON，形如 {"message": {"message_id": "msg_xxx", ...}}
 *  - 出错时：stderr 单行 JSON（runCli 已抛错），stdout 可能为空或非 JSON
 *
 * 解析策略：
 *  1. 整段 JSON.parse 成功 → 原样返回（对象或数组）
 *  2. 失败则按行解析 NDJSON，收集每行的 ".message ?? 行本体"
 *  3. 仍无有效行 → 返回 { raw: 截断的输出 }，调用方据此报错
 */
export function parseCliOutput(out) {
  const trimmed = String(out ?? '').trim();
  if (!trimmed) return { raw: '' };

  // 1) 整段 JSON（对象 / 数组）
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object') return parsed;
    return { raw: trimmed };
  } catch {
    /* 落到 NDJSON 分支 */
  }

  // 2) NDJSON：每行一个 JSON 对象
  const items = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try {
      const obj = JSON.parse(l);
      if (obj === null) continue;
      items.push(obj && typeof obj === 'object' && 'message' in obj ? obj.message : obj);
    } catch {
      /* 跳过非 JSON 行（如 CLI 提示文本） */
    }
  }
  if (items.length > 0) return items;

  // 3) 兜底：无法解析
  return { raw: trimmed.slice(0, 500) };
}
