import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

export function normaliseBasePath(value: string | undefined): string {
  const trimmed = (value ?? '/').trim()
  if (trimmed === '' || trimmed === '/') return '/'
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`
}

/** Origin (scheme://host[:port]) of the configured Supabase project, or null when unset/invalid. */
export function supabaseOrigin(url: string | undefined, localTestStack = false): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    // Same rule as src/lib/env.ts: https, or http to loopback in an explicitly marked local test stack build.
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localTestStack && loopback)) return null
    return parsed.origin
  } catch {
    return null
  }
}

export function buildCsp(origin: string | null, dev: boolean): string {
  const connect = ["'self'"]
  // Realtime is not used, so no websocket origin is allowed in production.
  if (origin) connect.push(origin)
  if (dev) connect.push('ws://127.0.0.1:5173', 'ws://localhost:5173')
  return [
    "default-src 'self'",
    // The dev server's React refresh preamble is an inline script; production ships none.
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    // React Flow positions nodes with inline style attributes, so style attributes are allowed.
    // Inline <style> elements are only allowed in dev (Vite injects CSS that way).
    dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    ...(dev ? [] : ["style-src-elem 'self'", "style-src-attr 'unsafe-inline'"]),
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'self'",
  ].join('; ')
}

function cspPlugin(origin: string | null): Plugin {
  let dev = false
  return {
    name: 'evidence-explorer-csp',
    configResolved(config) {
      dev = config.command === 'serve'
    },
    transformIndexHtml(html) {
      return html.replace('__CSP__', buildCsp(origin, dev))
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_')
  const base = normaliseBasePath(process.env.VITE_BASE_PATH ?? env.VITE_BASE_PATH)
  const localTestStack = (process.env.VITE_LOCAL_TEST_STACK ?? env.VITE_LOCAL_TEST_STACK) === '1'
  const origin = supabaseOrigin(process.env.VITE_SUPABASE_URL ?? env.VITE_SUPABASE_URL, localTestStack)
  return {
    base,
    plugins: [react(), tailwindcss(), cspPlugin(origin)],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    build: {
      sourcemap: false,
      chunkSizeWarningLimit: 700,
    },
    test: {
      environment: 'jsdom',
      globals: false,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
    },
  }
})
