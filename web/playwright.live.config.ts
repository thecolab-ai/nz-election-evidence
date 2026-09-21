import { defineConfig, devices } from '@playwright/test'
import { existsSync } from 'node:fs'

/**
 * `npm run e2e:live`: the published GitHub Pages site, read only.
 *
 * This config is deliberately standalone. It shares nothing with `playwright.shared.ts`, because
 * everything there is about the disposable local stack — a global setup that seeds fixtures, a
 * loopback API URL, local keys. None of that may touch a live deployment. Here there is no global
 * setup, no web server, no seeding, no key: the browser reads the site exactly as a member of the
 * public does, over https, with whatever the deployment itself was built with.
 *
 * It therefore proves something the rest of the suite cannot. The other configs prove the app works
 * against a database this run created; this one proves the artefact actually served at the public
 * address renders, on a phone viewport and a desktop one.
 *
 * The target is overridable so a fork, or a future address, can be checked without editing a spec.
 */
const target = process.env.LIVE_BASE_URL ?? 'https://thecolab-ai.github.io/nz-election-evidence/'
// Relative gotos resolve against this, so a missing trailing slash would silently drop the last segment.
export const LIVE_BASE_URL = target.endsWith('/') ? target : `${target}/`

/** Only for running against an already-downloaded browser; CI installs one and leaves this unset. */
const explicit = process.env.PLAYWRIGHT_CHROMIUM_PATH
if (explicit && !existsSync(explicit)) throw new Error('PLAYWRIGHT_CHROMIUM_PATH does not point at a file.')
const launchOptions = explicit ? { executablePath: explicit } : {}

export default defineConfig({
  testDir: './e2e-live',
  outputDir: './test-results/live-artifacts',
  fullyParallel: false,
  workers: 1,
  // The public internet is between the runner and the site under test. A retry distinguishes a
  // flaky hop from a broken deployment; it cannot mask one, because the assertions are all about
  // what the page says, and a retry re-reads the same live page.
  retries: 2,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: LIVE_BASE_URL,
    headless: true,
    locale: 'en-NZ',
    timezoneId: 'Pacific/Auckland',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions,
  },
  projects: [
    // Pixel 5's descriptor: 393x851, touch, mobile user agent. A real narrow viewport, not a resized desktop.
    { name: 'mobile', use: { ...devices['Pixel 5'], headless: true, locale: 'en-NZ', timezoneId: 'Pacific/Auckland', launchOptions } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
  ],
})
