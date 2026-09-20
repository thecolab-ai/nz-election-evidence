import { Bot } from 'lucide-react'
import { Pill } from '@/components/badges'
import { ExternalLink } from '@/components/page'
import { formatAgreement, formatConfidence, formatDateTime, humanise, modelProvenance } from '@/lib/format'
import type { SummaryRow } from '@/lib/types'

/**
 * R9: a model output is always labelled with its model, version, prompt, the confidence the run reported (or that it
 * reported none), the review state of THIS output, and - separately - whether a human-agreement rate is documented
 * for its schema version. Until one is, the "not yet checked against human review" flag stays, approved or not.
 */
export function SummaryCard({ summary }: { summary: SummaryRow }) {
  const provenance = modelProvenance(summary)
  return (
    <article data-testid="summary-card" className="border border-border bg-paper">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs">
        <Pill tone="strong" icon={Bot}>Model output — not a finding</Pill>
        <Pill tone={summary.review_status === 'approved' ? 'plain' : 'caution'}>Review of this output: {humanise(summary.review_status).toLowerCase()}</Pill>
        {provenance.humanReviewNote ? <Pill tone="caution" testId="not-human-reviewed">{provenance.humanReviewNote}</Pill> : null}
      </div>
      <div className="space-y-3 px-4 py-3 text-sm">
        <p className="max-w-3xl whitespace-pre-wrap">{summary.summary_text}</p>
        {summary.uncertainty_note ? <p className="max-w-3xl text-muted-foreground"><span className="font-medium text-foreground">Uncertainty: </span>{summary.uncertainty_note}</p> : null}
        <dl className="grid gap-x-8 gap-y-2 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="eyebrow">Model name</dt><dd data-testid="summary-model">{provenance.model}</dd></div>
          <div><dt className="eyebrow">Model version</dt><dd>{provenance.version}</dd></div>
          <div><dt className="eyebrow">Prompt or schema version</dt><dd>{provenance.prompt}</dd></div>
          <div><dt className="eyebrow">Generated</dt><dd>{formatDateTime(summary.created_at)}</dd></div>
          <div className="sm:col-span-2">
            <dt className="eyebrow">Model confidence</dt>
            <dd data-testid="summary-confidence">
              {formatConfidence(summary.confidence, summary.confidence_status)}
              {summary.confidence_status === 'reported' && summary.confidence_basis ? <span className="text-muted-foreground"> ({summary.confidence_basis})</span> : null}
            </dd>
            <dd className="text-xs text-muted-foreground">The model run's own figure about this text. It says nothing about any person or party.</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="eyebrow">Human-agreement rate for this schema</dt>
            <dd data-testid="summary-agreement">
              {formatAgreement(summary)}
              {summary.schema_agreement_documented && summary.schema_agreement_method_url ? <> · <ExternalLink href={summary.schema_agreement_method_url}>method</ExternalLink></> : null}
            </dd>
          </div>
        </dl>
      </div>
    </article>
  )
}
