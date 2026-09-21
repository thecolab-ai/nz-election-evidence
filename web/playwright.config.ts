import { defineConfig } from '@playwright/test'
import { appEnv, shared } from './playwright.shared'

/** `npm run e2e`: the Vite dev server at the root base path, against the local Supabase stack. */
export default defineConfig({
  ...shared,
  // The journey spec has its own config: it runs at two viewports (see playwright.journey.config.ts).
  testIgnore: ['**/pages-routing.spec.ts', '**/electorate-journey.spec.ts'],
  use: { ...shared.use, baseURL: 'http://127.0.0.1:5173' },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173/',
    reuseExistingServer: false,
    timeout: 60_000,
    env: appEnv('/'),
  },
})
