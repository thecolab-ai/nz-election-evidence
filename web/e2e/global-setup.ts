import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE_INSPECTOR_EMAIL, FIXTURE_ORDINARY_EMAIL, LOCAL_API_URL, localKeys, psql, webRoot } from './support/local-stack'

async function admin(path: string, init: { method: string; body?: unknown }, serviceRoleKey: string): Promise<{ id?: string }> {
  const response = await fetch(`${LOCAL_API_URL}/auth/v1/admin${path}`, {
    method: init.method,
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  if (!response.ok) throw new Error(`Local auth admin ${init.method} ${path} answered HTTP ${response.status}`)
  return (await response.json()) as { id?: string }
}

/** Creates the user, or resets the password of the one left by an earlier run. Returns the user id. */
async function ensureUser(email: string, password: string, serviceRoleKey: string): Promise<string> {
  const existing = psql('select id from auth.users where email = :\'email\';', { email })
  if (existing) {
    await admin(`/users/${existing}`, { method: 'PUT', body: { password, email_confirm: true } }, serviceRoleKey)
    return existing
  }
  const created = await admin('/users', { method: 'POST', body: { email, password, email_confirm: true } }, serviceRoleKey)
  if (!created.id) throw new Error('Local auth admin did not return a user id.')
  return created.id
}

export default async function globalSetup(): Promise<void> {
  const { serviceRoleKey } = localKeys()

  // Random per run; they live only in this process tree's environment.
  const inspectorPassword = `Fx-${randomBytes(18).toString('base64url')}`
  const ordinaryPassword = `Fx-${randomBytes(18).toString('base64url')}`
  const inspectorId = await ensureUser(FIXTURE_INSPECTOR_EMAIL, inspectorPassword, serviceRoleKey)
  const ordinaryId = await ensureUser(FIXTURE_ORDINARY_EMAIL, ordinaryPassword, serviceRoleKey)

  // Membership is granted the way an administrator would: a row in the private table.
  psql(
    `insert into evidence_private.app_memberships (user_id, app_role, granted_by, grant_reason)
     select :'uid'::uuid, 'inspector', 'e2e global setup (TEST FIXTURE)', 'TEST FIXTURE: inspector account for local end-to-end tests'
     where not exists (select 1 from evidence_private.app_memberships m
                       where m.user_id = :'uid'::uuid and m.app_role = 'inspector' and m.revoked_at is null);`,
    { uid: inspectorId },
  )
  const ordinaryMemberships = psql(`select count(*) from evidence_private.app_memberships where user_id = :'uid'::uuid and revoked_at is null;`, { uid: ordinaryId })
  if (ordinaryMemberships !== '0') throw new Error('The ordinary fixture user unexpectedly holds a membership.')

  psql(readFileSync(join(webRoot, 'e2e', 'fixtures', 'seed.sql'), 'utf8'))

  // LOCAL DISPOSABLE STACK ONLY: record both release gates as open so anonymous browsing can be tested.
  // On a hosted project a gate is opened by a named person with an evidence reference, after review.
  psql(`update evidence_private.release_gates set state = 'open', evidence_reference = 'TEST FIXTURE: local end-to-end run only',
        decided_by = 'e2e setup (TEST FIXTURE)', decided_at = now()
        where gate_key in ('r10_public_surface_review', 'r8_accountable_legal_entity');`)
  psql('analyze;')

  process.env.E2E_INSPECTOR_PASSWORD = inspectorPassword
  process.env.E2E_ORDINARY_PASSWORD = ordinaryPassword
  process.env.E2E_INSPECTOR_ID = inspectorId
}
