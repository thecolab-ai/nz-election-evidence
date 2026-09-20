import { expect, test } from '@playwright/test'
import { accessToken, REST, restHeaders, SCREENS, setGates, type Profile } from './support/helpers'
import { LOCAL_API_URL, localKeys, psql } from './support/local-stack'

test.describe('public read-only boundary', () => {
  test('an anonymous visitor browses evidence with no sign-in, and sees the accountability footer', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible()
    await expect(page.getByTestId('preview-banner')).toContainText('Public read-only evidence register')
    await expect(page.getByTestId('preview-banner')).toContainText('Nothing here is a finding, a ranking or a recommendation.')
    await expect(page.getByRole('link', { name: /sign in|log in/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /sign in|sign up|create account|register/i })).toHaveCount(0)

    const footer = page.getByRole('contentinfo', { name: 'Project accountability and policy links' })
    await expect(footer).toContainText('Responsible project: The Colab — NZ Election Evidence project')
    await expect(footer).toContainText('Project maintainer/contact: Adam Holt')
    await expect(footer).toContainText('not affiliated with, endorsed by, or acting for the New Zealand Parliament, the Electoral Commission, or any political party or candidate')
    await expect(footer).toContainText('Legal review remains pending')
    for (const file of ['RED-LINES.md', 'CORRECTIONS.md', 'REVIEW-REGISTER.md']) {
      await expect(footer.locator(`a[href="https://github.com/thecolab-ai/nz-election-evidence/blob/main/${file}"]`)).toHaveCount(1)
    }

    await page.goto('/records?source=fixture_bills')
    await expect(page.getByTestId('data-row').first()).toBeVisible()
    // Nothing identifying is kept in the browser: no session, no token.
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
    expect(stored).not.toMatch(/access_token|refresh_token|sb-.*-auth/)
    await page.screenshot({ path: `${SCREENS}/01-anonymous-records.png`, fullPage: true })
  })

  test('anonymous REST: every public layer reads, the dataset catalogue is complete, withheld columns do not exist', async ({ request }) => {
    for (const view of ['records', 'sources', 'record_versions', 'person_identities', 'graph_edges', 'import_runs', 'fetch_log', 'rights_register', 'elections', 'dataset_catalogue', 'dataset_columns', 'surface_status']) {
      const response = await request.get(`${REST}/${view}?select=*&limit=1`, { headers: restHeaders() })
      expect(response.status(), `evidence_public.${view}`).toBe(200)
    }
    for (const table of ['source_records', 'source_record_versions', 'source_observations', 'parliamentary_service_terms', 'bills', 'public_withheld', 'stat_observations']) {
      const response = await request.get(`${REST}/${table}?select=*&limit=1`, { headers: restHeaders(undefined, 'evidence_open') })
      expect(response.status(), `evidence_open.${table}`).toBe(200)
    }

    const catalogue = (await (await request.get(`${REST}/dataset_catalogue?select=exposed_schema,dataset,disposition,withheld_reason&limit=200`, { headers: restHeaders() })).json()) as Array<{ exposed_schema: string; dataset: string; disposition: string; withheld_reason: string | null }>
    expect(catalogue.length).toBeGreaterThan(80)
    for (const entry of catalogue.filter((c) => c.disposition === 'withheld')) expect(entry.withheld_reason, entry.dataset).toBeTruthy()
    // Every table the catalogue calls public is really readable; every one it calls withheld really is not.
    for (const entry of catalogue.filter((c) => c.exposed_schema === 'evidence_open')) {
      const response = await request.get(`${REST}/${entry.dataset}?select=*&limit=1`, { headers: restHeaders(undefined, 'evidence_open') })
      expect(response.status(), entry.dataset).toBe(entry.disposition === 'public' ? 200 : 404)
    }

    const columns = (await (await request.get(`${REST}/dataset_columns?select=exposed_schema,dataset,column_name,withheld_reason&disposition=eq.withheld&limit=200`, { headers: restHeaders() })).json()) as Array<{ exposed_schema: string; dataset: string; column_name: string; withheld_reason: string | null }>
    expect(columns.length).toBeGreaterThan(5)
    for (const column of columns) {
      expect(column.withheld_reason, `${column.dataset}.${column.column_name}`).toBeTruthy()
      const response = await request.get(`${REST}/${column.dataset}?select=${column.column_name}&limit=1`, { headers: restHeaders(undefined, column.exposed_schema as Profile) })
      expect([400, 404], `${column.exposed_schema}.${column.dataset}.${column.column_name}`).toContain(response.status())
    }
  })

  test('source rights: a pending publisher gets links and metadata only, in EVERY public dataset and on every page', async ({ page, request }) => {
    // The pending fixture source stores content that contains the word WITHHELD. Walk the whole published
    // catalogue: no public dataset, curated or per-table, may return it.
    const catalogue = (await (await request.get(`${REST}/dataset_catalogue?select=exposed_schema,dataset&disposition=eq.public&limit=200`, { headers: restHeaders() })).json()) as Array<{ exposed_schema: Profile; dataset: string }>
    expect(catalogue.length).toBeGreaterThan(80)
    let rowsSeen = 0
    for (const entry of catalogue) {
      for (let offset = 0; offset < 1000; offset += 200) {
        const response = await request.get(`${REST}/${entry.dataset}?select=*&limit=200&offset=${offset}`, { headers: restHeaders(undefined, entry.exposed_schema) })
        expect(response.status(), `${entry.exposed_schema}.${entry.dataset}`).toBe(200)
        const body = await response.text()
        expect(body.includes('WITHHELD'), `${entry.exposed_schema}.${entry.dataset} leaks pending-rights content`).toBe(false)
        expect(body.includes('REFUSED') || body.includes('fixture_refused_rights') || body.includes('/refused/'), `${entry.exposed_schema}.${entry.dataset} leaks a refused source`).toBe(false)
        expect(body.includes('CANONICAL'), `${entry.exposed_schema}.${entry.dataset} leaks a canonical entity`).toBe(false)
        const rows = JSON.parse(body) as unknown[]
        rowsSeen += rows.length
        if (rows.length < 200) break
      }
    }
    expect(rowsSeen).toBeGreaterThan(500)

    const versions = (await (await request.get(`${REST}/record_versions?select=source_url,content_hash,safe_payload,source_date_text,omitted_fields&source_id=eq.fixture_pending_rights`, { headers: restHeaders() })).json()) as Array<{ source_url: string | null; content_hash: string | null; safe_payload: unknown; source_date_text: string | null }>
    expect(versions).toHaveLength(2)
    for (const v of versions) {
      expect(v.safe_payload).toBeNull()
      expect(v.source_url).toMatch(/^https:\/\/fixture\.example\/pending\//)
      expect(v.content_hash).toMatch(/^sha256:/)
    }
    const approved = (await (await request.get(`${REST}/record_versions?select=safe_payload&source_id=eq.fixture_releases&limit=1`, { headers: restHeaders() })).json()) as Array<{ safe_payload: { title?: string } | null }>
    expect(approved[0]?.safe_payload?.title).toContain('TEST FIXTURE Release')

    await page.goto('/sources/fixture_pending_rights')
    await expect(page.getByTestId('release-tier')).toContainText('Links and metadata only')
    await page.goto('/records?source=fixture_pending_rights')
    await expect(page.getByTestId('data-row')).toHaveCount(2)
    await expect(page.getByTestId('data-row').first()).toContainText('not shown — not stated by the source, or not released for this source')
    await expect(page.locator('body')).not.toContainText('WITHHELD')
    await page.getByTestId('data-row').first().getByRole('link').first().click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record (label not shown)')
    await expect(page.getByTestId('provenance-source-url').getByRole('link')).toHaveAttribute('href', /fixture\.example\/pending\//)
    await expect(page.locator('body')).not.toContainText('WITHHELD')
    await page.screenshot({ path: `${SCREENS}/17-link-only-record.png`, fullPage: true })
    await page.goto('/parliament?source=fixture_pending_rights')
    await expect(page.getByTestId('data-row')).toHaveCount(1)
    await expect(page.locator('body')).not.toContainText('WITHHELD')
  })

  test('mixed rights within one approved publisher: named fields show, unnamed fields stay blank', async ({ request }) => {
    const bills = (await (await request.get(`${REST}/documents?select=title,bill_number,current_stage,bill_type,select_committee,parliament_number,member_name_at_source&source_id=eq.fixture_bills&limit=5`, { headers: restHeaders() })).json()) as Array<Record<string, unknown>>
    expect(bills.length).toBe(5)
    for (const bill of bills) {
      expect(bill.title, 'approved field').toEqual(expect.stringContaining('TEST FIXTURE Bill'))
      expect(bill.current_stage, 'approved field').toBeTruthy()
      for (const unnamed of ['bill_type', 'select_committee', 'parliament_number', 'member_name_at_source']) expect(bill[unnamed], `${unnamed} was not approved by this publisher`).toBeNull()
    }
    const [version] = (await (await request.get(`${REST}/record_versions?select=safe_payload&source_id=eq.fixture_bills&limit=1`, { headers: restHeaders() })).json()) as Array<{ safe_payload: Record<string, unknown> }>
    // Field tokens are shared by payload keys and typed columns: approving member_name and party_label covers both.
    expect(Object.keys(version?.safe_payload ?? {}).sort()).toEqual(['bill_number', 'current_stage', 'member_name', 'party_label', 'title'])
    const tiers = (await (await request.get(`${REST}/sources?select=source_id,public_release_tier&source_id=like.fixture_*`, { headers: restHeaders() })).json()) as Array<{ source_id: string; public_release_tier: string }>
    expect(Object.fromEntries(tiers.map((t) => [t.source_id, t.public_release_tier]))).toMatchObject({ fixture_bills: 'fields', fixture_pending_rights: 'link_only' })
    expect(tiers.map((t) => t.source_id)).not.toContain('fixture_refused_rights')
  })

  test('operational text is not published: error classes only, no messages, details, references or checkpoints', async ({ request }) => {
    for (const [profile, name, column] of [
      ['evidence_open', 'import_runs', 'error_detail'], ['evidence_public', 'import_runs', 'error_detail'], ['evidence_open', 'import_runs', 'source_watermark'],
      ['evidence_open', 'ingest_errors', 'message'], ['evidence_public', 'ingest_errors', 'message'], ['evidence_open', 'ingest_errors', 'record_ref'],
      ['evidence_open', 'run_checkpoints', 'cursor_state'], ['evidence_open', 'record_lifecycle_events', 'reason'], ['evidence_open', 'record_lifecycle_events', 'requested_by'],
    ] as Array<[Profile, string, string]>) {
      const response = await request.get(`${REST}/${name}?select=${column}&limit=1`, { headers: restHeaders(undefined, profile) })
      expect([400, 404], `${profile}.${name}.${column}`).toContain(response.status())
    }
    const errors = (await (await request.get(`${REST}/ingest_errors?select=*&source_id=eq.fixture_bills`, { headers: restHeaders() })).json()) as Array<Record<string, unknown>>
    expect(errors.length).toBeGreaterThan(0)
    expect(Object.keys(errors[0] ?? {}).sort()).toEqual(['error_class', 'id', 'occurred_at', 'run_id', 'source_id'])
  })

  test('anonymous REST: private, base, inspector, release and system schemas are closed', async ({ request }) => {
    const probes: Array<[Profile, string]> = [
      ['evidence_private', 'source_records'], ['evidence_private', 'app_memberships'], ['evidence_private', 'source_record_versions'],
      ['evidence_views', 'records'], ['evidence_api', 'sources'], ['evidence_inspector', 'records'], ['evidence_inspector', 'my_access'],
      ['vault', 'decrypted_secrets'], ['vault', 'secrets'], ['auth', 'users'], ['public', 'app_memberships'],
    ]
    for (const [profile, name] of probes) {
      const response = await request.get(`${REST}/${name}?select=*&limit=1`, { headers: restHeaders(undefined, profile) })
      const body: unknown = await response.json().catch(() => null)
      expect(response.status(), `${profile}.${name}`).toBeGreaterThanOrEqual(400)
      expect(Array.isArray(body) ? body.length : 0, `${profile}.${name} rows`).toBe(0)
    }
    for (const fn of ['rebuild_exposed_views', 'ingest_batch', 'publish_batch', 'activate_schedule', 'vault_secret', 'redact_version', 'is_inspector']) {
      const response = await request.post(`${REST}/rpc/${fn}`, { headers: restHeaders(), data: {} })
      expect([401, 403, 404], `rpc ${fn}`).toContain(response.status())
    }
    // Sign-ups are closed.
    const signup = await request.post(`${LOCAL_API_URL}/auth/v1/signup`, { headers: { apikey: localKeys().anonKey, 'Content-Type': 'application/json' }, data: { email: 'fixture-signup@example.invalid', password: 'Fx-not-used-000000000000' } })
    expect(signup.status()).toBeGreaterThanOrEqual(400)
  })

  test('anonymous REST: every write verb is refused on every public layer', async ({ request }) => {
    const targets: Array<[Profile, string, Record<string, unknown>]> = [
      ['evidence_public', 'records', { record_kind: 'tampered' }],
      ['evidence_public', 'sources', { enabled: true }],
      ['evidence_open', 'source_records', { record_kind: 'tampered' }],
      ['evidence_open', 'source_rights', { review_status: 'approved' }],
      ['evidence_open', 'release_gates', { state: 'closed' }],
      ['evidence_open', 'ingest_schedules', { state: 'active' }],
      ['evidence_open', 'public_withheld', { reason: 'tampered tampered tampered' }],
    ]
    for (const [profile, name, body] of targets) {
      const headers = { ...restHeaders(undefined, profile), 'Content-Type': 'application/json', Prefer: 'return=representation' }
      for (const [verb, send] of [
        ['POST', () => request.post(`${REST}/${name}`, { headers, data: body })],
        ['PATCH', () => request.patch(`${REST}/${name}?limit=1`, { headers, data: body })],
        ['DELETE', () => request.delete(`${REST}/${name}?limit=1`, { headers })],
      ] as const) {
        const response = await send()
        expect(response.status(), `${verb} ${profile}.${name}`).toBeGreaterThanOrEqual(400)
      }
    }
  })

  test('signed-in accounts gain nothing on the public layers and an ordinary account reads no inspector rows', async ({ request }) => {
    const ordinary = await accessToken(request, 'ordinary')
    const inspector = await accessToken(request, 'inspector')

    const access = await request.get(`${REST}/my_access?select=is_inspector`, { headers: restHeaders(ordinary, 'evidence_inspector') })
    expect(await access.json()).toEqual([{ is_inspector: false }])
    for (const view of ['records', 'identity_decisions', 'schedules']) {
      const response = await request.get(`${REST}/${view}?select=*&limit=5`, { headers: restHeaders(ordinary, 'evidence_inspector') })
      expect(response.ok()).toBeTruthy()
      expect(await response.json(), `ordinary inspector.${view}`).toEqual([])
    }
    expect(await (await request.get(`${REST}/my_access?select=is_inspector`, { headers: restHeaders(inspector, 'evidence_inspector') })).json()).toEqual([{ is_inspector: true }])
    const inspectorRows = (await (await request.get(`${REST}/records?select=id&limit=5`, { headers: restHeaders(inspector, 'evidence_inspector') })).json()) as unknown[]
    expect(inspectorRows.length).toBeGreaterThan(0)

    for (const token of [ordinary, inspector]) {
      for (const [profile, name] of [['evidence_private', 'app_memberships'], ['evidence_private', 'source_records'], ['vault', 'decrypted_secrets'], ['auth', 'users']] as Array<[Profile, string]>) {
        const response = await request.get(`${REST}/${name}?select=*&limit=1`, { headers: restHeaders(token, profile) })
        expect(response.status(), `${profile}.${name}`).toBeGreaterThanOrEqual(400)
      }
      const write = await request.patch(`${REST}/records?limit=1`, { headers: { ...restHeaders(token, 'evidence_inspector'), 'Content-Type': 'application/json' }, data: { record_kind: 'tampered' } })
      expect(write.status()).toBeGreaterThanOrEqual(400)
    }
  })

  test('with the release gates closed the database returns no rows, the page says so, and the catalogue stays readable', async ({ page, request }) => {
    setGates('closed')
    try {
      for (const [profile, name] of [['evidence_public', 'records'], ['evidence_public', 'sources'], ['evidence_open', 'source_record_versions'], ['evidence_open', 'parliamentary_service_terms']] as Array<[Profile, string]>) {
        const response = await request.get(`${REST}/${name}?select=*&limit=5`, { headers: restHeaders(undefined, profile) })
        expect(response.status()).toBe(200)
        expect(await response.json(), `${profile}.${name}`).toEqual([])
      }
      await page.goto('/records?source=fixture_bills')
      await expect(page.getByTestId('release-pending')).toBeVisible()
      await expect(page.getByRole('heading', { level: 1, name: 'Public release is pending review' })).toBeVisible()
      await expect(page.getByTestId('data-row')).toHaveCount(0)
      await page.screenshot({ path: `${SCREENS}/02-release-pending.png`, fullPage: true })

      await page.getByRole('link', { name: 'browse the dataset catalogue' }).click()
      await expect(page.getByRole('heading', { level: 1, name: 'Datasets and schema' })).toBeVisible()
      await expect(page.getByTestId('data-row').first()).toBeVisible()
      await page.goto('/datasets/evidence_open/source_record_versions')
      await expect(page.getByTestId('dataset-columns')).toContainText('safe_payload')
      await expect(page.getByTestId('rows-withheld')).toBeVisible()
    } finally {
      setGates('open')
    }
  })

  test('datasets: every table and column is listed, withheld ones with their reason, and public rows browse generically', async ({ page }) => {
    await page.goto('/datasets?disposition=withheld')
    await page.goto('/datasets?disposition=withheld&q=app_memberships')
    const withheld = page.getByTestId('data-row').filter({ hasText: 'app_memberships' })
    await expect(withheld).toContainText('Withheld — reason given')
    await expect(withheld).toContainText('Access-control records identify individual account holders')

    await page.goto('/datasets/evidence_open/identity_decisions')
    const decidedBy = page.getByTestId('dataset-columns').getByRole('row').filter({ hasText: 'decided_by' })
    await expect(decidedBy).toContainText('Withheld — reason given')
    await expect(decidedBy).toContainText('Names an individual reviewer')
    await expect(page.getByRole('columnheader', { name: 'decided_by' })).toHaveCount(0)

    await page.goto('/datasets/evidence_open/bills')
    await expect(page.getByTestId('dataset-lineage')).toContainText('content columns are null unless that source has approved the field')
    await expect(page.getByTestId('dataset-columns').getByRole('row').filter({ hasText: 'bill_number' })).toContainText('Content — needs publisher approval')
    await expect(page.getByRole('columnheader', { name: /bill_number/ })).toBeVisible()
    await expect(page.getByTestId('data-row').first()).toBeVisible()
    await page.screenshot({ path: `${SCREENS}/15-dataset-detail.png`, fullPage: true })

    await page.goto('/datasets/evidence_open/people')
    await expect(page.getByTestId('dataset-withheld')).toContainText('no single provable source')
    await page.goto('/datasets/evidence_open/summary_versions')
    await expect(page.getByTestId('dataset-row-rule')).toContainText('human review')
  })
})

test.describe('owner override: a separate, stated decision, never a review and never a publisher approval', () => {
  test('gates closed plus a current owner decision: rows and the named fields of ONE source show, the notice says why, and revoking withholds everything', async ({ page, request }) => {
    // LOCAL DISPOSABLE STACK ONLY. A fixture decision recorded the way an administrator would mirror the real file.
    const today = new Date().toISOString().slice(0, 10)
    const expires = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
    const sequence = psql('select lpad((count(*) % 100)::text, 2, \'0\') from evidence_private.owner_authorizations;')
    const id = `OWNER-AUTH-${today}-${sequence}`
    const decision = (status: 'active' | 'revoked') => JSON.stringify({
      schema_version: 1,
      authorizations: [{
        authorization_id: id, status, decided_on: today, expires_on: expires,
        decided_by: 'Fixture Owner (TEST FIXTURE)', decided_by_role: 'repository owner',
        request_source: 'TEST FIXTURE: owner request over a messaging app, relayed by the coordinator',
        statement: 'TEST FIXTURE: the owner authorizes release of rows and listed fields ahead of the reviews.',
        revoked_reason: 'TEST FIXTURE: end of the browser test',
        not_claimed: ['no R10 review exists', 'nobody has accepted the R8 role', 'no publisher licence is claimed'],
        scopes: [
          { scope: 'public_rows', surface_id: 'evidence-store' },
          { scope: 'source_fields', source_id: 'fixture_pending_rights', rights_id: 'RIGHTS-98', fields: ['label', 'name_display', 'name_at_source', 'member_name', 'party_label'], basis: 'TEST FIXTURE: name and party as the publisher lists them, shown with the official link.' },
        ],
      }],
    })
    const sync = (status: 'active' | 'revoked') => psql(`select evidence_private.sync_owner_authorizations(:'doc'::jsonb, 'sha256:' || repeat('e', 64));`, { doc: decision(status) })

    setGates('closed')
    try {
      sync('active')
      const status = (await (await request.get(`${REST}/surface_status?select=gate_key,state,public_rows_released,release_basis,owner_authorization_id`, { headers: restHeaders() })).json()) as Array<{ state: string; public_rows_released: boolean; release_basis: string; owner_authorization_id: string }>
      expect(status.length).toBeGreaterThan(0)
      for (const gate of status) expect(gate).toMatchObject({ state: 'closed', public_rows_released: true, release_basis: 'owner_override', owner_authorization_id: id })
      const rights = (await (await request.get(`${REST}/rights_register?select=review_status&rights_id=eq.RIGHTS-98`, { headers: restHeaders() })).json()) as Array<{ review_status: string }>
      expect(rights[0]?.review_status).toBe('pending')

      // The named fields of the named source, and nothing else of it.
      const versions = (await (await request.get(`${REST}/record_versions?select=record_kind,safe_payload&source_id=eq.fixture_pending_rights`, { headers: restHeaders() })).json()) as Array<{ record_kind: string; safe_payload: Record<string, unknown> | null }>
      expect(versions.find((v) => v.record_kind === 'mp_directory_entry')?.safe_payload).toEqual({ name_display: 'WITHHELD Fixture Pending Member', party_label: 'WITHHELD Fixture Pending Party' })
      expect(versions.find((v) => v.record_kind === 'bill')?.safe_payload).toEqual({})
      // A refused publisher stays invisible whatever the owner decided.
      expect(await (await request.get(`${REST}/records?select=id&source_id=eq.fixture_refused_rights`, { headers: restHeaders() })).json()).toEqual([])

      await page.goto('/parliament?source=fixture_pending_rights')
      const notice = page.getByTestId('owner-override-notice')
      await expect(notice).toBeVisible()
      await expect(notice).toContainText('repository owner’s decision')
      await expect(notice).toContainText('still pending')
      await expect(notice).toContainText('No publisher has approved or licensed anything')
      await expect(notice).toContainText(id)
      await expect(page.getByTestId('data-row').first()).toContainText('Fixture Pending Member')
      await page.goto('/sources/fixture_pending_rights')
      await expect(page.getByTestId('owner-fields-note')).toContainText('not on the publisher’s approval')
      await expect(page.getByTestId('owner-fields-note')).toContainText('name_display')
      await page.goto('/')
      await expect(page.getByTestId('coverage-missing-note')).toContainText('20 of the 24 catalogue products are not in this store')
      await expect(page.getByTestId('coverage-missing').locator('li')).toHaveCount(20)
      await expect(page.getByTestId('release-gates')).not.toContainText('Open')
      await expect(page.getByTestId('accountable-person')).toContainText('not yet confirmed')
      await page.screenshot({ path: `${SCREENS}/20-owner-override.png`, fullPage: true })

      sync('revoked')
      expect(await (await request.get(`${REST}/records?select=id&limit=5`, { headers: restHeaders() })).json()).toEqual([])
      await page.goto('/records')
      await expect(page.getByTestId('release-pending')).toBeVisible()
      await expect(page.getByTestId('owner-override-notice')).toHaveCount(0)
    } finally {
      sync('revoked')
      setGates('open')
    }
  })
})
