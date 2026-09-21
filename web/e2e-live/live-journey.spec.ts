import { expect, test, type Page, type Response } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIVE_BASE_URL } from '../playwright.live.config'

/**
 * The reader's journey against the PUBLISHED site, at a phone viewport and a desktop one.
 *
 * This suite reads. It never signs in, never writes, never seeds and never carries a key: the only
 * credential involved is the public anon key the deployment itself was built with, which the browser
 * picks up from the served bundle exactly as a member of the public does.
 *
 * Because the data is live, nothing here asserts a figure, a person, a party or a count. It asserts
 * the shape of an honest page: that the live store answered, that every card names its publisher and
 * both of its dates, that what is not known is printed rather than filled in, that a link to the
 * publisher is a real external link, and that a deep link boots. Those hold whether the store holds
 * one electorate or seventy, today or after the next import — which is what makes it safe to run
 * against production.
 *
 * An empty panel is a pass when it says so in words. A spinner that never resolves is not.
 */

const SCREENS = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results', 'live-screens')
mkdirSync(SCREENS, { recursive: true })

/** The API host the deployment is built against, read from the site's own content policy. */
const API_HOST = /supabase\.co$/

function shot(page: Page, name: string): Promise<Buffer> {
  const project = test.info().project.name
  return page.screenshot({ path: join(SCREENS, `live-${project}-${name}.png`), fullPage: true })
}

/**
 * The first screen, at the viewport, not the whole scroll. A full-page capture of the live electorate
 * page is about ten phone screens tall, which shows a reviewer everything except the thing a reader
 * actually meets: what is above the fold, and whether the first action is reachable without scrolling.
 * These are evidence for a human. Nothing is compared automatically, so a layout change fails nothing.
 */
function fold(page: Page, name: string): Promise<Buffer> {
  const project = test.info().project.name
  return page.screenshot({ path: join(SCREENS, `live-${project}-${name}-fold.png`), fullPage: false })
}

/**
 * Watches what the live REST API answers while a page loads. A 404 is not a failure here — the app
 * renders "this deployment does not carry that dataset" for exactly that — but a refusal or a server
 * error is: it would mean anonymous reading of the published site is broken.
 */
function watchApi(page: Page): string[] {
  const refusals: string[] = []
  page.on('response', (response: Response) => {
    const url = new URL(response.url())
    if (!API_HOST.test(url.hostname)) return
    const status = response.status()
    if (status === 401 || status === 403 || status >= 500) refusals.push(`${status} ${url.pathname}${url.search}`)
  })
  return refusals
}

/** Waits for the page to have finished answering: nothing anywhere is still loading. */
async function settled(page: Page): Promise<void> {
  await expect(page.getByTestId('loading-state')).toHaveCount(0, { timeout: 30_000 })
}

/** The name and address of an electorate this deployment actually offers, discovered at run time. */
async function firstElectorate(page: Page): Promise<{ name: string; slug: string }> {
  const search = page.getByTestId('electorate-search')
  await search.click()
  const option = page.getByTestId('electorate-option').first()
  await expect(option).toBeVisible()
  const name = (await option.innerText()).trim()
  await option.click()
  await expect(page).toHaveURL(/\/electorate\/[^/]+$/)
  const slug = new URL(page.url()).pathname.split('/').pop() ?? ''
  expect(slug.length).toBeGreaterThan(0)
  return { name, slug }
}

test.describe('the published site', () => {
  test('the homepage is served over https and offers an electorate by name, never an address', async ({ page }) => {
    const refusals = watchApi(page)
    const response = await page.goto('./')
    expect(response?.status(), 'the site root is served, not a fallback').toBe(200)
    expect(new URL(page.url()).protocol).toBe('https:')

    await expect(page.getByRole('heading', { level: 1, name: 'Start with your electorate' })).toBeVisible()
    await expect(page.getByTestId('preview-banner')).toBeVisible()

    // The first action is a name box, and the live store answered it with a list.
    const search = page.getByTestId('electorate-search')
    await expect(search).toBeVisible()
    await expect(search).toHaveAttribute('role', 'combobox')
    await expect(page.locator('main')).toContainText(/\d+ electorates are loaded/)
    await expect(page.locator('main')).toContainText('never asks for, stores or sends an address or a location')
    await expect(page.locator('input[type="file"], [name*="address" i], [aria-label*="location" i]')).toHaveCount(0)

    // Browsing all of the data is still one click away from the front door.
    await expect(page.getByTestId('home-to-explorer')).toBeVisible()
    await settled(page)
    await shot(page, '01-home')
    await fold(page, '01-home')
    expect(refusals, 'anonymous reads of the live API').toEqual([])
  })

  test('picking an electorate by name lands on its own page', async ({ page }) => {
    await page.goto('./')
    const search = page.getByTestId('electorate-search')
    await search.click()
    await expect(page.getByRole('listbox', { name: 'Electorates' })).toBeVisible()
    await shot(page, '02-picker-open')

    const { name } = await firstElectorate(page)
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
    await settled(page)
    await shot(page, '03-electorate')
    await fold(page, '03-electorate')
  })

  test('the whole journey works from the keyboard alone', async ({ page }) => {
    await page.goto('./')
    const search = page.getByTestId('electorate-search')
    await search.focus()
    await page.keyboard.press('ArrowDown')
    await expect(search).toHaveAttribute('aria-activedescendant', /.+/)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/electorate\/[^/]+$/)
    await expect(page.getByTestId('back-to-picker')).toBeVisible()
  })

  test('a deep link to an electorate boots through the Pages 404 fallback and reloads to the same page', async ({ page }) => {
    await page.goto('./')
    const { name, slug } = await firstElectorate(page)

    // GitHub Pages has no SPA rewrite: a deep link is answered by 404.html, which boots the app.
    const deep = await page.goto(`./electorate/${slug}`)
    expect(deep?.status(), 'Pages answers a deep link with the 404.html fallback').toBe(404)
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()

    const url = page.url()
    await page.reload()
    await expect(page).toHaveURL(url)
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
    await settled(page)
  })

  test('every card on a live electorate page names its publisher and both of its dates', async ({ page }) => {
    const refusals = watchApi(page)
    await page.goto('./')
    const { slug } = await firstElectorate(page)
    await page.goto(`./electorate/${slug}`)
    await settled(page)

    for (const card of ['card-2026', 'card-representation', 'card-activity', 'card-2023', 'card-money']) {
      await expect(page.getByTestId(card)).toBeVisible()
    }

    const cards = page.locator('[data-testid^="card-"]')
    const count = await cards.count()
    expect(count).toBeGreaterThanOrEqual(5)
    for (let i = 0; i < count; i++) {
      const provenance = cards.nth(i).getByTestId('provenance')
      await expect(provenance).toBeVisible()
      await expect(provenance.getByTestId('provenance-publisher')).not.toBeEmpty()
      // The publisher's own date and the date this project retrieved the material are two values.
      await expect(provenance.getByTestId('provenance-source-date')).not.toBeEmpty()
      await expect(provenance.getByTestId('provenance-retrieved')).not.toBeEmpty()
    }
    await shot(page, '04-cards')
    expect(refusals, 'anonymous reads of the live API').toEqual([])
  })

  test('what the live page does not know is printed on the card, not filled in', async ({ page }) => {
    await page.goto('./')
    const { slug } = await firstElectorate(page)
    await page.goto(`./electorate/${slug}`)
    await settled(page)

    // Known unknowns are a property of the product, not of today's data.
    expect(await page.getByTestId('known-unknowns').count()).toBeGreaterThan(0)

    // A sitting member is never presented as a 2026 candidate, and the boundary editions are not equated.
    await expect(page.getByTestId('card-2026')).toContainText('A sitting member is not a candidate')
    await expect(page.getByTestId('electorate-boundary-note')).toContainText('is not the same area')
    // General or Māori is stated only where it has been verified.
    await expect(page.getByTestId('electorate-type')).not.toBeEmpty()

    // Party money is not presented as a receipt by a candidate.
    await expect(page.getByTestId('card-money')).toContainText('not a receipt by any candidate')

    // Nothing that would be a private detail of a donor is rendered.
    await expect(page.locator('main')).not.toContainText(/\b\d+\s+[A-Z][a-z]+\s+(Street|Road|Avenue|Drive|Lane)\b/)
    await shot(page, '05-known-unknowns')
  })

  test('every link to a publisher on a live electorate page is a real external link', async ({ page }) => {
    await page.goto('./')
    const { slug } = await firstElectorate(page)
    await page.goto(`./electorate/${slug}`)
    await settled(page)

    const links = page.getByTestId('provenance').getByRole('link')
    const total = await links.count()
    expect(total, 'at least one card links the original at the publisher').toBeGreaterThan(0)
    for (let i = 0; i < total; i++) {
      const href = await links.nth(i).getAttribute('href')
      expect(href, 'a publisher link is an absolute https address').toMatch(/^https:\/\//)
      // It must leave this site, not navigate inside it.
      expect(new URL(href ?? '').hostname).not.toBe(new URL(LIVE_BASE_URL).hostname)
      await expect(links.nth(i)).toHaveAttribute('rel', /noopener/)
      await expect(links.nth(i)).toHaveAttribute('target', '_blank')
    }
  })

  test('browsing all of the data still works, and the live lists answer', async ({ page }) => {
    const refusals = watchApi(page)
    await page.goto('./')
    await page.getByTestId('home-to-explorer').click()
    await expect(page).toHaveURL(/\/overview$/)
    await expect(page.getByRole('heading', { level: 1, name: 'What has been retrieved, by scope' })).toBeVisible()
    await settled(page)
    await shot(page, '06-overview')

    const sections = page.getByRole('navigation', { name: 'Sections' })
    await sections.getByRole('link', { name: 'Sources', exact: true }).click()
    await expect(page).toHaveURL(/\/sources(\?|$)/)
    await settled(page)
    await expect(page.getByTestId('data-row').first(), 'the live store answered the sources list').toBeVisible()
    await shot(page, '07-sources')
    expect(refusals, 'anonymous reads of the live API').toEqual([])
  })

  test('a source opens its own page, where the record counts are read', async ({ page }) => {
    const refusals = watchApi(page)

    // Ordered by the source's own id: a first row that is the same on every run, chosen by a key the
    // server can order on without counting anything. The list is deliberately not sortable by how much
    // a source holds — that ordering would make the server count every source's records to return one
    // page — so this test opens a deterministic source, not the largest one, and claims no more.
    // A deep link is answered by the Pages 404.html fallback, which boots the app. Wait for the route
    // to have rendered before asking whether anything is still loading, or "nothing is loading" would
    // be true simply because nothing has started.
    await page.goto('./sources?sort=source_id&dir=asc')
    await expect(page.getByRole('heading', { level: 1, name: 'Sources' })).toBeVisible()
    await settled(page)
    const firstSource = page.getByTestId('data-row').first()
    await expect(firstSource, 'the live store answered the sources list').toBeVisible()

    const link = firstSource.getByRole('link').first()
    await expect(link, 'the row links to the source’s own page').toHaveAttribute('href', /\/sources\/[^/]+$/)
    await link.click()
    await expect(page).toHaveURL(/\/sources\/[^/]+$/)
    await settled(page)

    // It answered with the source itself, not an error block and not a spinner it never left.
    await expect(page.getByTestId('error-state'), 'the source page is not an error').toHaveCount(0)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    // The page states the basis on which any field of this source is shown at all, before any count.
    await expect(page.getByTestId('source-release-basis')).toBeVisible()

    // Counts are shown as counts; where a total is not read, the page says so instead of printing a
    // number it does not have. Either way it is words or a figure, never a blank.
    await expect(page.locator('main')).toContainText('Live records')
    await expect(page.locator('main')).toContainText('Content versions')

    await shot(page, '09-source-detail')
    await fold(page, '09-source-detail')
    expect(refusals, 'anonymous reads of the live API').toEqual([])
  })

  test('donations are shown as they stand, with the absence stated rather than implied', async ({ page }) => {
    await page.goto('./')
    const sections = page.getByRole('navigation', { name: 'Sections' })
    await sections.getByRole('link', { name: 'Donations', exact: true }).click()
    await expect(page).toHaveURL(/\/donations(\?|$)/)
    await expect(page.getByRole('heading', { level: 1, name: 'Donations disclosed in filed returns' })).toBeVisible()

    // The page says what is missing from this material whether or not any row is loaded.
    await expect(page.getByTestId('donations-incomplete')).toBeVisible()
    await settled(page)

    // Either rows are published, or the page says plainly that none are held. Never a spinner, and
    // never a silent empty table that a reader could read as "no donations were made".
    const rows = await page.getByTestId('data-row').count()
    if (rows === 0) {
      await expect(page.getByTestId('empty-state').or(page.getByTestId('not-loaded')).first()).toBeVisible()
    }

    // The live store may hold these returns and release none of their fields. Rows then exist and carry
    // only the publisher's link, which is a state the reader must be told in words: a table of blanks
    // would read as returns that stated nothing. Whichever state the deployment is in, it is stated.
    const linkOnly = page.getByTestId('donations-link-only')
    if (await linkOnly.count()) {
      await expect(linkOnly).toBeVisible()
      await expect(linkOnly).toContainText('not released on this deployment')
      // Every row still reaches the publisher's own document: link-only is access, not a dead end.
      const firstRow = page.getByTestId('data-row').first()
      await expect(firstRow.getByRole('link').first()).toHaveAttribute('href', /^https?:\/\//)
      await expect(firstRow.getByTestId('entry-link-only')).toBeVisible()
      // And the filters that read unreleased fields are not offered, so no reader can search a donor
      // name and read the empty answer as "this person gave nothing".
      await expect(page.getByTestId('donations-filters-unavailable')).toBeVisible()
    }
    await shot(page, '08-donations')
  })

  test('the live site stores nothing about the reader', async ({ page }) => {
    await page.goto('./')
    await expect(page.getByTestId('electorate-search')).toBeVisible()
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
    expect(stored).not.toMatch(/access_token|refresh_token|sb-.*-auth|latitude|address/i)
    expect(await page.context().cookies()).toHaveLength(0)
  })
})
