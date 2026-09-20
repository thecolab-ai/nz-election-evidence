/**
 * Local-only helpers for the end-to-end tests. Keys are read from the running local
 * Supabase CLI stack at test time, held in memory / process env only, never printed and
 * never written to disk. The service-role key is used ONLY here (test setup), never by the app.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const webRoot = resolve(here, '..', '..')
export const repoRoot = resolve(webRoot, '..')

export const LOCAL_API_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:55321'
const DB_CONTAINER_HINT = 'supabase_db_nz-election-evidence-local'

export interface LocalKeys {
  anonKey: string
  serviceRoleKey: string
}

function assertLocal(url: string): void {
  const host = new URL(url).hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`Refusing to run e2e setup against a non-local API host (${host}).`)
  }
}

/** Parses `supabase status -o env`. Cached in process env so workers do not shell out again. */
export function localKeys(): LocalKeys {
  assertLocal(LOCAL_API_URL)
  if (process.env.E2E_ANON_KEY && process.env.E2E_SERVICE_ROLE_KEY) {
    return { anonKey: process.env.E2E_ANON_KEY, serviceRoleKey: process.env.E2E_SERVICE_ROLE_KEY }
  }
  let output: string
  try {
    output = execFileSync('supabase', ['status', '-o', 'env'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    throw new Error('Could not read the local Supabase stack status. Is the local stack running? (`supabase status` from the repository root)')
  }
  const values = new Map<string, string>()
  for (const line of output.split('\n')) {
    const match = /^([A-Z_]+)="?([^"]*)"?$/.exec(line.trim())
    if (match?.[1] && match[2] !== undefined) values.set(match[1], match[2])
  }
  const anonKey = values.get('ANON_KEY')
  const serviceRoleKey = values.get('SERVICE_ROLE_KEY')
  const apiUrl = values.get('API_URL')
  if (!anonKey || !serviceRoleKey) throw new Error('ANON_KEY / SERVICE_ROLE_KEY missing from the local stack status output.')
  if (apiUrl) assertLocal(apiUrl)
  process.env.E2E_ANON_KEY = anonKey
  process.env.E2E_SERVICE_ROLE_KEY = serviceRoleKey
  return { anonKey, serviceRoleKey }
}

export function dbContainer(): string {
  if (process.env.E2E_DB_CONTAINER) return process.env.E2E_DB_CONTAINER
  const names = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).split('\n')
  const name = names.find((n) => n.includes(DB_CONTAINER_HINT))
  if (!name) throw new Error(`No running container whose name contains ${DB_CONTAINER_HINT}.`)
  process.env.E2E_DB_CONTAINER = name
  return name
}

/** Runs SQL inside the local database container. Input goes over stdin; output is returned trimmed. */
export function psql(sql: string, variables: Record<string, string> = {}): string {
  const args = ['exec', '-i', dbContainer(), 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q']
  for (const [key, value] of Object.entries(variables)) args.push('-v', `${key}=${value}`)
  return execFileSync('docker', args, { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

/**
 * Chromium for the tests. No browser is downloaded: an already-cached build is reused.
 * Order: PLAYWRIGHT_CHROMIUM_PATH, then the newest chromium-* under the Playwright cache.
 */
export function chromiumExecutable(): string | undefined {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_PATH
  if (explicit) {
    if (!existsSync(explicit)) throw new Error('PLAYWRIGHT_CHROMIUM_PATH does not point at a file.')
    return explicit
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? process.env.PLAYWRIGHT_BROWSERS_PATH : join(homedir(), '.cache', 'ms-playwright')
  if (!existsSync(cache)) return undefined
  const builds = readdirSync(cache)
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
  for (const build of builds) {
    for (const layout of ['chrome-linux64', 'chrome-linux']) {
      const candidate = join(cache, build[0], layout, 'chrome')
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

export const FIXTURE_INSPECTOR_EMAIL = 'fixture-inspector@example.invalid'
export const FIXTURE_ORDINARY_EMAIL = 'fixture-ordinary@example.invalid'
