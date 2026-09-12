import { getSetting } from '../db/queries';
import type { Env } from '../env';

/**
 * OAuth / 桥接层凭据统一读取。
 * 开源部署友好：优先读管理后台设置（settings 表，管理员可在 UI 配置），
 * 未配置时回退环境变量 / Secrets（兼容传统部署方式）。
 */
export interface OAuthConfig {
  google_client_id: string;
  google_client_secret: string;
  microsoft_client_id: string;
  microsoft_client_secret: string;
  agently_bridge_url: string;
  agently_bridge_token: string;
}

export async function getOauthConfig(env: Env): Promise<OAuthConfig> {
  const [gid, gsec, mid, msec, burl, btoken] = await Promise.all([
    getSetting(env.DB, 'google_client_id'),
    getSetting(env.DB, 'google_client_secret'),
    getSetting(env.DB, 'microsoft_client_id'),
    getSetting(env.DB, 'microsoft_client_secret'),
    getSetting(env.DB, 'agently_bridge_url'),
    getSetting(env.DB, 'agently_bridge_token'),
  ]);
  return {
    google_client_id: gid || env.GOOGLE_CLIENT_ID || '',
    google_client_secret: gsec || env.GOOGLE_CLIENT_SECRET || '',
    microsoft_client_id: mid || env.MICROSOFT_CLIENT_ID || '',
    microsoft_client_secret: msec || env.MICROSOFT_CLIENT_SECRET || '',
    agently_bridge_url: burl || env.AGENTLY_BRIDGE_URL || '',
    agently_bridge_token: btoken || env.AGENTLY_BRIDGE_TOKEN || '',
  };
}

/** 校验 Google / Microsoft 凭据是否完整 */
export function hasOauthCreds(cfg: OAuthConfig, provider: 'gmail' | 'outlook'): boolean {
  if (provider === 'gmail') return !!(cfg.google_client_id && cfg.google_client_secret);
  return !!(cfg.microsoft_client_id && cfg.microsoft_client_secret);
}
