import { expect, test, type Page } from '@playwright/test'
import { REST, restHeaders, SCREENS } from './support/helpers'
import { psql } from './support/local-stack'

// Other fixture and real sources share this database, so every assertion is scoped to the
// exact source ids this suite seeds. No assertion depends on a global count.
const BILLS = 'fixture_bills'

async function tableSummary(page: Page): Promise<string> {
  return (await page.getByTestId('table-summary').innerText()).trim()
}

// Every test here runs as an anonymous visitor: there is no sign-in anywhere in the application.
test.describe('anonymous browsing', () => {
  test('overview keeps the three election scopes apart and states the rights position', async ({ page }) => {
    await page.goto('/')
    for (const [scope, label] of [
      ['primary_2026', '2026 election (primary view)'],
      ['baseline_2023', '2023 baseline'],
      ['finance_2025', '2025 finance returns'],
    ] as const) {
      await expect(page.getByTestId(`scope-${scope}`).getByRole('heading', { name: label })).toBeVisible()
    }
    await expect(page.getByTestId('release-gates')).toContainText('Open')
    await expect(page.getByTestId('rights-statement')).toContainText(/pending/)
    await page.screenshot({ path: `${SCREENS}/03-overview.png`, fullPage: true })
  })

  test('sources show freshness badges, separate dates, and the unavailable wording', async ({ page }) => {
    await page.goto('/sources?publisher=Fixture%20Publisher%20(TEST%20FIXTURE)')
    await expect(page.getByRole('columnheader', { name: /Last retrieved/ })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /Latest publisher date/ })).toBeVisible()
    const blocked = page.getByTestId('data-row').filter({ hasText: 'fixture_blocked' })
    await expect(blocked.getByTestId('freshness-unavailable')).toHaveText('Unavailable')
    await expect(blocked).toContainText('never retrieved')
    const bills = page.getByTestId('data-row').filter({ has: page.getByRole('link', { name: 'TEST FIXTURE bills list' }) })
    await expect(bills.getByTestId('freshness-fresh')).toHaveText('Fresh')
    // The main fixture publisher stands in for an approved-fields publisher; the pending one is tested in access.spec.
    await expect(bills.getByTestId('release-tier')).toHaveText('Approved fields shown')
    const pendingRow = page.getByTestId('data-row').filter({ has: page.getByRole('link', { name: 'TEST FIXTURE blocked nominations endpoint' }) })
    await expect(pendingRow).toHaveCount(1)
    await page.screenshot({ path: `${SCREENS}/04-sources.png`, fullPage: true })

    await blocked.getByRole('link', { name: 'TEST FIXTURE blocked nominations endpoint' }).click()
    await expect(page).toHaveURL(/\/sources\/fixture_blocked$/)
    await expect(page.getByTestId('freshness-explanation')).toHaveText('The publisher endpoint was unavailable or refused the request. This does not mean no records exist.')
    await expect(page.getByTestId('run-blocked')).toBeVisible()
    await expect(page.getByRole('table', { name: 'Fetch log' })).toContainText('403')
    await page.screenshot({ path: `${SCREENS}/05-source-unavailable.png`, fullPage: true })

    await page.goto(`/sources/${BILLS}`)
    await expect(page.getByRole('table', { name: 'Ingest errors' })).toContainText(/record.rejected/i)
    await expect(page.getByRole('table', { name: 'Ingest errors' })).not.toContainText('forbidden_field_name')
    await expect(page.getByRole('table', { name: 'Schedules' })).toContainText('Inactive')
  })

  test('records paginate on the server: page 2 differs from page 1 and the total is shown', async ({ page }) => {
    await page.goto(`/records?source=${BILLS}&tombstoned=include&sort=label&dir=asc`)
    await expect(page.getByTestId('data-row')).toHaveCount(25)
    expect(await tableSummary(page)).toBe('Rows 1–25 of 65')
    await expect(page.getByTestId('page-indicator')).toHaveText('Page 1 of 3')
    const firstPage = await page.getByTestId('data-row').locator('a').first().innerText()

    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page).toHaveURL(/page=2/)
    await expect(page.getByTestId('table-summary')).toContainText('Rows 26–50 of 65')
    const secondPage = await page.getByTestId('data-row').locator('a').first().innerText()
    expect(secondPage).not.toBe(firstPage)
    expect(firstPage).toContain('TEST FIXTURE Bill 001')
    expect(secondPage).toContain('TEST FIXTURE Bill 026')

    await page.getByLabel('Rows per page').selectOption('100')
    await expect(page.getByTestId('data-row')).toHaveCount(65)
    await expect(page.getByTestId('table-summary')).toContainText('Rows 1–65 of 65')

    // Server-side sort from a column header.
    await page.getByRole('button', { name: /^Record/ }).click()
    await expect(page).toHaveURL(/dir=desc/)
    await expect(page.getByTestId('data-row').first()).toContainText('TEST FIXTURE Bill 065')
    await page.screenshot({ path: `${SCREENS}/06-records.png` })
  })

  test('records filter by kind, and a filter that matches nothing shows the empty state', async ({ page }) => {
    await page.goto('/records?source=fixture_releases')
    await expect(page.getByTestId('data-row')).toHaveCount(3)
    await page.getByLabel('Record kind').selectOption('bill')
    await expect(page).toHaveURL(/kind=bill/)
    await expect(page.getByTestId('empty-state')).toHaveText('No rows. This may mean nothing has been ingested yet — it is not evidence of absence.')
    await page.screenshot({ path: `${SCREENS}/07-empty-state.png` })
    await page.getByLabel('Record kind').selectOption('release')
    await expect(page.getByTestId('data-row')).toHaveCount(3)
    await expect(page.getByTestId('data-row').first()).toContainText('TEST FIXTURE Release')
  })

  test('a tombstoned record is hidden by default and badged when included', async ({ page }) => {
    await page.goto(`/records?source=${BILLS}&q=Bill%20065`)
    await expect(page.getByTestId('empty-state')).toBeVisible()
    await page.getByLabel('Tombstoned').selectOption('only')
    await expect(page.getByTestId('data-row')).toHaveCount(1)
    await expect(page.getByTestId('tombstoned-badge')).toContainText('Tombstoned')
    await page.getByRole('link', { name: 'TEST FIXTURE Bill 065' }).click()
    await expect(page.getByTestId('tombstoned-badge')).toBeVisible()
    await expect(page.getByTestId('lifecycle-event')).toContainText('Tombstoned')
  })

  test('record detail shows provenance, two versions newest first, and a JSON viewer', async ({ page }) => {
    await page.goto(`/records?source=${BILLS}&q=Bill%20001`)
    await page.getByRole('link', { name: 'TEST FIXTURE Bill 001 (amended)' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'TEST FIXTURE Bill 001 (amended)' })).toBeVisible()

    const sourceLink = page.getByTestId('provenance-source-url').getByRole('link')
    await expect(sourceLink).toHaveAttribute('href', 'https://fixture.example/bills/001')
    await expect(sourceLink).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(page.getByTestId('provenance-publisher-date')).toContainText('not stated by source')
    await expect(page.getByTestId('provenance-hash')).toContainText(/sha256:[0-9a-f]{64}/)
    await expect(page.getByTestId('provenance-first-retrieved')).toContainText(/\d{4}/)

    const versions = page.getByTestId('record-version')
    await expect(versions).toHaveCount(2)
    await expect(versions.nth(0)).toContainText('Version 2 of 2')
    await expect(versions.nth(0).getByTestId('current-version')).toBeVisible()
    await expect(versions.nth(1)).toContainText('Superseded')
    await expect(versions.nth(0).getByTestId('omitted-fields')).toContainText('explanatory_note')
    await expect(versions.nth(0).getByTestId('observation-count')).toContainText('1 sighting')

    await expect(versions.nth(1).getByTestId('json-viewer-content')).toHaveCount(0)
    await versions.nth(1).getByRole('button', { name: /Stored fields/ }).click()
    await expect(versions.nth(1).getByTestId('json-viewer-content')).toContainText('"current_stage": "Select committee"')
    await versions.nth(0).getByRole('button', { name: /Stored fields/ }).click()
    await expect(versions.nth(0).getByTestId('json-viewer-content')).toContainText('"current_stage": "Second reading"')
    await page.screenshot({ path: `${SCREENS}/08-record-detail.png`, fullPage: true })
  })

  test('parliament carries the sitting-MP note and never invents service dates', async ({ page }) => {
    await page.goto('/parliament?source=fixture_mp_directory')
    await expect(page.getByTestId('sitting-mp-note')).toHaveText('A sitting MP is not a candidate. Candidacy appears only from nomination or announcement sources.')
    await expect(page.getByRole('columnheader', { name: /Observed in directory from/ })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /Observed in directory to/ })).toBeVisible()
    await expect(page.getByTestId('data-row')).toHaveCount(8)
    await expect(page.getByTestId('data-row').first()).toContainText('Fixture Member 01')
    await expect(page.getByTestId('data-row').first()).toContainText('not established')
    await page.getByLabel('Representation').selectOption('list')
    await expect(page.getByTestId('data-row')).toHaveCount(3)
    await page.screenshot({ path: `${SCREENS}/09-parliament.png` })
  })

  test('elections: unknown is not zero, and unreported votes are words', async ({ page, request }) => {
    // Counts are taken from the rights-filtered candidacies view; the elections view publishes no cross-source count.
    const response = await request.get(`${REST}/candidacies?select=id&election_slug=eq.general-2026&current_status=eq.officially_nominated&limit=1`, { headers: restHeaders() })
    const nominated = (await response.json()) as unknown[]
    const election = { officially_nominated: nominated.length }
    await page.goto('/elections')
    const card = page.getByTestId('election-general-2026')
    await expect(card).toBeVisible()
    // Real rows may be loaded into this database later; the note must track the data, not the fixture.
    if (election && Number(election.officially_nominated) === 0) {
      await expect(card.getByTestId('no-nominations-note')).toHaveText('No official nominations loaded. Unknown, not zero.')
      await card.getByRole('link').first().click()
      await expect(page.getByTestId('no-nominations-note')).toHaveText('No official nominations loaded. Unknown, not zero.')
    }

    await page.goto('/elections/general-2023?electorate=Fixture%20Electorate%20A')
    await expect(page.getByTestId('data-row')).toHaveCount(3)
    // Default order is alphabetical by candidate within the electorate, not by votes.
    await expect(page.getByTestId('data-row').nth(0)).toContainText('Fixture Candidate Aroha')
    await expect(page.getByTestId('data-row').nth(1)).toContainText('Fixture Candidate Bryn')
    await expect(page.getByTestId('data-row').nth(2)).toContainText('Fixture Candidate Cass')
    const cass = page.getByTestId('data-row').filter({ hasText: 'Fixture Candidate Cass' })
    await expect(cass.getByTestId('votes-cell')).toHaveText('not reported')
    await expect(cass.getByTestId('votes-cell')).toHaveAttribute('data-votes-status', 'not_reported')
    await expect(cass).toContainText('label, not a registered party')
    // The opposite case must hold too: a figure the source reported as zero is shown as 0, not as missing.
    await page.goto('/elections/general-2023?electorate=Fixture%20Electorate%20B')
    const eru = page.getByTestId('data-row').filter({ hasText: 'Fixture Candidate Eru' })
    await expect(eru.getByTestId('votes-cell')).toContainText('0')
    await expect(eru.getByTestId('votes-cell')).toHaveAttribute('data-votes-status', 'reported')
    await page.goto('/elections/general-2023?electorate=Fixture%20Electorate%20A')
    await expect(page.getByTestId('data-row').nth(0).getByTestId('votes-cell')).toContainText('1,200')
    await expect(page.getByTestId('status-officially_nominated').first()).toHaveText('Officially nominated')
    // Votes cannot be used to order the list.
    await expect(page.getByRole('button', { name: /Candidate votes/ })).toHaveCount(0)

    await page.goto('/elections/general-2023?type=list&party=Fixture%20Party')
    // Scoped to this suite's own candidates: other fixture suites may share the local database.
    await expect(page.getByTestId('data-row').filter({ hasText: 'Fixture Candidate' })).toHaveCount(2)
    for (const cell of await page.getByTestId('votes-cell').all()) await expect(cell).toHaveText('not applicable (list candidacy)')
    await page.screenshot({ path: `${SCREENS}/10-election.png`, fullPage: true })
  })

  test('people make unresolved identities explicit', async ({ page }) => {
    await page.goto('/people?source=fixture_baseline&q=Aroha')
    await expect(page.getByTestId('unresolved-note')).toContainText('Not linked to a canonical person — identities are never merged by name')
    // Same name twice in one source: two identities, never merged.
    await expect(page.getByTestId('data-row')).toHaveCount(2)
    await page.getByTestId('data-row').first().getByRole('link').click()
    await expect(page.getByTestId('identity-unresolved')).toContainText('identities are never merged by name')
    await expect(page.getByRole('table', { name: 'Open identity proposals' })).toContainText('Name similarity nomination')
  })

  test('the graph starts from one node, stays bounded, and expands on click', async ({ page }) => {
    const identityId = psql(`select i.id from evidence_private.person_source_identities i where i.source_id = 'fixture_mp_directory' and i.external_id = 'fixture-member-01';`)
    const edgeRequests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/rest/v1/graph_edges')) edgeRequests.push(decodeURIComponent(request.url()))
    })
    await page.goto(`/graph?kind=person_identity&id=${identityId}`)
    const nodes = page.getByTestId('graph-node')
    // Member 01 → party label, electorate label.
    await expect(nodes).toHaveCount(3)
    await expect(page.getByTestId('graph-counts')).toContainText('3 of at most 300 nodes')
    await expect(page.getByTestId('graph-edge-row')).toHaveCount(2)
    await page.screenshot({ path: `${SCREENS}/11-graph-start.png`, fullPage: true })

    await page.locator('[data-testid="graph-node"]', { hasText: 'Fixture Party B' }).click()
    // Party B is the label of members 01, 03, 05 and 07 → three more identities appear.
    await expect(nodes).toHaveCount(6)
    await expect(page.getByTestId('graph-edge-row')).toHaveCount(5)

    // Keyboard-accessible fallback expands too.
    await page.getByTestId('graph-expand-list').getByRole('button', { name: /Expand Fixture Member 03/ }).click()
    await expect(nodes).toHaveCount(7)
    await expect(page.getByTestId('graph-edge-table').getByTestId('evidence-link').first()).toBeVisible()

    expect(edgeRequests.length).toBeGreaterThanOrEqual(3)
    for (const url of edgeRequests) {
      expect(url).toContain('limit=50')
      // A node is (kind, id): every expansion names BOTH on each side, never the id alone.
      expect(url).toMatch(/or=\(and\(from_kind\.eq\.[a-z_]+,from_id\.eq\."[^"]+"\),and\(to_kind\.eq\.[a-z_]+,to_id\.eq\."[^"]+"\)\)/)
    }
    await page.screenshot({ path: `${SCREENS}/12-graph-expanded.png`, fullPage: true })
  })

  test('party labels and electorates link to their own pages, and each page opens its own graph', async ({ page }) => {
    await page.goto('/parliament?source=fixture_mp_directory&party=Fixture%20Party%20B')
    await page.getByTestId('party-link').first().click()
    await expect(page).toHaveURL(/\/parties\/[0-9a-f-]{36}$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Fixture Party B' })).toBeVisible()
    await expect(page.getByText('It is not a registered party')).toBeVisible()
    await expect(page.getByTestId('party-member-row').first()).toContainText('Fixture Member')
    // A member row links on to that member's identity page.
    await expect(page.getByTestId('party-member-row').first().getByRole('link').first()).toHaveAttribute('href', /\/people\/[0-9a-f-]{36}$/)
    await page.screenshot({ path: `${SCREENS}/18-party-identity.png`, fullPage: true })
    await page.getByTestId('open-graph').click()
    await expect(page).toHaveURL(/kind=party_identity/)
    await expect(page.getByTestId('graph-node').first()).toBeVisible()

    await page.goto('/elections/general-2023?electorate=Fixture%20Electorate%20A')
    await page.getByTestId('electorate-link').first().click()
    await expect(page).toHaveURL(/\/electorates\/[0-9a-f-]{36}$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Fixture Electorate A' })).toBeVisible()
    await expect(page.getByTestId('electorate-unverified')).toContainText('have not been verified')
    await expect(page.getByTestId('electorate-candidacy-row')).toHaveCount(3)
    // Alphabetical, never by votes; a missing figure is words.
    await expect(page.getByTestId('electorate-candidacy-row').nth(0)).toContainText('Fixture Candidate Aroha')
    await expect(page.getByTestId('electorate-candidacy-row').nth(2).getByTestId('votes-cell')).toHaveText('not reported')
    await page.screenshot({ path: `${SCREENS}/19-electorate-version.png`, fullPage: true })
    await page.getByTestId('open-graph').click()
    await expect(page).toHaveURL(/kind=electorate_version/)

    // Unknown or malformed ids are "not found", never an error and never a broadened query.
    await page.goto('/parties/not-a-uuid')
    await expect(page.getByRole('heading', { level: 1, name: 'Party identity not found' })).toBeVisible()
    await page.goto('/electorates/00000000-0000-4000-8000-000000000000')
    await expect(page.getByRole('heading', { level: 1, name: 'Electorate version not found' })).toBeVisible()
  })

  test('the graph offers only supported start kinds, finds a root of the chosen kind, and nodes link to their pages', async ({ page }) => {
    await page.goto('/graph')
    const kinds = await page.getByLabel('Start from a').locator('option').allInnerTexts()
    expect(kinds.join('|')).toContain('Party label at source')
    expect(kinds.join('|')).toContain('Electorate (boundary edition)')
    expect(kinds.join('|')).not.toMatch(/Reviewed person|canonical/i)

    await page.getByLabel('Start from a').selectOption('party_identity')
    await page.getByLabel('Party label contains').fill('Fixture Party B')
    await page.getByLabel('Party label contains').press('Enter')
    await page.getByTestId('root-results').getByRole('link', { name: 'Fixture Party B' }).first().click()
    await expect(page).toHaveURL(/kind=party_identity&id=[0-9a-f-]{36}/)
    await expect(page.getByTestId('graph-node').first()).toBeVisible()
    const entityLinks = page.getByTestId('graph-entity-links').getByTestId('graph-entity-link')
    await expect(entityLinks.first()).toBeVisible()
    const hrefs = await entityLinks.evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''))
    expect(hrefs.some((h) => /\/parties\//.test(h))).toBe(true)
    expect(hrefs.some((h) => /\/people\//.test(h))).toBe(true)
    // The canonical person linked to one of these members privately is not a node and not a link.
    await expect(page.locator('body')).not.toContainText('CANONICAL')

    // Unexpected URL input never reaches a page: dropped keys do not survive through the router's search merge.
    await page.goto('/records?scope=everything&sort=safe_payload&dir=sideways&evil=1&source=fixture_bills')
    await expect(page.getByTestId('data-row').first()).toBeVisible()
    await expect(page.getByLabel('Scope')).toHaveValue('')
    await page.getByRole('button', { name: 'Next' }).click()
    expect(new URL(page.url()).searchParams.has('evil')).toBe(false)
    expect(new URL(page.url()).searchParams.get('sort')).toBeNull()

    // A withheld kind cannot be forced through the URL.
    await page.goto('/graph?kind=person&id=f1f1f1f1-0000-4000-8000-0000000000aa')
    await expect(page.getByRole('heading', { name: 'Choose one start node' })).toBeVisible()
    await page.screenshot({ path: `${SCREENS}/20-graph-roots.png`, fullPage: true })
  })

  test('loading state is announced while a request is in flight', async ({ page }) => {
    await page.route('**/rest/v1/records*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await route.continue()
    })
    await page.goto(`/records?source=${BILLS}`)
    const loading = page.getByTestId('loading-state')
    await expect(loading).toBeVisible()
    await expect(loading).toHaveAttribute('aria-busy', 'true')
    await page.screenshot({ path: `${SCREENS}/13-loading-state.png` })
    await expect(page.getByTestId('data-row')).toHaveCount(25)
    await expect(loading).toHaveCount(0)
  })

  test('error state shows the PostgREST message and retry recovers', async ({ page }) => {
    // Simulated failure of a real endpoint.
    await page.route('**/rest/v1/records*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'simulated upstream failure', details: null, hint: null }) }),
    )
    await page.goto(`/records?source=${BILLS}`)
    const error = page.getByTestId('error-state')
    await expect(error).toBeVisible()
    await expect(error).toContainText('XX000: simulated upstream failure')
    await expect(error).toContainText('An error is not evidence that no records exist.')
    await expect(page.getByTestId('data-row')).toHaveCount(0)
    await page.screenshot({ path: `${SCREENS}/14-error-state.png` })
    await page.unroute('**/rest/v1/records*')
    await error.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByTestId('data-row')).toHaveCount(25)
  })

  test('write attempts from the browser, through the app client, are refused by the database', async ({ page }) => {
    const snapshot = () => psql(`select id || '|' || record_kind || '|' || (select count(*) from evidence_private.source_records where source_id = '${BILLS}') from evidence_private.source_records where source_id = '${BILLS}' and external_record_id = 'fixture-bill-002';`)
    const before = snapshot()
    const [recordId] = before.split('|')
    await page.goto('/records')
    await expect(page.getByTestId('data-row').first()).toBeVisible()

    const outcome = await page.evaluate(async (id) => {
      interface Result { error: { code?: string; message: string } | null; data: unknown; status: number }
      interface LooseTable { update(v: object): { eq(c: string, v: string): { select(): Promise<Result> } }; insert(v: object): { select(): Promise<Result> }; delete(): { eq(c: string, v: string): { select(): Promise<Result> } } }
      interface LooseClient { from(name: string): LooseTable; schema(name: string): LooseClient; rpc(name: string): Promise<Result> }
      // The application's own client module: exactly what a visitor's browser holds.
      const mod = (await import(/* @vite-ignore */ `${location.origin}/src/lib/supabase.ts`)) as { getSupabase: () => unknown }
      const supabase = mod.getSupabase() as LooseClient
      const summarise = (r: Result) => ({ errorMessage: r.error?.message ?? null, rows: Array.isArray(r.data) ? r.data.length : 0, status: r.status })
      const open = supabase.schema('evidence_open')
      return [
        summarise(await supabase.from('records').update({ record_kind: 'tampered' }).eq('id', id).select()),
        summarise(await supabase.from('records').insert({ source_id: 'fixture_bills', external_record_id: 'fixture-injected', record_kind: 'bill' }).select()),
        summarise(await supabase.from('records').delete().eq('id', id).select()),
        summarise(await supabase.from('record_versions').update({ safe_payload: {} }).eq('record_id', id).select()),
        summarise(await open.from('source_records').update({ record_kind: 'tampered' }).eq('id', id).select()),
        summarise(await open.from('source_rights').update({ review_status: 'approved' }).eq('rights_id', 'RIGHTS-01').select()),
        summarise(await open.from('release_gates').update({ state: 'closed' }).eq('gate_key', 'r10_public_surface_review').select()),
        summarise(await open.from('source_records').delete().eq('id', id).select()),
        summarise(await supabase.rpc('rebuild_exposed_views')),
      ]
    }, recordId ?? '')

    for (const attempt of outcome) {
      expect(attempt.errorMessage, JSON.stringify(attempt)).not.toBeNull()
      expect(attempt.rows).toBe(0)
      expect(attempt.status).toBeGreaterThanOrEqual(400)
    }
    expect(snapshot()).toBe(before)
    expect(psql(`select count(*) from evidence_private.source_records where external_record_id = 'fixture-injected';`)).toBe('0')
    expect(psql(`select count(*) from evidence_private.source_rights where review_status <> 'pending' and rights_id = 'RIGHTS-01';`)).toBe('0')
  })
})
