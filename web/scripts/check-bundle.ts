// Proves the built shell is safe to publish: routable on Pages, no evidence, no privileged key.
// The words "service_role" and "sb_secret_" legitimately appear once in the bundle - inside the guard
// that REFUSES such keys (src/lib/env.ts) - so this looks for key MATERIAL, not for the words.
//
//   VITE_BASE_PATH=/nz-election-evidence/ node scripts/check-bundle.ts   (same variable and default as the build)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function bundleProblems(files: ReadonlyArray<{ name: string; text: string }>): string[] {
  const problems: string[] = []
  for (const { name, text } of files) {
    if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) problems.push(`${name}: secret-style key material`)
    for (const match of text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g)) {
      try {
        const payload = JSON.parse(Buffer.from(match[1] ?? '', 'base64url').toString('utf-8')) as { role?: string }
        if (payload.role !== 'anon') problems.push(`${name}: embedded token with role "${String(payload.role)}" (only the anon key may ship)`)
      } catch {
        problems.push(`${name}: undecodable embedded token`)
      }
    }
    if (/evidence_private|evidence_views|postgres(ql)?:\/\//.test(text)) problems.push(`${name}: private schema name or connection string`)
    if (/TEST FIXTURE (Bill|Release|members)/.test(text)) problems.push(`${name}: fixture evidence in the bundle`)
    // Names of the server-side settings. Their values live in function secrets and Vault, never in a build.
    if (/EVIDENCE_INGEST_DB_URL|EVIDENCE_CRON_SECRET|SERVICE_ROLE_KEY|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD/.test(text)) problems.push(`${name}: names a server-side secret setting`)
  }
  return problems
}

/**
 * A CONNECTED release build (--require-connected): the bundle must carry exactly the public pair and nothing else.
 *   - one https API origin in connect-src, and it is the configured project URL
 *   - a public key is present: a publishable key, or a token whose role is "anon"
 *   - a token that names a project ("ref") names the SAME project as the URL, so a key can never be paired with
 *     another project by accident
 * Privileged material is already refused by bundleProblems; this proves the shell is connected with the public pair only.
 */
export function connectedProblems(files: ReadonlyArray<{ name: string; text: string }>, indexHtml: string, configuredUrl: string | undefined): string[] {
  const problems: string[] = []
  let origin: URL | null = null
  try {
    origin = configuredUrl ? new URL(configuredUrl) : null
  } catch {
    origin = null
  }
  if (!origin || origin.protocol !== 'https:') return ['a connected build needs VITE_SUPABASE_URL set to the https project URL']
  if (origin.username || origin.password || origin.search || origin.pathname.replace(/\/+$/, '') !== '') problems.push('VITE_SUPABASE_URL must be the bare project URL: no credentials, path or query')
  const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(indexHtml)?.[1] ?? /content="([^"]*)"\s+http-equiv="Content-Security-Policy"/i.exec(indexHtml)?.[1] ?? ''
  const connect = (policy.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')) ?? '').split(/\s+/).slice(1)
  const remote = connect.filter((o) => /^[a-z]+:\/\//i.test(o))
  if (remote.length !== 1 || remote[0] !== origin.origin) problems.push(`connect-src must allow exactly the project origin ${origin.origin} (found: ${remote.join(' ') || 'none'})`)
  const all = files.map((f) => f.text).join('\n')
  const projectRef = /^([a-z0-9]{16,})\.supabase\.co$/.exec(origin.hostname)?.[1] ?? null
  let publicKeys = (all.match(/sb_publishable_[A-Za-z0-9_-]{8,}/g) ?? []).length
  for (const match of all.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g)) {
    try {
      const payload = JSON.parse(Buffer.from(match[1] ?? '', 'base64url').toString('utf-8')) as { role?: string; ref?: string }
      if (payload.role === 'anon') publicKeys += 1
      if (payload.ref && projectRef && payload.ref !== projectRef) problems.push('the embedded key belongs to a different project than the configured URL')
    } catch {
      // bundleProblems reports undecodable tokens
    }
  }
  if (publicKeys === 0) problems.push('a connected build needs the public anon (or publishable) key; none is in the bundle')
  if (!all.includes(origin.origin)) problems.push('the configured project URL is not in the bundle (built without it?)')
  return problems
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

/**
 * The shipped policy may only let the page talk over TLS. Any http:// or ws:// origin in connect-src fails the
 * check; the single exception is a loopback origin in a build explicitly marked as a local test stack build.
 */
export function cspTransportProblems(indexHtml: string, localTestStack: boolean): string[] {
  const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(indexHtml)?.[1] ?? /content="([^"]*)"\s+http-equiv="Content-Security-Policy"/i.exec(indexHtml)?.[1]
  if (!policy) return []
  const connect = policy.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')) ?? ''
  const insecure = connect.split(/\s+/).filter((o) => /^(http|ws):\/\//i.test(o))
  const allowed = (o: string) => localTestStack && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(o)
  return insecure.filter((o) => !allowed(o)).map((o) => `content security policy allows an unencrypted connection (${o}); production builds are https only`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
  // Same source and same default as vite.config.ts, so the check always matches what was built.
  const raw = (process.env.VITE_BASE_PATH ?? '/').trim()
  const base = raw === '' || raw === '/' ? '/' : `/${raw.replace(/^\/+|\/+$/g, '')}/`
  const problems: string[] = []
  for (const required of ['index.html', '404.html', '.nojekyll']) if (!existsSync(join(dist, required))) problems.push(`missing dist/${required}`)
  if (problems.length === 0) {
    const index = readFileSync(join(dist, 'index.html'), 'utf-8')
    if (index !== readFileSync(join(dist, '404.html'), 'utf-8')) problems.push('404.html is not a copy of index.html (SPA refresh would break)')
    // Anchored on the attribute, so "/assets/" cannot pass for a build made under another base path.
    const assetRefs = [...index.matchAll(/(?:src|href)="([^"]*assets\/[^"]+)"/g)].map((m) => m[1] ?? '')
    if (assetRefs.length === 0 || !assetRefs.every((ref) => ref.startsWith(`${base}assets/`))) {
      problems.push(`index.html does not load every asset from ${base}assets/ (built for a different base path?)`)
    }
    if (!/http-equiv="Content-Security-Policy"/i.test(index)) problems.push('no content security policy')
    problems.push(...cspTransportProblems(index, process.env.VITE_LOCAL_TEST_STACK === '1'))
    const files = walk(dist).filter((f) => /\.(js|css|html|json|map|txt)$/.test(f)).map((f) => ({ name: f.slice(dist.length + 1), text: readFileSync(f, 'utf-8') }))
    problems.push(...bundleProblems(files))
    if (process.argv.includes('--require-connected')) problems.push(...connectedProblems(files, index, process.env.VITE_SUPABASE_URL))
  }
  if (problems.length) {
    for (const p of problems) console.error(`check-bundle: ${p}`)
    process.exit(1)
  }
  console.log(`check-bundle: routable on Pages; no evidence, private names or privileged key material${process.argv.includes('--require-connected') ? '; connected with the public URL and public key only' : ''}`)
}
