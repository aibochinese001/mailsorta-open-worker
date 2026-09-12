import type { Env } from '../env';
import { getUserById } from '../db/queries';
import { decryptSecret } from '../crypto/token';

/**
 * 用户级 LLM 提取配置：每个用户在自己的「账户设置 → AI 提取」中配置
 * 自己的 OpenAI 兼容端点（URL / 模型 / API Key），处理自己规则中的 LLM 字段。
 * API Key 以 AES-256-GCM 加密落库（llm_api_key_enc），读取时解密。
 * 未配置的用户，其 LLM 字段在同步时置空。
 */
export interface LlmConfig {
  api_url: string;
  api_key: string;
  model: string;
}

export async function getLlmConfig(env: Env, userId: string): Promise<LlmConfig | null> {
  const user = await getUserById(env.DB, userId);
  if (!user) return null;
  const apiUrl = user.llm_api_url?.trim() ?? '';
  const keyEnc = user.llm_api_key_enc ?? '';
  if (!apiUrl || !keyEnc) return null;
  let apiKey: string;
  try {
    apiKey = await decryptSecret(env.TOKEN_ENCRYPTION_KEY ?? '', keyEnc);
  } catch {
    return null;
  }
  return { api_url: apiUrl, api_key: apiKey, model: user.llm_model?.trim() || 'gpt-4o-mini' };
}
