// Dependency-free static server that behaves like GitHub Pages for a project site:
//   - dist/ is served under the repository base path only
//   - an unknown path returns dist/404.html WITH HTTP status 404 (Pages does not rewrite)
//   - a directory path serves its index.html
// Usage: node scripts/pages-preview.ts   (PORT and PAGES_BASE may be overridden by env)
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const port = Number(process.env.PORT ?? 4173)
const host = process.env.HOST ?? '127.0.0.1'
const base = `/${(process.env.PAGES_BASE ?? '/nz-election-evidence/').replace(/^\/+|\/+$/g, '')}/`

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function send(res: ServerResponse, status: number, file: string) {
  res.writeHead(status, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  createReadStream(file).pipe(res)
}

function notFound(res: ServerResponse) {
  const fallback = join(root, '404.html')
  if (existsSync(fallback)) return send(res, 404, fallback)
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('404 Not Found')
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' })
    return res.end()
  }
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', `http://${host}`).pathname)
  } catch {
    return notFound(res)
  }
  if (pathname === base.slice(0, -1)) {
    res.writeHead(301, { Location: base })
    return res.end()
  }
  // Nothing exists outside the project base path, exactly as on Pages.
  if (!pathname.startsWith(base)) return notFound(res)

  const relative = normalize(pathname.slice(base.length)).replace(/^(\.\.(\/|\\|$))+/, '')
  let file = join(root, relative)
  if (file !== root && !file.startsWith(root + sep)) return notFound(res)
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file) || !statSync(file).isFile()) return notFound(res)
  return send(res, 200, file)
})

server.listen(port, host, () => {
  console.log(`pages-preview: serving ${root} at http://${host}:${port}${base}`)
})
