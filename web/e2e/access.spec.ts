import { expect, test } from '@playwright/test'
import { accessToken, REST, restHeaders, SCREENS, setGates, type Profile } from './support/helpers'
import { LOCAL_API_URL, localKeys } from './support/local-stack'

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
    for (const view of ['records', 'sources', 'record_versions', 'person_identities', 'graph_edges', 'import_runs', 'fetch_log', 'rights_register', 'elections', 'coverage_by_scope']) {
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
    const withheld = page.getByTestId('data-row').filter({ hasText: 'app_memberships' })
    await expect(withheld).toContainText('Withheld — reason given')
    await expect(withheld).toContainText('Access-control records identify individual account holders')

    await page.goto('/datasets/evidence_open/identity_decisions')
    const decidedBy = page.getByTestId('dataset-columns').getByRole('row').filter({ hasText: 'decided_by' })
    await expect(decidedBy).toContainText('Withheld — reason given')
    await expect(decidedBy).toContainText('Names an individual reviewer')
    await expect(page.getByRole('columnheader', { name: 'decided_by' })).toHaveCount(0)

    await page.goto('/datasets/evidence_open/bills')
    await expect(page.getByRole('columnheader', { name: /bill_number/ })).toBeVisible()
    await expect(page.getByTestId('data-row').first()).toBeVisible()
    await page.screenshot({ path: `${SCREENS}/15-dataset-detail.png`, fullPage: true })

    await page.goto('/datasets/evidence_open/summary_versions')
    await expect(page.getByTestId('dataset-row-rule')).toContainText('human review')
  })
})
