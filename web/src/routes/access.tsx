import { Outlet } from '@tanstack/react-router'
import { PlugZap, ScrollText } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { PageHeader } from '@/components/page'
import { ErrorBlock, LoadingBlock } from '@/components/states'
import { appConfig } from '@/lib/env'
import { useRowsQuery } from '@/lib/queries'
import type { SurfaceStatusRow } from '@/lib/types'

export const NOT_CONFIGURED_TITLE = 'Not connected — no data source configured'
export const RELEASE_PENDING_TITLE = 'Public release is pending review'

export function NotConfigured() {
  return (
    <div data-testid="not-configured">
      <PageHeader eyebrow="Configuration" title={NOT_CONFIGURED_TITLE}>
        <p>
          This build was made without a Supabase URL and public anon key, so it cannot reach any evidence. Nothing is shown in its
          place: this application never displays sample or placeholder data.
        </p>
      </PageHeader>
      <div className="flex max-w-3xl items-start gap-3 border border-dashed border-rule bg-paper px-4 py-4 text-sm">
        <PlugZap aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>
          Set <code className="font-mono">VITE_SUPABASE_URL</code> and <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> (the
          public key only) and rebuild. See <code className="font-mono">web/README.md</code>.
        </p>
      </div>
    </div>
  )
}

/** Shown while the database withholds rows from anonymous readers. The dataset catalogue stays readable. */
export function ReleasePending({ gates }: { gates: SurfaceStatusRow[] }) {
  return (
    <div data-testid="release-pending">
      <PageHeader eyebrow="Release status" title={RELEASE_PENDING_TITLE}>
        <p>
          The database returns no evidence rows to the public until the project's review gates are recorded as open. This is enforced
          by the database, not by this page, so there is nothing here to work around and nothing has been loaded.
        </p>
      </PageHeader>
      <div className="max-w-3xl space-y-4 text-sm">
        <table className="w-full border border-border bg-paper text-left">
          <caption className="sr-only">Release gates</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="px-3 py-2 font-semibold">Gate</th>
              <th scope="col" className="px-3 py-2 font-semibold">State</th>
            </tr>
          </thead>
          <tbody>
            {gates.map((gate) => (
              <tr key={gate.gate_key ?? 'gate'} className="border-b border-border last:border-0">
                <td className="px-3 py-2 font-mono text-[13px]">{gate.gate_key}</td>
                <td className="px-3 py-2">{gate.state === 'open' ? 'Open' : 'Closed'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="flex items-start gap-2">
          <ScrollText aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            What exists, what is withheld and why is always public:{' '}
            <Link to="/datasets" className="doc-link">browse the dataset catalogue</Link>.
          </span>
        </p>
      </div>
    </div>
  )
}

/**
 * The columns the publication notice and the access page read. `owner_figure_scopes` is on it because the notice
 * reads it to say WHICH kinds of figure rest on the owner's decision; leaving it out made that sentence silently
 * disappear, and the notice went on claiming no donor is ever named while the store held hundreds of them. A test
 * holds this list against every field the notice uses.
 */
export const SURFACE_STATUS_COLUMNS =
  'gate_key,state,evidence_reference,decided_at,public_rows_released,release_basis,owner_authorization_id,owner_decided_on,owner_expires_on,owner_fields_in_force,owner_figure_scopes'

export function useSurfaceStatus() {
  return useRowsQuery<SurfaceStatusRow>({
    view: 'surface_status',
    select: SURFACE_STATUS_COLUMNS,
    key: ['surface-status'],
    limit: 10,
    enabled: appConfig !== null,
  })
}

/** Reflects the database's answer. The database enforces the release gate; this only explains it. */
export function PublicGate() {
  const status = useSurfaceStatus()
  if (!appConfig) return <NotConfigured />
  if (status.isPending) return <LoadingBlock label="Checking release status…" rows={4} />
  if (status.isError) return <ErrorBlock title="Could not read the release status" error={status.error} onRetry={() => void status.refetch()} />
  const released = status.data.length > 0 && status.data.every((gate) => gate.public_rows_released === true)
  return released ? <Outlet /> : <ReleasePending gates={status.data} />
}

/** For pages that are readable whatever the release state (the dataset catalogue). */
export function ConfiguredOnly() {
  return appConfig ? <Outlet /> : <NotConfigured />
}
