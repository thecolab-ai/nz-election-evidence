import { defineConfig } from '@playwright/test'
import { appEnv, shared } from './playwright.shared'

/**
 * `npm run e2e:pages`: a production build under the GitHub Pages base path, served by the
 * Pages-like preview server (unknown paths answer 404.html with HTTP 404).
 */
export default defineConfig({
  ...shared,
  testMatch: ['**/pages-routing.spec.ts'],
  use: { ...shared.use, baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: 'npm run build && node scripts/pages-preview.ts',
    url: 'http://127.0.0.1:4173/nz-election-evidence/',
    reuseExistingServer: false,
    timeout: 120_000,
    env: appEnv('/nz-election-evidence/'),
  },
})
