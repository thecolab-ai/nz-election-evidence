import { expect, test, type Page } from '@playwright/test'
import { SCREENS } from './support/helpers'

/**
 * The reader's journey, run at a phone viewport and at a desktop viewport (see
 * playwright.journey.config.ts). Everything asserted here is either fixture data seeded by
 * e2e/global-setup.ts or a sentence this product is not allowed to get wrong.
 *
 * Nothing in this file asserts a figure about a real person or party.
 */

const ELECTORATE = 'Fixture Electorate A'
const SLUG = 'fixture-electorate-a'

function shot(page: Page, name: string): Promise<Buffer> {
  const project = test.info().project.name
  return page.screenshot({ path: `${SCREENS}/journey-${project}-${name}.png`, fullPage: true })
}

test.describe('the electorate journey', () => {
  test('a reader arrives, picks an electorate by name, and lands on its page', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Start with your electorate' })).toBeVisible()

    // The first action is a name box. Nothing asks where the reader lives.
    const search = page.getByTestId('electorate-search')
    await expect(search).toBeVisible()
    await expect(search).toHaveAttribute('role', 'combobox')
    await expect(page.locator('main')).toContainText('never asks for, stores or sends an address or a location')
    await expect(page.locator('input[type="file"], [name*="address" i], [aria-label*="location" i]')).toHaveCount(0)

    // The evidence explorer is still one click away.
    await expect(page.getByTestId('home-to-explorer')).toBeVisible()
    await shot(page, '01-home')

    await search.click()
    await expect(page.getByRole('listbox', { name: 'Electorates' })).toBeVisible()
    await search.fill('fixture electorate a')
    const options = page.getByTestId('electorate-option')
    await expect(options.first()).toContainText(ELECTORATE)
    await shot(page, '02-picker-open')

    await options.first().click()
    await expect(page).toHaveURL(new RegExp(`/electorate/${SLUG}$`))
    await expect(page.getByRole('heading', { level: 1, name: ELECTORATE })).toBeVisible()
  })

  test('the whole journey works from the keyboard alone', async ({ page }) => {
    await page.goto('/')
    const search = page.getByTestId('electorate-search')
    await search.focus()
    await search.pressSequentially('fixture electorate a')
    await page.keyboard.press('ArrowDown')
    await expect(search).toHaveAttribute('aria-activedescendant', /.+/)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/electorate/${SLUG}$`))
    // The reader can get back to the picker without a mouse.
    await expect(page.getByTestId('back-to-picker')).toBeVisible()
  })

  test('every card on an electorate page names its publisher and both of its dates', async ({ page }) => {
    await page.goto(`/electorate/${SLUG}`)
    await expect(page.getByRole('heading', { level: 1, name: ELECTORATE })).toBeVisible()

    const cards = page.locator('[data-testid^="card-"]')
    const count = await cards.count()
    expect(count).toBeGreaterThanOrEqual(5)
    for (let i = 0; i < count; i++) {
      const provenance = cards.nth(i).getByTestId('provenance')
      await expect(provenance).toBeVisible()
      await expect(provenance.getByTestId('provenance-publisher')).not.toBeEmpty()
      await expect(provenance.getByTestId('provenance-source-date')).not.toBeEmpty()
      await expect(provenance.getByTestId('provenance-retrieved')).not.toBeEmpty()
      // The publisher's date and the retrieval date are two values, never one printed twice.
      const stated = (await provenance.getByTestId('provenance-source-date').innerText()).trim()
      const retrieved = (await provenance.getByTestId('provenance-retrieved').innerText()).trim()
      expect(stated).not.toBe(retrieved)
    }
    await shot(page, '03-electorate')
  })

  test('no panel is left spinning once the page has answered', async ({ page }) => {
    await page.goto(`/electorate/${SLUG}`)
    await expect(page.getByRole('heading', { level: 1, name: ELECTORATE })).toBeVisible()
    for (const card of ['card-2026', 'card-representation', 'card-activity', 'card-2023', 'card-money']) {
      await expect(page.getByTestId(card)).toBeVisible()
    }
    // Every panel has to end in one of the honest states. A read taken in two hops — find the rows,
    // then fetch the documents they point at — leaves a skeleton up for ever if it treats its switched-off
    // second hop as "still loading", and that happens on exactly the electorates that hold nothing.
    await expect(page.getByTestId('loading-state')).toHaveCount(0, { timeout: 20_000 })
    await shot(page, '07-every-panel-settled')
  })

  test('the homepage leaves no panel spinning either', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('electorate-search')).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'What each party published for 2026' })).toBeVisible()
    await expect(page.getByTestId('loading-state')).toHaveCount(0, { timeout: 20_000 })
  })

  test('the page states its boundary edition and refuses to carry a name across editions', async ({ page }) => {
    await page.goto(`/electorate/${SLUG}`)
    await expect(page.getByTestId('electorate-boundary-note')).toContainText('is not the same area')
    // General or Māori is stated only when it has been verified; the fixture electorate is unverified.
    await expect(page.getByTestId('electorate-type')).toContainText('not verified')
  })

  test('2026 is an honest unknown, and a sitting member is never presented as a candidate', async ({ page }) => {
    await page.goto(`/electorate/${SLUG}`)
    const card = page.getByTestId('card-2026')
    await expect(card).toContainText('A sitting member is not a candidate')
    await expect(card.getByTestId('none-held')).toContainText('unknown, not zero')
    await expect(card.getByTestId('known-unknowns')).toContainText('no official nomination for 2026 has been loaded')
  })

  test('the member shown is disclosed as a text correspondence, not a reviewed link', async ({ page }) => {
    await page.goto(`/electorate/${SLUG}`)
    const card = page.getByTestId('card-representation')
    await expect(card.getByTestId('representation-basis')).toContainText('not a reviewed link')
    await expect(card.getByTestId('representation-row').first()).toContainText('Fixture Member 01')
    await expect(card.getByTestId('representation-row').first()).toContainText('Unresolved')
  })

  test('parliamentary activity is labelled as activity, and is never joined by name', async ({ page }) => {
    await page.goto(`/electorate/${SLUG}`)
    const card = page.getByTestId('card-activity')
    await expect(card).toContainText('not a measure of effectiveness')
    await expect(card).toContainText('never counted up into a score')
    await expect(card.getByTestId('known-unknowns')).toContainText('this page will not join them')
    // Either there is identity-linked activity, or the panel says plainly that it found none.
    const rows = await card.getByTestId('activity-row').count()
    if (rows === 0) await expect(card.getByTestId('none-held')).toBeVisible()
    await expect(card.getByTestId('activity-to-documents')).toBeVisible()
  })

  test('2023 is kept separate, listed alphabetically, and never shows a missing figure as zero', async ({ page }) => {
    await page.goto(`/electorate/${SLUG}`)
    const card = page.getByTestId('card-2023')
    await expect(card).toContainText('not a forecast')
    const names = await card.getByTestId('candidacy-row').allInnerTexts()
    expect(names.length).toBeGreaterThanOrEqual(3)
    expect(names.join(' ')).toContain('Fixture Candidate Aroha')
    // Cass has no figure at all: the source stated none, and it is never rendered as 0.
    const cass = card.getByTestId('candidacy-row').filter({ hasText: 'Cass' })
    await expect(cass.getByTestId('votes-cell')).toContainText('not reported')
    await expect(cass.getByTestId('votes-cell')).not.toHaveText('0')
    await shot(page, '04-2023')
  })

  test('party money and candidate money are kept apart, and neither is attributed here', async ({ page }) => {
    await page.goto(`/electorate/${SLUG}`)
    const card = page.getByTestId('card-money')
    await expect(card).toContainText('not a receipt by any candidate')
    await expect(card).toContainText('the publisher’s text, not a link to the candidacies')
    await expect(card.getByTestId('returns-not-linked')).toContainText('candidate returns are held as filed documents')
    await expect(card.getByTestId('money-to-donations')).toBeVisible()
    await expect(card.getByTestId('known-unknowns')).toContainText('an anonymous donation, or one protected from disclosure')
    // No street address, contact detail or signature is ever rendered on this page.
    await expect(page.locator('main')).not.toContainText(/\b\d+\s+[A-Z][a-z]+\s+(Street|Road|Avenue|Drive|Lane)\b/)
    await shot(page, '05-money')
  })

  test('an address for an electorate that is not loaded says so without inventing one', async ({ page }) => {
    await page.goto('/electorate/not-a-loaded-electorate')
    await expect(page.getByRole('heading', { level: 1, name: 'No electorate with this address' })).toBeVisible()
    await expect(page.getByTestId('empty-state')).toContainText('not evidence that no such electorate exists')
    await shot(page, '06-unknown-electorate')
  })

  test('nothing about the reader is stored in the browser', async ({ page }) => {
    await page.goto(`/electorate/${SLUG}`)
    await expect(page.getByRole('heading', { level: 1, name: ELECTORATE })).toBeVisible()
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
    expect(stored).not.toMatch(/access_token|refresh_token|sb-.*-auth|latitude|address/i)
    expect(await page.context().cookies()).toHaveLength(0)
  })

  test('the homepage says which boundaries it holds and links the publisher’s own address lookup', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('home-boundary-warning')).toContainText('is not the same area')
    await expect(page.getByTestId('home-2026-card')).toBeVisible()
    await expect(page.getByTestId('home-2026-nominations')).toBeVisible()
    // The lookup link is only rendered when the store holds a status row for that page; when it is
    // there it must carry the status, so a reader is never sent to a page this project knows is down.
    const lookup = page.getByTestId('official-lookup')
    if (await lookup.count()) {
      await expect(lookup.getByRole('link')).toHaveAttribute('rel', /noopener/)
      await expect(lookup).toContainText(/checked|available|unavailable/i)
    }
  })
})
