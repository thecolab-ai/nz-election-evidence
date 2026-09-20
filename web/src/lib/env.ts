/** Runtime configuration, read once from build-time public variables. No secrets belong here. */

export interface AppConfig {
  supabaseUrl: string
  supabaseAnonKey: string
}

export interface RawEnv {
  VITE_SUPABASE_URL?: string | undefined
  VITE_SUPABASE_ANON_KEY?: string | undefined
  VITE_BASE_PATH?: string | undefined
  /** '1' ONLY for the local test stack: permits plain http, and then only to a loopback address. */
  VITE_LOCAL_TEST_STACK?: string | undefined
}

/**
 * https always. Plain http would send every read and the anon key in clear text and widen the CSP, so it is
 * accepted in exactly one configuration: the build was explicitly marked as a local test stack build AND the
 * address is loopback. A production build never sets the flag, and the flag cannot make a remote http URL valid.
 */
export function isAcceptableApiUrl(parsed: URL, localTestStack: boolean): boolean {
  if (parsed.protocol === 'https:') return true
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
  return parsed.protocol === 'http:' && localTestStack && loopback
}

const PLACEHOLDER_PATTERN = /your-project-ref|your-public-anon/i

/** Returns null unless both values are present, well formed and not the example placeholders. */
export function resolveConfig(env: RawEnv): AppConfig | null {
  const url = env.VITE_SUPABASE_URL?.trim() ?? ''
  const key = env.VITE_SUPABASE_ANON_KEY?.trim() ?? ''
  if (!url || !key) return null
  if (PLACEHOLDER_PATTERN.test(url) || PLACEHOLDER_PATTERN.test(key)) return null
  try {
    const parsed = new URL(url)
    if (!isAcceptableApiUrl(parsed, env.VITE_LOCAL_TEST_STACK === '1')) return null
  } catch {
    return null
  }
  if (looksLikeServiceRoleKey(key)) return null
  // Only a PUBLIC key may run in a browser: a publishable key, or a token whose role is exactly "anon".
  if (!isPublicBrowserKey(key)) return null
  return { supabaseUrl: url.replace(/\/+$/, ''), supabaseAnonKey: key }
}

/**
 * Refuse to run with a privileged key. A JWT-style key carries its role in the payload;
 * new-style keys carry it in the prefix. Anything privileged is treated as "not configured".
 */
export function looksLikeServiceRoleKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true
  const parts = key.split('.')
  if (parts.length !== 3 || !parts[1]) return false
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
    const payload = JSON.parse(json) as { role?: unknown }
    return payload.role === 'service_role' || payload.role === 'supabase_admin'
  } catch {
    return false
  }
}

/** The role claim of a JWT-style key, or null when the key is not a decodable JWT. */
export function keyRole(key: string): string | null {
  const parts = key.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: unknown }
    return typeof payload.role === 'string' ? payload.role : null
  } catch {
    return null
  }
}

/** Allowlist, not blocklist: a new-style publishable key, or a JWT whose role is exactly "anon". Anything else is refused. */
export function isPublicBrowserKey(key: string): boolean {
  if (looksLikeServiceRoleKey(key)) return false
  if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(key)) return true
  return keyRole(key) === 'anon'
}

/** Router basepath: no trailing slash except for root. */
export function routerBasePath(baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? '/').trim()
  if (trimmed === '' || trimmed === '/' || trimmed === './') return '/'
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

export const appConfig: AppConfig | null = resolveConfig(import.meta.env as RawEnv)
export const basePath: string = routerBasePath(import.meta.env.BASE_URL)
