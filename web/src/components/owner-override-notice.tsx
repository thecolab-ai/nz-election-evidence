import { ShieldAlert } from 'lucide-react'
import { ExternalLink } from '@/components/page'
import { formatDate } from '@/lib/format'
import type { SurfaceStatusRow } from '@/lib/types'

const REPO_BASE = 'https://github.com/thecolab-ai/nz-election-evidence/blob/main/'
const REVIEW_GATES = ['r10_public_surface_review', 'r8_accountable_legal_entity']

export interface OwnerBasis {
  row: SurfaceStatusRow
  /** Rows reach readers on the owner's decision (the recorded reviews do not release them). */
  rowsOnOwnerDecision: boolean
  /** Review gates that are NOT recorded as open, by key. Read from the database, never assumed. */
  gatesNotOpen: string[]
}

/**
 * What, if anything, rests on an owner decision right now. Two independent conditions: rows released on it, and
 * fields shown on it. The second outlives the first: recording the reviews later does not turn an owner-shown field
 * into a publisher-approved one, so the notice stays for as long as either holds. Null when neither does.
 */
export function ownerBasis(status: readonly SurfaceStatusRow[] | undefined): OwnerBasis | null {
  const rows = status ?? []
  const row = rows.find((r) => r.public_rows_released === true && (r.release_basis === 'owner_override' || r.owner_fields_in_force === true))
  if (!row) return null
  return {
    row,
    rowsOnOwnerDecision: row.release_basis === 'owner_override',
    gatesNotOpen: rows.filter((r) => REVIEW_GATES.includes(r.gate_key ?? '') && r.state !== 'open').map((r) => r.gate_key ?? ''),
  }
}

const GATE_WORDS: Record<string, string> = {
  r10_public_surface_review: 'the independent legal review of this site (R10)',
  r8_accountable_legal_entity: 'the acceptance of the accountable-person role (R8)',
}

/**
 * Which kinds of published figure rest on the owner's decision, in the reader's words. Read from the database
 * (`surface_status.owner_figure_scopes`), never assumed here: revoking one kind changes this line by itself.
 */
const FIGURE_WORDS: Record<string, string> = {
  statistical_facts: 'the published figures of official statistics',
  official_result_figures: 'the vote counts, shares, seat numbers and list positions the official election-results publications printed',
  official_finance_figures: 'the donation, expense and loan totals the Electoral Commission prints on its own public index pages',
  published_poll_figures: 'the party-vote percentages each pollster published, each shown beside whether that pollster disclosed a methodology',
}

export function figureWords(scopes: readonly string[] | null | undefined): string[] {
  return (scopes ?? []).map((kind) => FIGURE_WORDS[kind]).filter((words): words is string => !!words)
}

/**
 * Shown on every page while the DATABASE reports that rows or fields rest on the owner's decision. It states what
 * that decision is and, as plainly, what it is not. Which reviews are outstanding is read from the gate states.
 */
export function OwnerOverrideNotice({ status }: { status: readonly SurfaceStatusRow[] | undefined }) {
  const basis = ownerBasis(status)
  if (!basis) return null
  const { row, rowsOnOwnerDecision, gatesNotOpen } = basis
  const outstanding = gatesNotOpen.map((key) => GATE_WORDS[key] ?? key)
  const figures = figureWords(row.owner_figure_scopes)
  return (
    <div role="note" aria-label="Basis of publication" data-testid="owner-override-notice" className="border-b border-caution-foreground/30 bg-caution text-caution-foreground">
      <div className="mx-auto flex max-w-[92rem] items-start gap-2 px-5 py-2.5 text-[13px] lg:px-8">
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <p className="max-w-5xl">
          <strong className="font-semibold">
            {rowsOnOwnerDecision ? 'Published on the repository owner’s decision, ahead of independent review.' : 'Names and titles are shown on the repository owner’s decision.'}
          </strong>{' '}
          {outstanding.length > 0 ? (
            <span data-testid="owner-notice-gates">
              Not yet on record: {outstanding.join(' and ')}. {outstanding.length > 1 ? 'Those release gates read' : 'That release gate reads'} closed, and the owner’s decision
              does not open or replace {outstanding.length > 1 ? 'them' : 'it'}.{' '}
            </span>
          ) : null}
          No publisher has approved or licensed the fields shown on this decision. Names, parties, seats, titles
          {figures.length > 0 ? <span data-testid="owner-notice-figures">, and {figures.join(', ')},</span> : null} appear as each official
          source published them, each with a link to that source, and each source’s page lists the fields shown for it. Nothing is read from
          inside a finance return, and no donor is named anywhere: this project has never collected a donation record. Owner decision{' '}
          <span className="font-mono">{row.owner_authorization_id}</span> of {formatDate(row.owner_decided_on)}, in force until{' '}
          {formatDate(row.owner_expires_on)}.{' '}
          <ExternalLink href={`${REPO_BASE}governance/owner-authorizations.json`}>Read the decision and its limits</ExternalLink>{' '}
          <ExternalLink href={`${REPO_BASE}REVIEW-REGISTER.md`}>Review register</ExternalLink>
        </p>
      </div>
    </div>
  )
}
