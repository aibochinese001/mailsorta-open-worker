import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { AppBindings, Env } from '../env';
import { getUserById } from '../db/queries';
import type { UserRow } from '../db/types';
import { HttpError } from './errors';

const COOKIE_NAME = 'ms_session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function bytesFromB64(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SessionPayload {
  sub: string; // user id
  role: 'user' | 'admin';
  exp: number;
}

export async function createSessionToken(secret: string, sub: string, role: 'user' | 'admin'): Promise<string> {
  const payload: SessionPayload = { sub, role, exp: Date.now() + SESSION_TTL_MS };
  const encoded = b64url(encoder.encode(JSON.stringify(payload)));
  const sig = await hmacHex(secret, encoded);
  return `${encoded}.${sig}`;
}

export async function verifySessionToken(secret: string, token: string): Promise<SessionPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = await hmacHex(secret, payload);
  if (expected !== sig) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytesFromB64(payload))) as SessionPayload;
    if (typeof parsed.sub !== 'string' || !parsed.exp || parsed.exp <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseCookie(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function getSession(c: Context<AppBindings>): string | undefined {
  return parseCookie(c.req.header('cookie'))[COOKIE_NAME];
}

export function setSessionCookie(c: Context<AppBindings>, token: string): void {
  c.header('set-cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

export function clearSessionCookie(c: Context<AppBindings>): void {
  c.header('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** 会话解析（不强制）——返回会话载荷或 null */
export async function currentSession(c: Context<AppBindings>): Promise<SessionPayload | null> {
  const token = getSession(c);
  if (!token) return null;
  return verifySessionToken(c.env.SESSION_SECRET ?? '', token);
}

/** 登录用户中间件：注入 c.get('user') */
export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  const session = await currentSession(c);
  if (!session) return c.json({ error: '未登录或登录已过期', code: 'AUTH_REQUIRED' }, 401);
  const user = await getUserById(c.env.DB, session.sub);
  if (!user || user.status !== 'active') {
    return c.json({ error: '账号不存在或已被禁用', code: 'AUTH_REQUIRED' }, 401);
  }
  c.set('user', { id: user.id, role: user.role, email: user.email });
  await next();
});

/** 管理员中间件（必须叠加在 requireAuth 之后使用） */
export const requireAdmin = createMiddleware<AppBindings>(async (c, next) => {
  const u = c.get('user');
  if (!u || u.role !== 'admin') throw new HttpError(403, '需要管理员权限');
  await next();
});

export interface SessionUser {
  id: string;
  role: UserRow['role'];
  email: string;
}

export function getUser(c: Context<AppBindings>): SessionUser {
  const u = c.get('user');
  if (!u) throw new HttpError(401, '未登录');
  return u;
}
