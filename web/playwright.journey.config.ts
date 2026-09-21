import { defineConfig, devices } from '@playwright/test'
import { appEnv, shared } from './playwright.shared'

/**
 * `npm run e2e:journey`: the electorate journey, run twice — once at a phone viewport with touch,
 * once at a desktop viewport. The same assertions run in both, because the journey has to work in
 * both; the screenshots each project writes are the reviewable artefact.
 *
 * It is a separate config, not extra projects on `playwright.config.ts`, so the rest of the suite
 * is not run twice. `playwright.config.ts` ignores this spec for the same reason.
 */
export default defineConfig({
  ...shared,
  testMatch: ['**/electorate-journey.spec.ts'],
  use: { ...shared.use, baseURL: 'http://127.0.0.1:5173' },
  projects: [
    // Pixel 5's descriptor: 393x851, touch, mobile user agent. A real narrow viewport, not a resized desktop.
    { name: 'mobile', use: { ...devices['Pixel 5'], headless: true, locale: 'en-NZ', timezoneId: 'Pacific/Auckland', launchOptions: shared.use?.launchOptions } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173/',
    reuseExistingServer: false,
    timeout: 60_000,
    env: appEnv('/'),
  },
})
