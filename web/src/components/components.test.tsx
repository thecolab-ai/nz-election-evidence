import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderCell } from '@/routes/datasets'
import { SURFACE_STATUS_COLUMNS } from '@/routes/access'
import { coverageCounts, heldFor, ledgerRouteIds, NOT_PUBLISHED_FOR_2026, RELEASE_COVERAGE } from '@/lib/release-coverage'
import { RECORDS_NOT_COUNTED_HERE, RELEASE_COVERAGE_SELECT, routeWords } from './release-coverage'
import { AccountabilityFooter } from './footer'
import { figureWords, OwnerOverrideNotice, ownerBasis, showsDonationFacts } from './owner-override-notice'
import { PREVIEW_BANNER, PreviewBanner } from './shell'
import { EmptyBlock, ErrorBlock } from './states'
import { SummaryCard } from './summary-card'
import type { SummaryRow, SurfaceStatusRow } from '@/lib/types'

describe('compliance text on every page', () => {
  it('footer names the project, the maintainer, independence, pending review, and links the three policy documents (R8)', () => {
    render(<AccountabilityFooter />)
    const footer = screen.getByRole('contentinfo', { name: 'Project accountability and policy links' })
    for (const phrase of ['Responsible project:', 'The Colab — NZ Election Evidence project', 'Project maintainer/contact:', 'Adam Holt', 'New Zealand Parliament', 'Electoral Commission', 'any political party or candidate', 'Legal review remains pending']) {
      expect(footer.textContent).toContain(phrase)
    }
    // R8 is a human gate: until someone accepts the role the footer must say so, and must not present the maintainer as that person.
    expect(screen.getByTestId('accountable-person').textContent).toContain('Accountable person: not yet confirmed')
    expect(screen.getByTestId('accountable-person').textContent).not.toContain('Adam Holt')
    expect(footer.textContent).toContain('repository owner’s own recorded decision')
    expect(footer.textContent).toContain('is not a substitute for either')
    const hrefs = Array.from(footer.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('https://github.com/thecolab-ai/nz-election-evidence/issues')
    for (const file of ['RED-LINES.md', 'CORRECTIONS.md', 'REVIEW-REGISTER.md']) expect(hrefs).toContain(`https://github.com/thecolab-ai/nz-election-evidence/blob/main/${file}`)
    for (const a of Array.from(footer.querySelectorAll('a'))) expect(a.getAttribute('rel')).toContain('noopener')
  })
  it('banner says what this is and is not, without scanner-listed wording', () => {
    render(<PreviewBanner />)
    expect(screen.getByTestId('preview-banner').textContent).toContain('Public read-only evidence register')
    expect(PREVIEW_BANNER).toContain('Nothing here is a finding, a ranking or a recommendation.')
    expect(PREVIEW_BANNER).not.toMatch(/\b(lied|lies|liar|fraud|corrupt|vote for|vote against|re-?elect)\b/i)
  })
})

describe('states', () => {
  it('an empty table is never presented as evidence of absence', () => {
    render(<EmptyBlock />)
    expect(screen.getByTestId('empty-state').textContent).toBe('No rows. This may mean nothing has been ingested yet — it is not evidence of absence.')
  })
  it('an error shows the service message and is not evidence of absence either', () => {
    render(<ErrorBlock error={{ message: 'simulated failure (TEST FIXTURE)', code: 'XX000' }} />)
    expect(screen.getByTestId('error-state').textContent).toContain('XX000: simulated failure (TEST FIXTURE)')
    expect(screen.getByTestId('error-state').textContent).toContain('An error is not evidence that no records exist.')
  })
})

describe('generic dataset cells', () => {
  it('says null plainly and never prints it as zero or blank', () => {
    const { container } = render(<>{renderCell(null)}</>)
    expect(container.textContent).toBe('null')
  })
  it('truncates long text and keeps structured values behind the viewer', () => {
    const long = render(<>{renderCell('x'.repeat(300))}</>)
    expect(long.container.textContent?.length).toBeLessThan(130)
    const structured = render(<>{renderCell({ title: 'TEST FIXTURE value' })}</>)
    expect(structured.container.textContent).not.toContain('TEST FIXTURE value')
  })
})

describe('model output card (R9)', () => {
  const base: SummaryRow = {
    id: 's1', summary_text: 'TEST FIXTURE summary text', output_hash: 'sha256:x', uncertainty_note: null, review_status: 'approved', created_at: '2026-09-20T00:00:00Z',
    model_metadata_status: 'recorded', provider: 'TEST FIXTURE', model_name: 'fixture-model', model_version: '1.0', prompt_or_schema_version: 'fixture-schema-v1',
    confidence: null, confidence_status: 'not_reported', confidence_basis: null, schema_agreement_rate: null, schema_agreement_sample: null,
    schema_agreement_method_url: null, schema_agreement_validated_at: null, schema_agreement_documented: false,
  }
  it('an approved output with no agreement study still carries the human-review flag, and unknown confidence is said, not shown as a number', () => {
    render(<SummaryCard summary={base} />)
    expect(screen.getByTestId('not-human-reviewed').textContent).toBe('not yet checked against human review')
    expect(screen.getByTestId('summary-confidence').textContent).toBe('not reported by the model run')
    expect(screen.getByTestId('summary-confidence').textContent).not.toMatch(/\d/)
    expect(screen.getByTestId('summary-agreement').textContent).toBe('none documented for this schema version')
    expect(screen.getByTestId('summary-model').textContent).toBe('fixture-model')
  })
  it('a reported confidence shows with its basis; a documented agreement rate clears the flag and links the method', () => {
    render(<SummaryCard summary={{ ...base, confidence: 0, confidence_status: 'reported', confidence_basis: 'self-reported 0-1', schema_agreement_documented: true,
      schema_agreement_rate: 0.85, schema_agreement_sample: 40, schema_agreement_method_url: 'https://fixture.example/method' }} />)
    expect(screen.getByTestId('summary-confidence').textContent).toBe('0.00 (self-reported 0-1)')
    expect(screen.queryByTestId('not-human-reviewed')).toBeNull()
    expect(screen.getByTestId('summary-agreement').textContent).toContain('85.0% agreement with human reviewers on a sample of 40')
    expect(screen.getByRole('link', { name: /method/ }).getAttribute('href')).toBe('https://fixture.example/method')
  })
})

describe('owner override: stated as what it is, never as a review or a publisher approval', () => {
  const gate = (patch: Partial<SurfaceStatusRow>): SurfaceStatusRow => ({
    gate_key: 'r10_public_surface_review', state: 'closed', evidence_reference: null, decided_at: null, public_rows_released: true,
    release_basis: 'owner_override', owner_authorization_id: 'OWNER-AUTH-2026-09-20-01', owner_decided_on: '2026-09-20', owner_expires_on: '2026-11-06',
    owner_fields_in_force: true, owner_figure_scopes: [], ...patch,
  })
  const both = (patch: Partial<SurfaceStatusRow>) => [gate(patch), gate({ ...patch, gate_key: 'r8_accountable_legal_entity' })]
  it('names the decision, its dates, the reviews still outstanding (read from the gates) and the absence of any publisher approval', () => {
    render(<OwnerOverrideNotice status={both({})} />)
    const text = screen.getByTestId('owner-override-notice').textContent ?? ''
    for (const phrase of ['repository owner’s decision', 'ahead of independent review', '(R10)', '(R8)', 'Not yet on record', 'Those release gates read closed', 'does not open or replace them', 'No publisher has approved or licensed the fields shown', 'OWNER-AUTH-2026-09-20-01', 'in force until']) {
      expect(text).toContain(phrase)
    }
    expect(text).not.toMatch(/\b(legally reviewed|review complete|approved by (the )?(publisher|reviewer)|licensed by)\b/i)
    const hrefs = Array.from(screen.getByTestId('owner-override-notice').querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('https://github.com/thecolab-ai/nz-election-evidence/blob/main/governance/owner-authorizations.json')
    expect(hrefs).toContain('https://github.com/thecolab-ai/nz-election-evidence/blob/main/REVIEW-REGISTER.md')
  })
  it('asks the database for every field the notice reads: a column left out of the select blanks a sentence', () => {
    // The notice is data-driven, so a missing column is not a type error - it is a sentence that quietly stops
    // appearing. Every field the component reads must therefore be in the query that feeds it.
    for (const column of ['release_basis', 'public_rows_released', 'owner_authorization_id', 'owner_decided_on',
                          'owner_expires_on', 'owner_fields_in_force', 'owner_figure_scopes', 'gate_key', 'state']) {
      expect(SURFACE_STATUS_COLUMNS.split(',')).toContain(column)
    }
  })
  it('says what a donation row is, and what it can never hold, once donation facts rest on the decision', () => {
    render(<OwnerOverrideNotice status={both({ owner_figure_scopes: ['published_donation_facts'] })} />)
    const text = screen.getByTestId('owner-override-notice').textContent ?? ''
    expect(text).toContain('the donations, loans and contributions each filed return discloses')
    expect(text).toContain('Donations are shown as the filed return discloses them.')
    expect(text).toContain('No street address, contact detail or signature is held anywhere in this store')
    expect(text).toContain('an identity the law withholds stays withheld')
    // The older sentence claimed no donation record existed. It must not appear once one does.
    expect(text).not.toContain('this project has never collected a donation record')
    expect(showsDonationFacts(['published_poll_figures'])).toBe(false)
    expect(showsDonationFacts(null)).toBe(false)
  })
  it('names the kinds of figure that rest on the decision, from the database, and never poll figures', () => {
    render(<OwnerOverrideNotice status={both({ owner_figure_scopes: ['official_finance_figures', 'official_result_figures', 'published_poll_figures', 'statistical_facts'] })} />)
    const text = screen.getByTestId('owner-override-notice').textContent ?? ''
    expect(text).toContain('the vote counts, shares, seat numbers and list positions the official election-results publications printed')
    expect(text).toContain('the donation, expense and loan totals the Electoral Commission prints on its own public index pages')
    expect(text).toContain('the published figures of official statistics')
    expect(text).toContain('the party-vote percentages each pollster published, each shown beside whether that pollster disclosed a methodology')
    expect(text).toContain('Nothing is read from inside a finance return, and no donor is named anywhere')
    expect(screen.getByTestId('owner-override-notice').querySelector('[data-testid="owner-notice-donations"]')).toBeNull()
    // A scope the database does not report is not claimed, and an unknown kind is not invented.
    expect(figureWords(['statistical_facts'])).toEqual(['the published figures of official statistics'])
    expect(figureWords(['something_new', null as unknown as string])).toEqual([])
    expect(figureWords(null)).toEqual([])
    const none = render(<OwnerOverrideNotice status={both({})} />).container
    expect(none.querySelector('[data-testid="owner-notice-figures"]')).toBeNull()
    expect(none.textContent).toContain('no donor is named anywhere')
  })
  it('says only what the gates say: one review on record leaves only the other named as outstanding', () => {
    render(<OwnerOverrideNotice status={[gate({ state: 'open' }), gate({ gate_key: 'r8_accountable_legal_entity' })]} />)
    const gates = screen.getByTestId('owner-notice-gates').textContent ?? ''
    expect(gates).toContain('(R8)')
    expect(gates).not.toContain('(R10)')
    expect(gates).toContain('That release gate reads closed')
  })
  it('stays up after the reviews are recorded while fields are still shown on the owner decision, without claiming gates are closed', () => {
    const recorded = both({ state: 'open', release_basis: 'reviews_recorded', owner_fields_in_force: true })
    expect(ownerBasis(recorded)?.rowsOnOwnerDecision).toBe(false)
    render(<OwnerOverrideNotice status={recorded} />)
    const text = screen.getByTestId('owner-override-notice').textContent ?? ''
    expect(text).toContain('Names and titles are shown on the repository owner’s decision')
    expect(text).toContain('No publisher has approved or licensed the fields shown')
    expect(text).not.toContain('closed')
    expect(screen.queryByTestId('owner-notice-gates')).toBeNull()
  })
  it('is absent when nothing rests on an owner decision, and before the database has answered', () => {
    expect(ownerBasis(undefined)).toBeNull()
    expect(ownerBasis([])).toBeNull()
    expect(ownerBasis(both({ release_basis: 'none', public_rows_released: false, owner_fields_in_force: false }))).toBeNull()
    expect(ownerBasis(both({ release_basis: 'reviews_recorded', state: 'open', owner_fields_in_force: false }))).toBeNull()
    // A claimed basis without released rows is not an override in force.
    expect(ownerBasis(both({ public_rows_released: false }))).toBeNull()
    const { container } = render(<OwnerOverrideNotice status={both({ release_basis: 'none', public_rows_released: false, owner_fields_in_force: false })} />)
    expect(container.textContent).toBe('')
  })
})

describe('release coverage keeps routes and held data apart', () => {
  it('every one of the 26 products has a backfill route; a route is never counted as held data', () => {
    const counts = coverageCounts()
    expect(counts.total).toBe(26)
    expect(counts.with_backfill_route).toBe(26)
    expect(counts.with_refresh_route + counts.without_refresh_route).toBe(26)
    for (const row of RELEASE_COVERAGE) {
      // A product without a working refresh route always says why.
      if (row.refresh !== 'scheduled' && row.refresh !== 'operator_run') expect(row.refresh_gap, row.product_id).toBeTruthy()
      // Nothing is held until the database says so, and with no rows at all nothing is undetermined either.
      expect(heldFor(row, []), row.product_id).toMatchObject({ held: false, routes: [], undetermined: [] })
    }
  })
  it('held is read from the store: typed observations for a statistics source, never a guess', () => {
    const p23 = RELEASE_COVERAGE.find((row) => row.product_id === 'P23')!
    // A source that has never been loaded reports a null observation count, which a statistics source and a ledger
    // source share; until the probe answers, the honest reading is undetermined rather than empty.
    const never = heldFor(p23, [{ source_id: 'stats_tenancy_rental_bonds', statistical_observations: null, statistical_catalogue_entries: null, last_success_at: null }])
    expect(never).toMatchObject({ held: false, sources_seen: 1, routes: [], undetermined: ['stats_tenancy_rental_bonds'] })
    const empty = heldFor(p23, [{ source_id: 'stats_tenancy_rental_bonds', statistical_observations: 0, statistical_catalogue_entries: 0, last_success_at: '2026-09-20T10:00:00Z' }])
    // Loaded and counted at zero is an answer the row itself carries: not held, and nothing left to probe.
    expect(empty).toMatchObject({ held: false, sources_seen: 1, routes: [], undetermined: [] })
    const loaded = heldFor(p23, [{ source_id: 'stats_tenancy_rental_bonds', statistical_observations: '57888', statistical_catalogue_entries: 4, last_success_at: '2026-09-20T10:00:00Z' }])
    expect(loaded.held).toBe(true)
    expect(loaded.routes).toEqual([{ source_id: 'stats_tenancy_rental_bonds', ledger_records: null, statistical_observations: 57888, catalogue_entries: 4, holds_records: false }])
    // A source of another product never counts towards this one.
    expect(heldFor(p23, [{ source_id: 'stats_msd_benefits', statistical_observations: 903, statistical_catalogue_entries: 26, last_success_at: '2026-09-20T10:00:00Z' }]).held).toBe(false)
  })
  it('a ledger route is held on an existence probe, and carries no record count at all', () => {
    const p24 = RELEASE_COVERAGE.find((row) => row.product_id === 'P24')!
    const rows = [
      { source_id: 'parliament_export_written_questions', statistical_observations: null, statistical_catalogue_entries: null, last_success_at: '2026-09-20T10:00:00Z' },
      { source_id: 'nz_parliament_written_questions_recent', statistical_observations: null, statistical_catalogue_entries: null, last_success_at: '2026-09-20T11:00:00Z' },
    ]
    const held = heldFor(p24, rows, new Map([['parliament_export_written_questions', true], ['nz_parliament_written_questions_recent', true]]))
    expect(held.routes.map((r) => r.source_id)).toEqual(['parliament_export_written_questions', 'nz_parliament_written_questions_recent'])
    // The count that timed out for real readers is not read, not summed, and not stood in for by a zero.
    expect(held.routes.every((r) => r.ledger_records === null)).toBe(true)
    expect(JSON.stringify(held)).not.toContain('187956')
    expect(JSON.stringify(held)).not.toContain('189956')
    // A route the probe answered no for holds nothing; a route it answered for at all is never undetermined.
    const ranEmpty = heldFor(p24, rows, new Map([['parliament_export_written_questions', false], ['nz_parliament_written_questions_recent', false]]))
    expect(ranEmpty).toMatchObject({ held: false, routes: [], undetermined: [] })
  })
  it('a ledger route nothing answered for is undetermined, never reported as empty', () => {
    const p24 = RELEASE_COVERAGE.find((row) => row.product_id === 'P24')!
    const rows = [{ source_id: 'parliament_export_written_questions', statistical_observations: null, statistical_catalogue_entries: null, last_success_at: '2026-09-20T10:00:00Z' }]
    const unknown = heldFor(p24, rows)
    expect(unknown).toMatchObject({ held: false, routes: [], undetermined: ['parliament_export_written_questions'] })
    // Held and not-held are both claims; this is neither, so the panel must be able to tell the three apart.
    expect(unknown.undetermined.length > 0 && !unknown.held).toBe(true)
    // One answered route is enough for the product to read as held; the unanswered one is not called empty.
    const partly = heldFor(p24, [...rows, { source_id: 'nz_parliament_written_questions_recent', statistical_observations: null, statistical_catalogue_entries: null, last_success_at: null }], new Map([['parliament_export_written_questions', true]]))
    expect(partly).toMatchObject({ held: true, undetermined: ['nz_parliament_written_questions_recent'] })
  })
  it('probes only the ledger routes the store returned: statistics rows already carry exact figures', () => {
    const ids = ledgerRouteIds([
      { source_id: 'parliament_export_written_questions', statistical_observations: null, statistical_catalogue_entries: null, last_success_at: null },
      { source_id: 'stats_tenancy_rental_bonds', statistical_observations: 0, statistical_catalogue_entries: 0, last_success_at: null },
      { source_id: 'not_a_catalogue_route', statistical_observations: null, statistical_catalogue_entries: null, last_success_at: null },
    ])
    expect(ids).toEqual(['parliament_export_written_questions'])
    // A source whose rights allow no release is not returned by the view, so it is never asked about.
    expect(ledgerRouteIds([])).toEqual([])
  })
  it('the panel does not ask the store for the count that timed out, and says where it is counted instead', () => {
    expect(RELEASE_COVERAGE_SELECT.split(',')).not.toContain('live_records')
    expect(RELEASE_COVERAGE_SELECT.split(',')).toEqual(['source_id', 'statistical_observations', 'statistical_catalogue_entries', 'last_success_at'])
    const words = routeWords({ source_id: 'parliament_export_written_questions', ledger_records: null, statistical_observations: 0, catalogue_entries: 0, holds_records: true })
    expect(words).toBe(RECORDS_NOT_COUNTED_HERE)
    expect(words).toMatch(/counted on the source’s own page/)
    expect(words).not.toMatch(/\d/)
    // Statistics figures are written by the loader and read from a summary row, so they stay exact.
    expect(routeWords({ source_id: 'stats_tenancy_rental_bonds', ledger_records: null, statistical_observations: 57888, catalogue_entries: 4, holds_records: false })).toBe('57,888 observations · 4 catalogue entries')
  })
  it('says plainly what the 2026 election routes do not publish', () => {
    expect(NOT_PUBLISHED_FOR_2026.some((line) => /nominations/.test(line) && /unknown/.test(line))).toBe(true)
    expect(NOT_PUBLISHED_FOR_2026.join(' ')).not.toMatch(/\b0 (candidates|nominations|electorates)\b/)
  })
})
