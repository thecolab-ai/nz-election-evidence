/** Runtime configuration, read once from build-time public variables. No secrets belong here. */

export interface AppConfig {
  supabaseUrl: string
  supabaseAnonKey: string
}

export interface RawEnv {
  VITE_SUPABASE_URL?: string | undefined
  VITE_SUPABASE_ANON_KEY?: string | undefined
  VITE_BASE_PATH?: string | undefined
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
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  } catch {
    return null
  }
  if (looksLikeServiceRoleKey(key)) return null
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

/** Router basepath: no trailing slash except for root. */
export function routerBasePath(baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? '/').trim()
  if (trimmed === '' || trimmed === '/' || trimmed === './') return '/'
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

export const appConfig: AppConfig | null = resolveConfig(import.meta.env as RawEnv)
export const basePath: string = routerBasePath(import.meta.env.BASE_URL)
