import { config } from './config.js';
import { db } from './supabase.js';

const cache = new Map();
const CACHE_MS = 60 * 1000;

/**
 * FR-1: every API call (except /api/config) must carry the researcher's Supabase access token.
 * The token is verified with Supabase Auth; set AUTH_DISABLED=true only for local experiments.
 */
export async function requireUser(req, res, next) {
  if (config.authDisabled) {
    req.user = null;
    return next();
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Please sign in.' });
  const hit = cache.get(token);
  if (hit && hit.expires > Date.now()) {
    req.user = hit.user;
    return next();
  }
  try {
    const { data, error } = await db().auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    const user = { id: data.user.id, email: data.user.email };
    cache.set(token, { user, expires: Date.now() + CACHE_MS });
    if (cache.size > 1000) for (const [k, v] of cache) if (v.expires < Date.now()) cache.delete(k);
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

/** Short, stable pseudonym for a public author name (FR-26). Same algorithm as the client. */
export function pseudonym(author) {
  const s = String(author || '').trim().toLowerCase();
  if (!s) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `Author-${h.toString(16).padStart(8, '0').slice(0, 6)}`;
}
