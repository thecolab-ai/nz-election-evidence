import { expect, test } from '@playwright/test'
import { bundleProblems } from '../scripts/check-bundle.ts'
import { SCREENS } from './support/helpers'

const BASE = '/nz-election-evidence'

// Production build served the way GitHub Pages serves a project site: under the repository base
// path, with unknown paths answered by 404.html and HTTP status 404.
test.describe('GitHub Pages routing', () => {
  test('deep links and reloads boot the right route through the 404.html fallback', async ({ page }) => {
    const failedAssets: string[] = []
    page.on('response', (response) => {
      const url = new URL(response.url())
      if (url.port === '4173' && /\.(js|css|svg|woff2)$/.test(url.pathname) && response.status() >= 400) failedAssets.push(url.pathname)
    })

    const deep = await page.goto(`${BASE}/records?kind=bill&source=fixture_bills`)
    expect(deep?.status(), 'Pages answers an unknown path with 404.html').toBe(404)
    await expect(page.getByRole('heading', { level: 1, name: 'Records' })).toBeVisible()
    await expect(page.getByLabel('Record kind')).toHaveValue('bill')
    await expect(page.getByTestId('data-row').first()).toBeVisible()

    await page.getByTestId('data-row').first().getByRole('link').first().click()
    await expect(page).toHaveURL(new RegExp(`${BASE}/records/[0-9a-f-]{36}$`))
    const detailUrl = page.url()
    const heading = await page.getByRole('heading', { level: 1 }).innerText()

    await page.reload()
    await expect(page).toHaveURL(detailUrl)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)
    await expect(page.getByTestId('record-version').first()).toBeVisible()

    expect(failedAssets).toEqual([])
    await page.screenshot({ path: `${SCREENS}/16-pages-deep-link.png`, fullPage: true })
  })

  test('the site root is served with 200, assets come from the base path, navigation keeps the prefix', async ({ page, request }) => {
    const root = await request.get(`${BASE}/`)
    expect(root.status()).toBe(200)
    const html = await root.text()
    expect(html).toContain(`${BASE}/assets/`)
    expect(html).not.toMatch(/(src|href)="\/assets\//)
    expect((await request.get('/')).status(), 'nothing is served outside the base path').toBe(404)

    await page.goto(`${BASE}/`)
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Sources' }).click()
    await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:4173${BASE}/sources(\\?|$)`))
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Datasets and schema' }).click()
    await expect(page).toHaveURL(new RegExp(`${BASE}/datasets`))
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:4173${BASE}/sources(\\?|$)`))
  })

  test('an unknown address under the base path shows the in-app not-found page', async ({ page }) => {
    await page.goto(`${BASE}/no-such-page`)
    await expect(page.getByRole('heading', { level: 1, name: 'There is no page at this address' })).toBeVisible()
  })

  test('the built bundle carries no evidence, no privileged key and a restrictive content policy', async ({ request }) => {
    const html = await (await request.get(`${BASE}/`)).text()
    expect(html).toMatch(/http-equiv="Content-Security-Policy"/i)
    const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1] ?? '')
    expect(scripts.length).toBeGreaterThan(0)
    const files: Array<{ name: string; text: string }> = []
    for (const src of scripts) files.push({ name: src, text: await (await request.get(src)).text() })
    // Key MATERIAL, private names and fixture evidence - see scripts/check-bundle.ts.
    expect(bundleProblems(files)).toEqual([])
    // The only embedded token is the public anon key.
    const tokens = files.flatMap((f) => [...f.text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\./g)].map((m) => JSON.parse(Buffer.from(m[1] ?? '', 'base64url').toString()) as { role?: string }))
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) expect(token.role).toBe('anon')
  })
})
