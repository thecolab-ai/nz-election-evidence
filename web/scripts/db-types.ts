// Generates src/lib/database.types.ts from the LOCAL disposable Supabase stack, or checks it for drift.
// The generated file is the only source of row types for the explorer; CI fails when the committed
// file no longer matches the migrations.
//
//   node scripts/db-types.ts write    regenerate the committed file
//   node scripts/db-types.ts check    exit 1 if the committed file differs from a fresh generation
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const target = join(here, '..', 'src', 'lib', 'database.types.ts')
const HEADER = `// GENERATED FILE - do not edit. Regenerate with \`npm run types:generate\` (needs the local stack).
// Source: supabase gen types --local, schemas evidence_public and evidence_open (anonymous read-only).\n`

function generate(): string {
  // --local only: this script never talks to a hosted project.
  const out = execFileSync('supabase', ['gen', 'types', '--local', '--schema', 'evidence_public', '--schema', 'evidence_open'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (!out.includes('evidence_public') || !out.includes('evidence_open')) throw new Error('generation did not include both public schemas')
  return HEADER + out.trimEnd() + '\n'
}

const mode = process.argv[2]
if (mode === 'write') {
  writeFileSync(target, generate())
  console.log('db-types: wrote src/lib/database.types.ts')
} else if (mode === 'check') {
  const fresh = generate()
  const committed = readFileSync(target, 'utf-8')
  if (fresh !== committed) {
    console.error('db-types: src/lib/database.types.ts is out of date with the migrations. Run `npm run types:generate` and commit the result.')
    process.exit(1)
  }
  console.log('db-types: generated types match the migrations')
} else {
  console.error('usage: node scripts/db-types.ts write|check')
  process.exit(2)
}
