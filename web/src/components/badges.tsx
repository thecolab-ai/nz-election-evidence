import { Archive, Check, CircleDashed, CircleQuestionMark, CircleSlash, Clock, FileCheck, Megaphone, Radio, TriangleAlert } from 'lucide-react'
import type { ComponentType, ReactNode, SVGProps } from 'react'
import {
  candidacyStatusLabel,
  FRESHNESS_EXPLANATIONS,
  FRESHNESS_LABELS,
  humanise,
  isFreshnessStatus,
  type FreshnessStatus,
} from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Status pills. Meaning is carried by the text and a glyph; the tone only adds weight.
 * Tones are neutral on purpose — no hue here maps to a political party.
 */
type Tone = 'plain' | 'strong' | 'caution' | 'muted' | 'accent'

const TONES: Record<Tone, string> = {
  plain: 'border-border bg-paper text-foreground',
  strong: 'border-foreground/60 bg-paper text-foreground',
  caution: 'border-caution-foreground/40 bg-caution text-caution-foreground',
  muted: 'border-dashed border-rule bg-transparent text-muted-foreground',
  accent: 'border-primary/40 bg-accent text-accent-foreground',
}

type Icon = ComponentType<SVGProps<SVGSVGElement>>

export function Pill({ tone = 'plain', icon: IconComponent, children, title, testId }: { tone?: Tone; icon?: Icon; children: ReactNode; title?: string; testId?: string }) {
  return (
    <span
      title={title}
      data-testid={testId}
      className={cn('inline-flex max-w-full items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium leading-tight', TONES[tone])}
    >
      {IconComponent ? <IconComponent aria-hidden="true" className="size-3 shrink-0" /> : null}
      <span>{children}</span>
    </span>
  )
}

const FRESHNESS_STYLE: Record<FreshnessStatus, { tone: Tone; icon: Icon }> = {
  fresh: { tone: 'plain', icon: Check },
  stale: { tone: 'caution', icon: Clock },
  partial: { tone: 'caution', icon: CircleDashed },
  unavailable: { tone: 'strong', icon: CircleSlash },
  reachable_not_parsed: { tone: 'muted', icon: Radio },
  never_run: { tone: 'muted', icon: CircleQuestionMark },
}

export function FreshnessBadge({ status }: { status: string | null | undefined }) {
  if (!isFreshnessStatus(status)) return <Pill tone="muted" icon={CircleQuestionMark}>Freshness unknown</Pill>
  const style = FRESHNESS_STYLE[status]
  return (
    <Pill tone={style.tone} icon={style.icon} title={FRESHNESS_EXPLANATIONS[status]} testId={`freshness-${status}`}>
      {FRESHNESS_LABELS[status]}
    </Pill>
  )
}

export function CandidacyStatusBadge({ status }: { status: string | null | undefined }) {
  const label = candidacyStatusLabel(status)
  if (status === 'officially_nominated') return <Pill tone="strong" icon={FileCheck} testId="status-officially_nominated">{label}</Pill>
  if (status === 'announced') return <Pill tone="muted" icon={Megaphone} testId="status-announced">{label}</Pill>
  if (status === 'unknown' || !status) return <Pill tone="muted" icon={CircleQuestionMark}>{label}</Pill>
  return <Pill tone="plain">{label}</Pill>
}

export function TombstoneBadge({ reason }: { reason?: string | null }) {
  return (
    <Pill tone="caution" icon={Archive} testId="tombstoned-badge" title="No longer seen at the source. The history is kept.">
      Tombstoned{reason ? `: ${humanise(reason).toLowerCase()}` : ''}
    </Pill>
  )
}

export function RightsBadge({ status }: { status: string | null | undefined }) {
  if (status === 'approved') return <Pill tone="plain" icon={Check}>Rights approved</Pill>
  if (status === 'pending' || !status) return <Pill tone="caution" icon={Clock}>Rights review pending</Pill>
  return <Pill tone="strong" icon={TriangleAlert}>Rights {humanise(status).toLowerCase()}</Pill>
}

export function LinkStatusBadge({ status }: { status: string | null | undefined }) {
  if (status === 'approved') return <Pill tone="plain" icon={Check}>Reviewed link</Pill>
  if (status === 'proposed') return <Pill tone="caution" icon={CircleDashed}>Link proposed, not reviewed</Pill>
  if (status === 'rejected') return <Pill tone="muted" icon={CircleSlash}>Link rejected</Pill>
  return <Pill tone="muted" icon={CircleQuestionMark}>Unresolved</Pill>
}

export function RunStatusBadge({ status }: { status: string | null | undefined }) {
  if (status === 'succeeded') return <Pill tone="plain" icon={Check}>Succeeded</Pill>
  if (status === 'blocked') return <Pill tone="strong" icon={CircleSlash} testId="run-blocked">Blocked by publisher</Pill>
  if (status === 'failed') return <Pill tone="strong" icon={TriangleAlert}>Failed</Pill>
  if (status === 'partial') return <Pill tone="caution" icon={CircleDashed}>Partial</Pill>
  if (status === 'running') return <Pill tone="accent" icon={Clock}>Running</Pill>
  return <Pill tone="muted">{humanise(status)}</Pill>
}

export function StateBadge({ state }: { state: string | null | undefined }) {
  if (state === 'active') return <Pill tone="strong" icon={Check}>Active</Pill>
  if (state === 'open') return <Pill tone="strong" icon={Check}>Open</Pill>
  if (state === 'closed') return <Pill tone="muted" icon={CircleSlash}>Closed</Pill>
  if (state === 'inactive') return <Pill tone="muted" icon={CircleSlash}>Inactive</Pill>
  return <Pill tone="muted">{humanise(state)}</Pill>
}
