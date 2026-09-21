import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { psql, webRoot } from './support/local-stack'
import { REST, restHeaders, SCREENS } from './support/helpers'

// TEST FIXTURE ONLY, local disposable stack. A synthetic statistics source loaded through the real typed writer.
test.describe('statistics: counts are shown as held, figures only on a recorded owner decision, and a missing number is never a number', () => {
  test.beforeAll(() => {
    psql(readFileSync(join(webRoot, 'e2e', 'fixtures', 'seed-statistics.sql'), 'utf8'))
  })

  test('a statistics source shows its observations as held, with the cells the publisher printed no number for counted apart', async ({ page, request }) => {
    const rows = (await (await request.get(`${REST}/sources?select=live_records,statistical_observations,statistical_observations_without_a_number,rights_review_status,public_release_tier&source_id=eq.fixture_statistics`, { headers: restHeaders() })).json()) as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({ live_records: 0, statistical_observations: 3, statistical_observations_without_a_number: 1, rights_review_status: 'pending', public_release_tier: 'link_only' })
    await page.goto('/sources?publisher=Fixture%20Statistics')
    const held = page.getByRole('row', { name: /fixture_statistics/ }).getByTestId('held-statistics')
    await expect(held).toContainText('3 observations')
    await expect(held).toContainText('1 with no number printed by the publisher')
    await page.goto('/sources/fixture_statistics')
    await expect(page.getByTestId('source-observations')).toHaveText('3')
    await expect(page.getByTestId('source-observations-withheld')).toHaveText('1')
    await page.screenshot({ path: `${SCREENS}/30-statistics-source.png`, fullPage: true })
  })

  test('without an owner decision the figures are blank; with a statistical_facts decision they show; rights stay pending throughout', async ({ page, request }) => {
    const today = new Date().toISOString().slice(0, 10)
    const expires = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
    const sequence = psql('select lpad((count(*) % 100)::text, 2, \'0\') from evidence_private.owner_authorizations;')
    const id = `OWNER-AUTH-${today}-${sequence}`
    const existing = psql('select coalesce(jsonb_agg(jsonb_build_object(\'authorization_id\', authorization_id)), \'[]\'::jsonb) from evidence_private.owner_authorizations where revoked_at is null;')
    expect(existing, 'this test needs a store with no owner decision in force (a fresh local stack)').toBe('[]')
    const decision = (status: 'active' | 'revoked') => JSON.stringify({
      schema_version: 1,
      authorizations: [{
        authorization_id: id, status, decided_on: today, expires_on: expires,
        decided_by: 'Fixture Owner (TEST FIXTURE)', decided_by_role: 'repository owner',
        request_source: 'TEST FIXTURE: owner request over a messaging app, relayed by the coordinator',
        statement: 'TEST FIXTURE: the owner authorizes display of official statistics of one fixture source ahead of the reviews.',
        revoked_reason: 'TEST FIXTURE: end of the browser test',
        not_claimed: ['no R10 review exists', 'nobody has accepted the R8 role', 'no publisher licence is claimed'],
        scopes: [
          { scope: 'source_fields', source_id: 'fixture_statistics', rights_id: 'RIGHTS-97', fields: ['title', 'unit', 'period_label', 'series_key', 'dataset_title', 'release_key', 'canonical_route'], basis: 'TEST FIXTURE: series title, unit and period as the publisher prints them, with the official link.' },
          { scope: 'statistical_facts', source_id: 'fixture_statistics', rights_id: 'RIGHTS-97', fields: ['value', 'raw_value', 'value_status'], basis: 'TEST FIXTURE: the published figure, the cell as printed and its status, with the official link.' },
        ],
      }],
    })
    const sync = (status: 'active' | 'revoked') => psql(`select evidence_private.sync_owner_authorizations(:'doc'::jsonb, 'sha256:' || repeat('d', 64));`, { doc: decision(status) })
    // The observations view carries no source column of its own: a reader reaches them through the series of a source.
    const series = (await (await request.get(`${REST}/stat_series?select=id,title&source_id=eq.fixture_statistics`, { headers: restHeaders() })).json()) as Array<{ id: string; title: string | null }>
    expect(series).toHaveLength(1)
    expect(series[0]?.title, 'a series title is content: blank until a decision names it').toBeNull()
    const observations = async () => (await (await request.get(`${REST}/stat_observations?select=period_label,value,raw_value,value_status&series_id=eq.${series[0]!.id}&order=id`, { headers: restHeaders() })).json()) as Array<{ period_label: string | null; value: number | null; raw_value: string | null; value_status: string | null }>

    // Link tier, no owner decision: the rows exist, every content column is blank.
    expect(await observations()).toHaveLength(3)
    for (const row of await observations()) expect(row).toEqual({ period_label: null, value: null, raw_value: null, value_status: null })
    try {
      sync('active')
      const shown = await observations()
      expect(shown).toEqual([
        { period_label: '2001', value: 4321, raw_value: '4321', value_status: 'reported' },
        { period_label: '2006', value: null, raw_value: '..C', value_status: 'confidential' },
        { period_label: '2013', value: 0, raw_value: '0', value_status: 'reported' },
      ])
      // An owner decision is not a rights approval: the register still reads pending and the tier is still link_only.
      const source = (await (await request.get(`${REST}/sources?select=rights_review_status,public_release_tier,owner_authorized_fields&source_id=eq.fixture_statistics`, { headers: restHeaders() })).json()) as Array<{ rights_review_status: string; public_release_tier: string; owner_authorized_fields: string[] }>
      expect(source[0]).toMatchObject({ rights_review_status: 'pending', public_release_tier: 'link_only' })
      expect(source[0]?.owner_authorized_fields).toEqual(['canonical_route', 'dataset_title', 'period_label', 'raw_value', 'release_key', 'series_key', 'title', 'unit', 'value', 'value_status'])

      await page.goto('/sources/fixture_statistics')
      await expect(page.getByTestId('owner-fields-note')).toContainText('not on the publisher’s approval')
      await expect(page.getByTestId('owner-fields-note')).toContainText('value_status')
      await page.goto('/statistics?q=Fixture%20series')
      await page.getByRole('button', { name: /View observations/ }).first().click()
      const values = page.getByTestId('stat-value')
      await expect(values).toHaveCount(3)
      // The confidential cell is words, never a number and never 0; the published zero is a 0.
      const confidential = page.locator('[data-testid="stat-value"][data-value-status="confidential"]')
      await expect(confidential).toHaveCount(1)
      await expect(confidential).not.toHaveText(/^[0-9.,\s]+$/)
      await expect(page.locator('[data-testid="stat-value"][data-value-status="reported"]').first()).toHaveText(/4,?321/)
      await page.screenshot({ path: `${SCREENS}/31-statistics-owner-decision.png`, fullPage: true })
    } finally {
      sync('revoked')
    }
    for (const row of await observations()) expect(row.value).toBeNull()
  })
})
