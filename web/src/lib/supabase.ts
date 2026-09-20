import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import { appConfig } from './env'

/** Curated, joined views for anonymous readers. */
export const PUBLIC_SCHEMA = 'evidence_public'
/** One projection per domain table for anonymous readers. */
export const OPEN_SCHEMA = 'evidence_open'

export type PublicClient = SupabaseClient<Database, typeof PUBLIC_SCHEMA>
export type PublicViewName = keyof Database['evidence_public']['Views']
export type OpenTableName = keyof Database['evidence_open']['Views']
/** Generated row shape of a curated public view. Every column is nullable, as Postgres reports for views. */
export type PublicRow<V extends PublicViewName> = Database['evidence_public']['Views'][V]['Row']

let client: PublicClient | null = null

/**
 * The single browser client: public anon key, anonymous, read-only. There is no sign-in, so no
 * session is stored, refreshed or read from the URL. Null when the build is not configured.
 */
export function getSupabase(): PublicClient | null {
  if (!appConfig) return null
  if (!client) {
    client = createClient<Database, typeof PUBLIC_SCHEMA>(appConfig.supabaseUrl, appConfig.supabaseAnonKey, {
      db: { schema: PUBLIC_SCHEMA },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  }
  return client
}

export function requireSupabase(): PublicClient {
  const c = getSupabase()
  if (!c) throw new Error('Not connected — no data source configured')
  return c
}
