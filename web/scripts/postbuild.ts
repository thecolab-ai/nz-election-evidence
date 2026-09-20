// GitHub Pages has no SPA rewrite: an unknown path serves 404.html (with HTTP 404).
// Shipping a copy of index.html as 404.html lets a deep link or a reload boot the app.
// .nojekyll stops Pages from dropping files whose names start with an underscore.
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const index = join(dist, 'index.html')
if (!existsSync(index)) {
  console.error('postbuild: dist/index.html is missing; run the Vite build first.')
  process.exit(1)
}
copyFileSync(index, join(dist, '404.html'))
writeFileSync(join(dist, '.nojekyll'), '')
console.log('postbuild: wrote dist/404.html and dist/.nojekyll')
