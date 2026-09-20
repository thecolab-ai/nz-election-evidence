import { ShieldAlert } from 'lucide-react'
import { ExternalLink } from '@/components/page'
import { formatDate } from '@/lib/format'
import type { SurfaceStatusRow } from '@/lib/types'

const REPO_BASE = 'https://github.com/thecolab-ai/nz-election-evidence/blob/main/'

/** The one row that says an owner decision is what releases the rows. Null when the recorded reviews do, or nothing does. */
export function ownerOverride(status: readonly SurfaceStatusRow[] | undefined): SurfaceStatusRow | null {
  return status?.find((row) => row.release_basis === 'owner_override' && row.public_rows_released === true) ?? null
}

/**
 * Shown on every page while the DATABASE reports that rows are released on the owner's decision. It states what
 * that decision is and, as plainly, what it is not: no independent legal review, no accountable-person
 * acceptance and no publisher approval has happened, and none is implied by anything on this site.
 */
export function OwnerOverrideNotice({ status }: { status: readonly SurfaceStatusRow[] | undefined }) {
  const row = ownerOverride(status)
  if (!row) return null
  return (
    <div role="note" aria-label="Basis of publication" data-testid="owner-override-notice" className="border-b border-caution-foreground/30 bg-caution text-caution-foreground">
      <div className="mx-auto flex max-w-[92rem] items-start gap-2 px-5 py-2.5 text-[13px] lg:px-8">
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <p className="max-w-5xl">
          <strong className="font-semibold">Published on the repository owner’s decision, ahead of independent review.</strong> The project’s
          independent legal review (R10) and the acceptance of the accountable-person role (R8) are both still pending, and their release gates
          remain closed. No publisher has approved or licensed anything shown here: every publisher rights review is pending. Names, parties,
          seats and titles are shown as each official source published them, each with a link to that source. Owner decision{' '}
          <span className="font-mono">{row.owner_authorization_id}</span> of {formatDate(row.owner_decided_on)}, in force until{' '}
          {formatDate(row.owner_expires_on)}.{' '}
          <ExternalLink href={`${REPO_BASE}governance/owner-authorizations.json`}>Read the decision and its limits</ExternalLink>{' '}
          <ExternalLink href={`${REPO_BASE}REVIEW-REGISTER.md`}>Review register</ExternalLink>
        </p>
      </div>
    </div>
  )
}
