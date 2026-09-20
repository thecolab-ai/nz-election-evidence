import { expect, type APIRequestContext } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE_INSPECTOR_EMAIL, FIXTURE_ORDINARY_EMAIL, LOCAL_API_URL, localKeys, psql, webRoot } from './local-stack'

export const SCREENS = join(webRoot, 'test-results', 'screens')
mkdirSync(SCREENS, { recursive: true })

export function credentials(kind: 'inspector' | 'ordinary'): { email: string; password: string } {
  const password = kind === 'inspector' ? process.env.E2E_INSPECTOR_PASSWORD : process.env.E2E_ORDINARY_PASSWORD
  if (!password) throw new Error('Global setup did not provide fixture credentials.')
  return { email: kind === 'inspector' ? FIXTURE_INSPECTOR_EMAIL : FIXTURE_ORDINARY_EMAIL, password }
}

/** A user access token from the local auth server, for asserting what the REST API itself returns. */
export async function accessToken(request: APIRequestContext, kind: 'inspector' | 'ordinary'): Promise<string> {
  const { email, password } = credentials(kind)
  const response = await request.post(`${LOCAL_API_URL}/auth/v1/token?grant_type=password`, {
    headers: { apikey: localKeys().anonKey, 'Content-Type': 'application/json' },
    data: { email, password },
  })
  expect(response.ok()).toBeTruthy()
  const body = (await response.json()) as { access_token: string }
  return body.access_token
}

export type Profile = 'evidence_public' | 'evidence_open' | 'evidence_inspector' | 'evidence_private' | 'evidence_views' | 'evidence_api' | 'vault' | 'auth' | 'public'

/** Anonymous by default (anon key as bearer). Pass a user token to act as a signed-in account. */
export function restHeaders(bearer?: string, profile: Profile = 'evidence_public'): Record<string, string> {
  const { anonKey } = localKeys()
  return { apikey: anonKey, Authorization: `Bearer ${bearer ?? anonKey}`, 'Accept-Profile': profile, 'Content-Profile': profile }
}

export function setGates(state: 'open' | 'closed'): void {
  psql(
    state === 'open'
      ? `update evidence_private.release_gates set state = 'open', evidence_reference = 'TEST FIXTURE: local end-to-end run only', decided_by = 'e2e setup (TEST FIXTURE)', decided_at = now() where gate_key in ('r10_public_surface_review', 'r8_accountable_legal_entity');`
      : `update evidence_private.release_gates set state = 'closed', evidence_reference = null, decided_by = null, decided_at = null;`,
  )
}

export const REST = `${LOCAL_API_URL}/rest/v1`
