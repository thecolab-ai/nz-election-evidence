import { getRouteApi, Link } from '@tanstack/react-router'
import { CandidacyStatusBadge, LinkStatusBadge } from '@/components/badges'
import { EntityLink } from '@/components/entity-link'
import { EvidenceVersionLink } from '@/components/evidence-link'
import { KeyValueList, Mono, Note, PageHeader, Section } from '@/components/page'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import { TableRow } from '@/components/ui/table'
import { formatDateTime, formatVotes, humanise, NOT_SHOWN, RIGHTS_NOTE } from '@/lib/format'
import { useOneQuery, useRowsQuery } from '@/lib/queries'
import { isUuid } from '@/lib/search'
import type { CandidacyRow, ElectorateVersionRow, PartyAffiliationRow, PartyIdentityRow, ServiceTermRow } from '@/lib/types'
import { Cell, Panel } from './source-detail'

const partyRoute = getRouteApi('/_released/parties/$identityId')
const electorateRoute = getRouteApi('/_released/electorates/$versionId')
const NO_ID = '00000000-0000-0000-0000-000000000000'

export const PARTY_IDENTITY_NOTE = 'A party label exactly as one source wrote it. It is not a registered party, and the same label in two sources stays two identities until a person reviews the evidence'

/** One party label from one source: who that source attached it to, and where it stood. */
export function PartyIdentityDetailPage() {
  const params = partyRoute.useParams()
  // The id is interpolated into read filters, so anything that is not a UUID is treated as unknown.
  const id = isUuid(params.identityId) ? params.identityId : NO_ID
  const party = useOneQuery<PartyIdentityRow>({ view: 'party_identities', select: 'id,source_id,external_id,name_at_source,link_status,is_independent_label', column: 'id', value: id })
  const members = useRowsQuery<ServiceTermRow>({ view: 'service_terms', select: '*', key: ['party', id], limit: 200, build: (q) => q.eq('party_identity_id', id).order('member_name') })
  const affiliations = useRowsQuery<PartyAffiliationRow>({ view: 'party_affiliations', select: '*', key: ['party', id], limit: 200, build: (q) => q.eq('party_identity_id', id).order('person_name') })
  const candidacies = useRowsQuery<CandidacyRow>({ view: 'candidacies', select: '*', key: ['party', id], limit: 200, build: (q) => q.eq('party_identity_id', id).order('election_slug').order('candidate_name') })

  if (party.isPending) return <LoadingBlock label="Loading party identity" />
  if (party.isError) return <ErrorBlock error={party.error} onRetry={() => void party.refetch()} />
  const p = party.data
  if (!p) return (<><PageHeader eyebrow="Party label at source" title="Party identity not found" /><EmptyBlock message="No party identity with this id was returned." /></>)

  return (
    <>
      <p className="mb-2 text-sm"><Link to="/parliament" className="doc-link">← Parliament</Link></p>
      <PageHeader eyebrow="Party label at source" title={p.name_at_source ?? 'Party identity (label not shown)'}>
        <p>{PARTY_IDENTITY_NOTE}.</p>
      </PageHeader>
      <div className="mb-6 space-y-2">
        {p.is_independent_label ? <Note tone="caution" testId="independent-note">This is a label, not a registered party.</Note> : null}
        <Note testId="rights-note">{RIGHTS_NOTE}</Note>
      </div>
      <Section title="Identity">
        <KeyValueList items={[
          { label: 'Source', value: <Link to="/sources/$sourceId" params={{ sourceId: p.source_id }} className="doc-link font-mono text-[13px]">{p.source_id}</Link> },
          { label: 'Label at source', value: p.name_at_source ?? NOT_SHOWN },
          { label: 'Review state', value: <LinkStatusBadge status={p.link_status} /> },
          { label: 'Identity id', value: <Mono>{p.id}</Mono> },
          { label: 'Relationship graph', value: <Link to="/graph" search={{ kind: 'party_identity', id: p.id }} className="doc-link" data-testid="open-graph">Open bounded graph from this party label</Link> },
        ]} />
      </Section>
      <Section title="Members observed with this label" description="From a directory sighting. A sitting member is not a candidate.">
        <Panel query={members} caption="Members observed with this label" head={['Member at source', 'Representation', 'Electorate at source', 'Observed from', 'Observed to']}>
          {(t) => (
            <TableRow key={t.id} data-testid="party-member-row">
              <Cell><EntityLink kind="person_identity" id={t.person_identity_id}>{t.member_name ?? NOT_SHOWN}</EntityLink></Cell>
              <Cell>{t.representation ? humanise(t.representation) : NOT_SHOWN}</Cell>
              <Cell><EntityLink kind="electorate_version" id={t.electorate_version_id}>{t.electorate_name_at_source ?? (t.representation === 'list' ? 'none (list member)' : NOT_SHOWN)}</EntityLink></Cell>
              <Cell>{formatDateTime(t.observed_first_at)}</Cell>
              <Cell>{formatDateTime(t.observed_last_at)}</Cell>
            </TableRow>
          )}
        </Panel>
      </Section>
      <Section title="Affiliations recorded with this label">
        <Panel query={affiliations} caption="Affiliations recorded with this label" head={['Person at source', 'Basis', 'Observed from', 'Observed to', 'Evidence']}>
          {(a) => (
            <TableRow key={a.id}>
              <Cell><EntityLink kind="person_identity" id={a.person_identity_id}>{a.person_name ?? NOT_SHOWN}</EntityLink></Cell>
              <Cell>{humanise(a.basis)}</Cell>
              <Cell>{formatDateTime(a.observed_first_at)}</Cell>
              <Cell>{formatDateTime(a.observed_last_at)}</Cell>
              <Cell><EvidenceVersionLink versionId={a.evidence_version_id} /></Cell>
            </TableRow>
          )}
        </Panel>
      </Section>
      <Section title="Candidacies recorded with this label" description="Alphabetical. Nothing here is arranged by votes, and no total is drawn up for the label.">
        <Panel query={candidacies} caption="Candidacies recorded with this label" head={['Election', 'Candidate at source', 'Type', 'Electorate', 'Status']}>
          {(c) => (
            <TableRow key={c.id} data-testid="party-candidacy-row">
              <Cell><Link to="/elections/$slug" params={{ slug: c.election_slug }} className="doc-link">{c.election_slug}</Link></Cell>
              <Cell><EntityLink kind="person_identity" id={c.person_identity_id}>{c.candidate_name ?? NOT_SHOWN}</EntityLink></Cell>
              <Cell>{c.candidacy_type ? humanise(c.candidacy_type) : NOT_SHOWN}</Cell>
              <Cell><EntityLink kind="electorate_version" id={c.electorate_version_id}>{c.electorate_name ?? (c.candidacy_type === 'list' ? 'none (party list)' : NOT_SHOWN)}</EntityLink></Cell>
              <Cell>{c.current_status ? <CandidacyStatusBadge status={c.current_status} /> : NOT_SHOWN}</Cell>
            </TableRow>
          )}
        </Panel>
      </Section>
    </>
  )
}

/** One electorate within one boundary edition, and the candidacies contested in it. */
export function ElectorateVersionDetailPage() {
  const params = electorateRoute.useParams()
  const id = isUuid(params.versionId) ? params.versionId : NO_ID
  const electorate = useOneQuery<ElectorateVersionRow>({ view: 'electorates', select: '*', column: 'id', value: id })
  const candidacies = useRowsQuery<CandidacyRow>({ view: 'candidacies', select: '*', key: ['electorate', id], limit: 200, build: (q) => q.eq('electorate_version_id', id).order('election_slug').order('candidate_name') })

  if (electorate.isPending) return <LoadingBlock label="Loading electorate" />
  if (electorate.isError) return <ErrorBlock error={electorate.error} onRetry={() => void electorate.refetch()} />
  const e = electorate.data
  if (!e) return (<><PageHeader eyebrow="Electorate (boundary edition)" title="Electorate version not found" /><EmptyBlock message="No electorate version with this id was returned." /></>)

  return (
    <>
      <p className="mb-2 text-sm"><Link to="/elections" className="doc-link">← Elections</Link></p>
      <PageHeader eyebrow="Electorate (boundary edition)" title={e.name ?? 'Electorate (name not shown)'}>
        <p>An electorate as it stood in one boundary edition. A later boundary review makes a new version; it never rewrites the results of an earlier election.</p>
      </PageHeader>
      <div className="mb-6 space-y-2">
        {e.boundary_edition_verified === false || e.electorate_type === 'unverified' ? <Note tone="caution" testId="electorate-unverified">The electorate type and this boundary edition have not been verified against an official source. General or Māori is shown only once verified.</Note> : null}
        <Note testId="rights-note">{RIGHTS_NOTE}</Note>
      </div>
      <Section title="Version">
        <KeyValueList items={[
          { label: 'Name', value: e.name ?? NOT_SHOWN },
          { label: 'Type', value: e.electorate_type ? humanise(e.electorate_type) : NOT_SHOWN, testId: 'electorate-type' },
          { label: 'Official code', value: e.official_code ?? 'not recorded' },
          { label: 'Boundary edition', value: e.boundary_edition_title ?? e.boundary_edition ?? NOT_SHOWN },
          { label: 'Edition verified', value: e.boundary_edition_verified === null ? NOT_SHOWN : e.boundary_edition_verified ? 'yes' : 'no' },
          { label: 'Evidence', value: e.evidence_version_id ? <EvidenceVersionLink versionId={e.evidence_version_id} /> : 'none recorded' },
          { label: 'Relationship graph', value: <Link to="/graph" search={{ kind: 'electorate_version', id: e.id }} className="doc-link" data-testid="open-graph">Open bounded graph from this electorate</Link> },
        ]} />
      </Section>
      <Section title="Candidacies in this electorate" description="Alphabetical by candidate. Votes are shown as the source reported them and never order the list.">
        <Panel query={candidacies} caption="Candidacies in this electorate" head={['Election', 'Candidate at source', 'Party label at source', 'Status', 'Votes as reported']}>
          {(c) => (
            <TableRow key={c.id} data-testid="electorate-candidacy-row">
              <Cell><Link to="/elections/$slug" params={{ slug: c.election_slug }} className="doc-link">{c.election_slug}</Link></Cell>
              <Cell><EntityLink kind="person_identity" id={c.person_identity_id}>{c.candidate_name ?? NOT_SHOWN}</EntityLink></Cell>
              <Cell><EntityLink kind="party_identity" id={c.party_identity_id}>{c.party_label ?? NOT_SHOWN}</EntityLink></Cell>
              <Cell>{c.current_status ? <CandidacyStatusBadge status={c.current_status} /> : NOT_SHOWN}</Cell>
              <Cell><span className="num" data-testid="votes-cell">{formatVotes(c.votes, c.votes_status, c.candidacy_type)}</span></Cell>
            </TableRow>
          )}
        </Panel>
      </Section>
    </>
  )
}
