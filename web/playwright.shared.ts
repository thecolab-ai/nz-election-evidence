import type { PlaywrightTestConfig } from '@playwright/test'
import { chromiumExecutable, LOCAL_API_URL, localKeys } from './e2e/support/local-stack'

const executablePath = chromiumExecutable()

/** Public values only: the app under test is always built/served with the anon key. */
export function appEnv(basePath: string): Record<string, string> {
  return {
    VITE_SUPABASE_URL: LOCAL_API_URL,
    VITE_SUPABASE_ANON_KEY: localKeys().anonKey,
    VITE_BASE_PATH: basePath,
  }
}

export const shared: PlaywrightTestConfig = {
  testDir: './e2e',
  outputDir: './test-results/artifacts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    locale: 'en-NZ',
    timezoneId: 'Pacific/Auckland',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
}
