// Proves the built shell is safe to publish: routable on Pages, no evidence, no privileged key.
// The words "service_role" and "sb_secret_" legitimately appear once in the bundle - inside the guard
// that REFUSES such keys (src/lib/env.ts) - so this looks for key MATERIAL, not for the words.
//
//   node scripts/check-bundle.ts [base path, default /nz-election-evidence/]
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
  }
  return problems
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
  const base = process.argv[2] ?? '/nz-election-evidence/'
  const problems: string[] = []
  for (const required of ['index.html', '404.html', '.nojekyll']) if (!existsSync(join(dist, required))) problems.push(`missing dist/${required}`)
  if (problems.length === 0) {
    const index = readFileSync(join(dist, 'index.html'), 'utf-8')
    if (index !== readFileSync(join(dist, '404.html'), 'utf-8')) problems.push('404.html is not a copy of index.html (SPA refresh would break)')
    if (!index.includes(`${base}assets/`)) problems.push(`index.html does not load assets from ${base}`)
    if (!/http-equiv="Content-Security-Policy"/i.test(index)) problems.push('no content security policy')
    const files = walk(dist).filter((f) => /\.(js|css|html|json|map|txt)$/.test(f)).map((f) => ({ name: f.slice(dist.length + 1), text: readFileSync(f, 'utf-8') }))
    problems.push(...bundleProblems(files))
  }
  if (problems.length) {
    for (const p of problems) console.error(`check-bundle: ${p}`)
    process.exit(1)
  }
  console.log('check-bundle: routable on Pages; no evidence, private names or privileged key material')
}
