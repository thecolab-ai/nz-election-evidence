import { getRouteApi, Link } from '@tanstack/react-router'
import { CandidacyStatusBadge, LinkStatusBadge } from '@/components/badges'
import { EvidenceVersionLink } from '@/components/evidence-link'
import { JsonViewer } from '@/components/json-viewer'
import { KeyValueList, Mono, Note, PageHeader, Section } from '@/components/page'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import { TableRow } from '@/components/ui/table'
import { formatDateTime, formatServiceDate, formatVotes, humanise, scopeLabel } from '@/lib/format'
import { useOneQuery, useRowsQuery } from '@/lib/queries'
import type { CandidacyRow, IdentityDecisionRow, PartyAffiliationRow, PersonIdentityRow, ServiceTermRow } from '@/lib/types'
import { UNRESOLVED_NOTE } from './people'
import { Cell, Panel } from './source-detail'

const route = getRouteApi('/_released/people/$identityId')

export function IdentityDetailPage() {
  const params = route.useParams()
  // The id is interpolated into a read filter below, so anything that is not a UUID is treated as unknown.
  const identityId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.identityId) ? params.identityId : '00000000-0000-0000-0000-000000000000'
  const identity = useOneQuery<PersonIdentityRow>({ view: 'person_identities', select: '*', column: 'id', value: identityId })
  const terms = useRowsQuery<ServiceTermRow>({ view: 'service_terms', select: '*', key: [identityId], build: (q) => q.eq('person_identity_id', identityId).order('observed_last_at', { ascending: false }) })
  const affiliations = useRowsQuery<PartyAffiliationRow>({ view: 'party_affiliations', select: '*', key: [identityId], build: (q) => q.eq('person_identity_id', identityId).order('observed_last_at', { ascending: false }) })
  const candidacies = useRowsQuery<CandidacyRow>({ view: 'candidacies', select: '*', key: [identityId], build: (q) => q.eq('person_identity_id', identityId).order('election_slug') })
  // A name-similarity proposal is filed on one identity and names the other, so it is looked up from both sides.
  const proposals = useRowsQuery<IdentityDecisionRow>({ view: 'identity_decisions', select: '*', key: [identityId], build: (q) => q.or(`person_identity_id.eq.${identityId},evidence->>same_name_identity_id.eq.${identityId}`).eq('decision', 'proposed') })

  if (identity.isPending) return <LoadingBlock label="Loading identity" />
  if (identity.isError) return <ErrorBlock error={identity.error} onRetry={() => void identity.refetch()} />
  const i = identity.data
  if (!i) {
    return (
      <>
        <PageHeader eyebrow="Source identity" title="Identity not found" />
        <EmptyBlock message="No source identity with this id was returned." />
      </>
    )
  }

  return (
    <>
      <p className="mb-3 text-sm"><Link to="/people" className="doc-link">← All people</Link></p>
      <PageHeader eyebrow="Source identity" title={i.name_at_source}>
        <p>As written by <Mono>{i.source_id}</Mono>. This page describes one identity in one source, not a person.</p>
        <div className="flex flex-wrap gap-2 pt-1"><LinkStatusBadge status={i.link_status} /></div>
      </PageHeader>

      {!i.person_id ? <div className="mb-8"><Note tone="caution" testId="identity-unresolved">{UNRESOLVED_NOTE}.</Note></div> : null}

      <Section id="identity" title="Identity">
        <KeyValueList
          columns={3}
          items={[
            { label: 'Canonical person', value: i.person_id ? `${i.linked_person_name} (reviewed link)` : UNRESOLVED_NOTE },
            { label: 'Identity scheme', value: humanise(i.identity_scheme) },
            { label: 'External id', value: <Mono>{i.external_id}</Mono> },
            { label: 'First evidence', value: <EvidenceVersionLink versionId={i.first_version_id} /> },
            { label: 'Relationship graph', value: <Link to="/graph" search={{ kind: 'person_identity', id: i.id }} className="doc-link" data-testid="open-graph">Open bounded graph from this identity</Link> },
          ]}
        />
      </Section>

      <Section id="terms" title="Service terms" description="A directory sighting establishes that the member was listed, not when service began or ended.">
        <Panel query={terms} caption="Service terms" head={['Representation', 'Electorate at source', 'Party label', 'Observed in directory from', 'Observed in directory to', 'Service from', 'Service to', 'Evidence']}>
          {(t) => (
            <TableRow key={t.id}>
              <Cell>{humanise(t.representation)}</Cell>
              <Cell>{t.electorate_name_at_source ?? 'none (list member)'}</Cell>
              <Cell>{t.party_label ?? 'not stated by source'}</Cell>
              <Cell>{formatDateTime(t.observed_first_at)}</Cell>
              <Cell>{formatDateTime(t.observed_last_at)}</Cell>
              <Cell>{formatServiceDate(t.valid_from)}</Cell>
              <Cell>{formatServiceDate(t.valid_to)}</Cell>
              <Cell><EvidenceVersionLink versionId={t.evidence_version_id} /></Cell>
            </TableRow>
          )}
        </Panel>
      </Section>

      <Section id="affiliations" title="Party affiliations" description="Labels as the source wrote them. An observed label is not a membership record.">
        <Panel query={affiliations} caption="Party affiliations" head={['Party label', 'Basis', 'Observed from', 'Observed to', 'Valid from', 'Evidence']}>
          {(a) => (
            <TableRow key={a.id}>
              <Cell>{a.party_label}</Cell>
              <Cell>{humanise(a.basis)}</Cell>
              <Cell>{formatDateTime(a.observed_first_at)}</Cell>
              <Cell>{formatDateTime(a.observed_last_at)}</Cell>
              <Cell>{formatServiceDate(a.valid_from)}</Cell>
              <Cell><EvidenceVersionLink versionId={a.evidence_version_id} /></Cell>
            </TableRow>
          )}
        </Panel>
      </Section>

      <Section id="candidacies" title="Candidacies" description="Candidacy appears only from nomination or announcement sources, never from a parliamentary directory.">
        <Panel query={candidacies} caption="Candidacies" head={['Election', 'Type', 'Electorate', 'Party label', 'Status', 'Votes', 'Evidence']}>
          {(c) => (
            <TableRow key={c.id}>
              <Cell><Link to="/elections/$slug" params={{ slug: c.election_slug }} className="doc-link">{c.election_slug}</Link><span className="block text-xs text-muted-foreground">{scopeLabel(c.view_scope)}</span></Cell>
              <Cell>{humanise(c.candidacy_type)}{c.list_rank ? ` · list position ${c.list_rank}` : ''}</Cell>
              <Cell>{c.electorate_name ?? 'none (party list)'}</Cell>
              <Cell>{c.party_label ?? 'not stated by source'}</Cell>
              <Cell><CandidacyStatusBadge status={c.current_status} /></Cell>
              <Cell>{formatVotes(c.votes, c.votes_status, c.candidacy_type)}</Cell>
              <Cell><EvidenceVersionLink versionId={c.evidence_version_id} /></Cell>
            </TableRow>
          )}
        </Panel>
      </Section>

      <Section id="proposals" title="Open proposals" description="A proposal is a prompt for human review. It links nothing on its own.">
        <Panel query={proposals} caption="Open identity proposals" head={['Method', 'Decision', 'Evidence']}>
          {(d) => (
            <TableRow key={d.id}>
              <Cell>{humanise(d.method)}</Cell>
              <Cell>{humanise(d.decision)} — not reviewed</Cell>
              <Cell><JsonViewer value={d.evidence} label="Proposal evidence" /></Cell>
            </TableRow>
          )}
        </Panel>
      </Section>
    </>
  )
}
