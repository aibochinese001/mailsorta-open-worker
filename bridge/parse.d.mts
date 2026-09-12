/** agently-cli 输出解析（纯函数） */
export function parseCliOutput(out: unknown): Record<string, unknown> | unknown[] | { raw: string };
