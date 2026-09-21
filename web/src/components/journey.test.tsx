import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DataError } from '@/lib/queries'
import type { Availability } from '@/lib/electorate'
import { HOME_LEDE, HOME_TITLE } from '@/routes/home'
import { ELECTORATE_PAGE_LEDE } from '@/routes/electorate'
import { ElectoratePicker } from './electorate-picker'
import { AvailabilityBlock, FactCard } from './fact-card'

// Invented electorates: these are fixtures, not evidence.
const FIXTURE_ELECTORATES = [
  { id: 'a', slug: 'fixture-otaki', name: 'Fixture Ōtaki (TEST FIXTURE)' },
  { id: 'b', slug: 'fixture-mana', name: 'Fixture Mana (TEST FIXTURE)' },
]

/** A throwaway router so the picker can navigate the way it does in the application. */
function renderPicker() {
  const rootRoute = createRootRoute({ component: Outlet })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <ElectoratePicker electorates={FIXTURE_ELECTORATES} /> })
  const electorateRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/electorate/$slug',
    component: () => <p data-testid="landed">an electorate page</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, electorateRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router as never} />)
  return router
}

/** The router resolves its first match asynchronously, so the picker appears a tick after mounting. */
async function renderPickerReady() {
  const router = renderPicker()
  const input = await screen.findByTestId('electorate-search')
  return { router, input }
}

describe('the first action: choosing an electorate', () => {
  it('is a name box, not a location box: nothing asks for an address or geolocation', () => {
    render(<ElectoratePicker electorates={FIXTURE_ELECTORATES} />)
    const input = screen.getByTestId('electorate-search')
    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('type')).toBe('text')
    // No address or location affordance of any kind.
    expect(document.querySelector('input[type="file"], input[name*="address" i], button[name*="location" i]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/use my location|current location|postcode|street address/i)
  })

  it('exposes the combobox pattern that a screen reader and a keyboard both rely on', () => {
    render(<ElectoratePicker electorates={FIXTURE_ELECTORATES} />)
    const input = screen.getByTestId('electorate-search')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    fireEvent.focus(input)
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('listbox', { name: 'Electorates' })).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const activeId = input.getAttribute('aria-activedescendant')
    expect(activeId).toBeTruthy()
    expect(document.getElementById(activeId as string)?.getAttribute('aria-selected')).toBe('true')
  })

  it('opens the chosen electorate from the keyboard alone', async () => {
    const { router, input } = await renderPickerReady()
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('landed')).toBeTruthy())
    expect(router.state.location.pathname).toBe('/electorate/fixture-mana')
  })

  it('opens the only remaining match on Enter after typing', async () => {
    const { router, input } = await renderPickerReady()
    fireEvent.change(input, { target: { value: 'otaki' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(router.state.location.pathname).toBe('/electorate/fixture-otaki'))
  })

  it('says an unmatched name is not evidence that the electorate does not exist', () => {
    render(<ElectoratePicker electorates={FIXTURE_ELECTORATES} />)
    fireEvent.change(screen.getByTestId('electorate-search'), { target: { value: 'Nowhere' } })
    expect(screen.getByTestId('electorate-no-match').textContent).toContain('does not mean no such electorate exists')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  /**
   * The regression the whole browser journey failed on. `electorates.slug` is released only where a
   * rights row names a `slug` field, and none does, so a deployment that releases the electorate NAME
   * hands the picker rows whose slug is null. Filtering and navigating on that column offered a reader
   * nothing at all; the address is now the store's slug where there is one and the same fold of the
   * name where there is not, so the page a reader shares is the same string either way.
   */
  it('still offers and opens an electorate whose slug the deployment does not release', async () => {
    const rootRoute = createRootRoute({ component: Outlet })
    const withheld = [{ id: 'a', slug: null, name: 'Fixture Electorate A (TEST FIXTURE)' }]
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <ElectoratePicker electorates={withheld} /> })
    const electorateRoute = createRoute({ getParentRoute: () => rootRoute, path: '/electorate/$slug', component: () => <p data-testid="landed">an electorate page</p> })
    const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, electorateRoute]), history: createMemoryHistory({ initialEntries: ['/'] }) })
    render(<RouterProvider router={router as never} />)
    const input = await screen.findByTestId('electorate-search')
    fireEvent.change(input, { target: { value: 'fixture electorate a' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    // Exactly the store's own expression: a RUN of characters outside [a-z0-9āēīōū] collapses to one dash.
    await waitFor(() => expect(router.state.location.pathname).toBe('/electorate/fixture-electorate-a-test-fixture-'))
  })

  it('offers nothing at all when the name is withheld too, rather than an address it made up', () => {
    render(<ElectoratePicker electorates={[{ id: 'a', slug: null, name: null }]} />)
    fireEvent.focus(screen.getByTestId('electorate-search'))
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByTestId('electorate-no-match')).toBeTruthy()
  })

  it('closes on Escape without navigating anywhere', async () => {
    const { router, input } = await renderPickerReady()
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(router.state.location.pathname).toBe('/')
  })
})

describe('a card cannot state a fact without stating where it came from', () => {
  it('prints the publisher, the publisher’s date and the retrieval date as three separate values', () => {
    render(
      <FactCard
        eyebrow="Fixture"
        title="A fixture fact"
        testId="fixture-card"
        provenance={{
          publisher: 'Fixture Publisher (TEST FIXTURE)',
          officialUrl: 'https://example.invalid/original',
          sourceDate: '2026-08-01T00:00:00Z',
          retrievedAt: '2026-09-20T08:43:50Z',
        }}
        unknowns={['Whether the fixture changed since it was retrieved.']}
      >
        <p>body</p>
      </FactCard>,
    )
    expect(screen.getByTestId('provenance-publisher').textContent).toBe('Fixture Publisher (TEST FIXTURE)')
    const stated = screen.getByTestId('provenance-source-date').textContent ?? ''
    const retrieved = screen.getByTestId('provenance-retrieved').textContent ?? ''
    expect(stated).toContain('2026')
    expect(retrieved).toContain('2026')
    expect(stated).not.toBe(retrieved)
    expect(screen.getByTestId('known-unknowns').textContent).toContain('Whether the fixture changed')
    const link = screen.getByRole('link', { name: /Open the original/ })
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('says so plainly when the publisher states no date, rather than showing the retrieval date in its place', () => {
    render(
      <FactCard eyebrow="Fixture" title="Undated fixture" testId="undated" provenance={{ publisher: 'Fixture Publisher (TEST FIXTURE)', officialUrl: null, sourceDate: null, retrievedAt: '2026-09-20T08:43:50Z' }} unknowns={[]}>
        <p>body</p>
      </FactCard>,
    )
    expect(screen.getByTestId('provenance-source-date').textContent).toBe('not stated by source')
    expect(screen.queryByTestId('known-unknowns')).toBeNull()
  })
})

describe('four silences, four different sentences', () => {
  const renderState = <Row,>(availability: Availability<Row>) =>
    render(
      <AvailabilityBlock availability={availability} loadingLabel="Loading fixture" datasetName="evidence_public.fixture" noneHeld="No fixture row is held for this.">
        {(rows) => <p data-testid="rows">{rows.length}</p>}
      </AvailabilityBlock>,
    )

  it('an empty answer is unknown, not zero', () => {
    renderState({ state: 'none_held' })
    const text = screen.getByTestId('none-held').textContent ?? ''
    expect(text).toContain('No fixture row is held for this.')
    expect(text).toContain('unknown, not zero')
  })

  it('a dataset that is not on this deployment says so, and claims nothing either way', () => {
    renderState({ state: 'not_loaded', error: new DataError('missing (TEST FIXTURE)', 'PGRST205') })
    const text = screen.getByTestId('not-loaded').textContent ?? ''
    expect(text).toContain('not on the deployment you are reading')
    expect(text).toContain('evidence_public.fixture')
    expect(text).toContain('makes no claim either way')
  })

  it('a cancelled query is reported as unanswered, never as an empty result', () => {
    renderState({ state: 'not_answerable', error: new DataError('cancelled (TEST FIXTURE)', '57014') })
    const text = screen.getByTestId('not-answerable').textContent ?? ''
    expect(text).toContain('could not answer the question in the time it allows')
    expect(text).toContain('not answered with an empty result')
    expect(text).toContain('Rows may well exist')
  })

  it('a failure shows the service’s own message and is not evidence of absence', () => {
    renderState({ state: 'failed', error: new DataError('boom (TEST FIXTURE)', 'XX000') })
    expect(screen.getByTestId('error-state').textContent).toContain('XX000: boom (TEST FIXTURE)')
    expect(screen.getByTestId('error-state').textContent).toContain('not evidence that no records exist')
  })

  it('hands rows to the panel when there are rows', () => {
    renderState({ state: 'ready', rows: [1, 2, 3] })
    expect(screen.getByTestId('rows').textContent).toBe('3')
  })
})

describe('the journey’s standing copy', () => {
  it('offers a first action and keeps the whole register reachable', () => {
    expect(HOME_TITLE).toBe('Start with your electorate')
    expect(HOME_LEDE).toContain('its publisher, its date, the date it was retrieved, and what is still unknown')
  })

  it('scopes an electorate page to one electorate in one boundary edition', () => {
    expect(ELECTORATE_PAGE_LEDE).toContain('one electorate in one boundary edition')
  })

  it('carries none of the wording the red-line scanner refuses', () => {
    expect(`${HOME_TITLE} ${HOME_LEDE} ${ELECTORATE_PAGE_LEDE}`).not.toMatch(/\b(lied|lies|liar|dishonest|corrupt|fraud|vote for|vote against|re-?elect|best|worst|ranking)\b/i)
  })
})
