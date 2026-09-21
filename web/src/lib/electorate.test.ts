import { describe, expect, it } from 'vitest'
import { DataError } from './queries'
import {
  ACTIVITY_NOT_EFFECTIVENESS_NOTE,
  BOUNDARY_NOT_COMPARABLE_NOTE,
  classify,
  classifyNamed,
  electorateAddress,
  foldForSearch,
  isDeploymentTooSlow,
  isMissingDataset,
  matchElectorates,
  moveActiveIndex,
  NO_2026_NOMINATION_NOTE,
  NO_ADDRESS_NOTE,
  NOT_A_CANDIDATE_NOTE,
  PARTY_NOT_CANDIDATE_RECEIPT_NOTE,
  provenanceForSource,
  provenanceSpanning,
  REPRESENTATION_MATCH_NOTE,
  resolveSlug,
} from './electorate'

// Names as the Electoral Commission writes them; the folding below must never change how they are DISPLAYED.
const ELECTORATES = [
  { id: '1', slug: 'otaki', name: 'Ōtaki' },
  { id: '2', slug: 'mana', name: 'Mana' },
  { id: '3', slug: 'manurewa', name: 'Manurewa' },
  { id: '4', slug: 'te-tai-tokerau', name: 'Te Tai Tokerau' },
  { id: '5', slug: 'tamaki-makaurau', name: 'Tāmaki Makaurau' },
  { id: '6', slug: 'kaikoura', name: 'Kaikōura' },
]

describe('finding an electorate by name', () => {
  it('finds a macronised name typed without macrons, and never rewrites the name itself', () => {
    const found = matchElectorates(ELECTORATES, 'otaki')
    expect(found.map((e) => e.name)).toEqual(['Ōtaki'])
    // The displayed value is untouched: folding is a search key, not a transformation of the record.
    expect(found[0]?.name).toBe('Ōtaki')
    expect(matchElectorates(ELECTORATES, 'Kaikoura').map((e) => e.slug)).toEqual(['kaikoura'])
    expect(matchElectorates(ELECTORATES, 'tamaki').map((e) => e.name)).toEqual(['Tāmaki Makaurau'])
  })

  it('puts names that start with the query before names that merely contain it', () => {
    expect(matchElectorates(ELECTORATES, 'man').map((e) => e.slug)).toEqual(['mana', 'manurewa'])
    expect(matchElectorates(ELECTORATES, 'tokerau').map((e) => e.slug)).toEqual(['te-tai-tokerau'])
  })

  it('offers the whole list for an empty query rather than guessing', () => {
    expect(matchElectorates(ELECTORATES, '')).toHaveLength(ELECTORATES.length)
    expect(matchElectorates(ELECTORATES, '   ')).toHaveLength(ELECTORATES.length)
  })

  it('returns nothing for a name it does not hold, and invents no near match', () => {
    expect(matchElectorates(ELECTORATES, 'Wellington Central')).toEqual([])
    expect(matchElectorates(ELECTORATES, 'zzz')).toEqual([])
  })

  it('folds case, macrons, hyphens and spaces the same way', () => {
    expect(foldForSearch('Te Tai Tokerau')).toBe('te tai tokerau')
    expect(foldForSearch('Kaikōura')).toBe('kaikoura')
    expect(foldForSearch('West Coast-Tasman')).toBe('west coast tasman')
  })
})

describe('resolving a shared address', () => {
  const loaded = [
    { id: '1', slug: 'ōtaki' },
    { id: '2', slug: 'mana' },
    { id: '5', slug: 'tāmaki-makaurau' },
  ]

  it('resolves a macron-stripped address to the electorate it names', () => {
    expect(resolveSlug(loaded, 'otaki')?.id).toBe('1')
    expect(resolveSlug(loaded, 'tamaki-makaurau')?.id).toBe('5')
  })

  it('resolves an address that already matches exactly', () => {
    expect(resolveSlug(loaded, 'mana')?.id).toBe('2')
  })

  it('refuses to guess when an address is genuinely ambiguous', () => {
    const ambiguous = [{ id: 'a', slug: 'tamaki' }, { id: 'b', slug: 'tāmaki' }]
    expect(resolveSlug(ambiguous, 'tamaki')).toBeNull()
  })

  it('resolves nothing for an address it does not hold, or for an empty one', () => {
    expect(resolveSlug(loaded, 'nowhere')).toBeNull()
    expect(resolveSlug(loaded, '')).toBeNull()
    expect(resolveSlug(loaded, '   ')).toBeNull()
  })

  /**
   * The regression this suite exists for. `electorates.slug` is publisher content in the public
   * projection — it is a lowercased form of the NAME — and no rights row or owner decision names a
   * `slug` field, so a deployment that releases the electorate name still returns `slug: null`.
   * Every journey address was built from that column, so the picker offered nothing and every
   * electorate page answered "no electorate with this address".
   */
  const slugWithheld = [
    { id: '1', slug: null, name: 'Ōtaki' },
    { id: '2', slug: null, name: 'Fixture Electorate A' },
  ]

  it('addresses an electorate by the store’s own slug wherever the deployment releases one', () => {
    expect(electorateAddress({ slug: 'te-tai-tokerau', name: 'Te Tai Tokerau' })).toBe('te-tai-tokerau')
    // The store's slug wins even where it differs: this application never overrules the store.
    expect(electorateAddress({ slug: 'legacy-address', name: 'Te Tai Tokerau' })).toBe('legacy-address')
  })

  it('falls back to the same fold of the name the store itself uses when the slug is withheld', () => {
    expect(electorateAddress({ slug: null, name: 'Fixture Electorate A' })).toBe('fixture-electorate-a')
    expect(electorateAddress({ slug: null, name: 'Ōtaki' })).toBe('ōtaki')
    expect(electorateAddress({ slug: null, name: 'Te Tai Tokerau' })).toBe('te-tai-tokerau')
  })

  it('has no address at all when the name is withheld too, and invents nothing', () => {
    expect(electorateAddress({ slug: null, name: null })).toBeNull()
    expect(electorateAddress({ slug: null, name: '' })).toBeNull()
    expect(resolveSlug([{ id: 'x', slug: null, name: null }], 'anything')).toBeNull()
  })

  it('resolves a shared link on a deployment whose slug column is blank', () => {
    expect(resolveSlug(slugWithheld, 'fixture-electorate-a')?.id).toBe('2')
    // And still macron-tolerantly, which is the reason the fold exists.
    expect(resolveSlug(slugWithheld, 'otaki')?.id).toBe('1')
    expect(resolveSlug(slugWithheld, 'nowhere')).toBeNull()
  })

  it('still refuses to guess between two names that fold to one address', () => {
    const ambiguous = [{ id: 'a', slug: null, name: 'Tamaki' }, { id: 'b', slug: null, name: 'Tāmaki' }]
    expect(resolveSlug(ambiguous, 'tamaki')).toBeNull()
  })
})

describe('keyboard movement through the options', () => {
  it('wraps in both directions and jumps to the ends', () => {
    expect(moveActiveIndex(-1, 3, 'ArrowDown')).toBe(0)
    expect(moveActiveIndex(2, 3, 'ArrowDown')).toBe(0)
    expect(moveActiveIndex(0, 3, 'ArrowUp')).toBe(2)
    expect(moveActiveIndex(1, 3, 'Home')).toBe(0)
    expect(moveActiveIndex(1, 3, 'End')).toBe(2)
  })

  it('highlights nothing when there is nothing to highlight', () => {
    expect(moveActiveIndex(0, 0, 'ArrowDown')).toBe(-1)
    expect(moveActiveIndex(0, 0, 'End')).toBe(-1)
  })
})

describe('the four ways a panel can be silent', () => {
  const error = (code: string) => new DataError('simulated (TEST FIXTURE)', code)

  it('tells a missing dataset apart from an empty one', () => {
    expect(isMissingDataset(error('PGRST205'))).toBe(true)
    expect(isMissingDataset(error('42P01'))).toBe(true)
    expect(isMissingDataset(error('57014'))).toBe(false)
    expect(isMissingDataset(null)).toBe(false)
  })

  it('tells a cancelled statement apart from a failure', () => {
    expect(isDeploymentTooSlow(error('57014'))).toBe(true)
    expect(isDeploymentTooSlow(error('PGRST205'))).toBe(false)
  })

  it('classifies each state, and never reports an unanswered query as zero rows', () => {
    const base = { isPending: false, isError: false, error: null, data: undefined }
    expect(classify({ ...base, isPending: true })).toEqual({ state: 'loading' })
    expect(classify({ ...base, data: [] })).toEqual({ state: 'none_held' })
    expect(classify({ ...base, data: [{ id: 'x' }] })).toEqual({ state: 'ready', rows: [{ id: 'x' }] })
    expect(classify({ ...base, isError: true, error: error('PGRST205') }).state).toBe('not_loaded')
    expect(classify({ ...base, isError: true, error: error('57014') }).state).toBe('not_answerable')
    expect(classify({ ...base, isError: true, error: error('XX000') }).state).toBe('failed')
    // A failed query is never allowed to look like an answered one, even while it is also pending.
    expect(classify({ ...base, isPending: true, isError: true, error: error('57014') }).state).toBe('not_answerable')
  })

  it('does not wait for a question it never asked, when the store records no name to ask it with', () => {
    // A panel filtered only on the electorate's name cannot run at all when there is no name. The query
    // is switched off, and a switched-off query reports itself as pending for ever; the panel must not.
    const never = { isPending: true, isError: false, error: null, data: undefined }
    expect(classifyNamed(null, never)).toEqual({ state: 'none_held' })
    expect(classifyNamed(undefined, never)).toEqual({ state: 'none_held' })
    expect(classifyNamed('', never)).toEqual({ state: 'none_held' })
    // With a name, nothing changes: the query's own state is what the reader is told.
    expect(classifyNamed('Ōtaki', never)).toEqual({ state: 'loading' })
    expect(classifyNamed('Ōtaki', { ...never, isPending: false, data: [] })).toEqual({ state: 'none_held' })
  })
})

describe('provenance', () => {
  const sources = [
    { source_id: 'parliament_export_member_terms', publisher: 'New Zealand Parliament', official_url: 'https://example.invalid/terms', last_success_at: '2026-09-21T06:38:44Z', latest_source_published_at: '2026-09-01T00:00:00Z' },
  ]

  it('takes the publisher, the publisher’s date and the retrieval date from the store', () => {
    const p = provenanceForSource(sources, 'parliament_export_member_terms', 'fallback')
    expect(p.publisher).toBe('New Zealand Parliament')
    expect(p.sourceDate).toBe('2026-09-01T00:00:00Z')
    expect(p.retrievedAt).toBe('2026-09-21T06:38:44Z')
    // The two dates are held separately; nothing substitutes one for the other.
    expect(p.sourceDate).not.toBe(p.retrievedAt)
  })

  it('falls back to a named publisher rather than showing a blank, and claims no dates it does not have', () => {
    const p = provenanceForSource(sources, 'not_a_loaded_source', 'Electoral Commission')
    expect(p.publisher).toBe('Electoral Commission')
    expect(p.sourceDate).toBeNull()
    expect(p.retrievedAt).toBeNull()
    expect(p.officialUrl).toBeNull()
  })

  describe('a card whose rows come from more than one source', () => {
    const two = [
      { source_id: 'candidate_disclosures', publisher: 'Electoral Commission', official_url: 'https://example.invalid/candidate', last_success_at: '2026-09-21T06:00:00Z', latest_source_published_at: '2026-08-01T00:00:00Z' },
      { source_id: 'party_disclosures', publisher: 'Electoral Commission', official_url: 'https://example.invalid/party', last_success_at: '2026-09-10T06:00:00Z', latest_source_published_at: '2026-05-01T00:00:00Z' },
    ]

    it('never claims the whole card is as fresh as its freshest part', () => {
      const p = provenanceSpanning(two, ['candidate_disclosures', 'party_disclosures'], 'Electoral Commission')
      expect(p.publisher).toBe('Electoral Commission')
      expect(p.retrievedAt).toBe('2026-09-10T06:00:00Z')
      expect(p.sourceDate).toBe('2026-05-01T00:00:00Z')
      // There is no single "the original" for two sources; each row carries its own link.
      expect(p.officialUrl).toBeNull()
      expect(p.sourceId).toBe('candidate_disclosures + party_disclosures')
    })

    it('is the ordinary one-source strip when only one source is actually shown', () => {
      const p = provenanceSpanning(two, ['party_disclosures', 'party_disclosures'], 'Electoral Commission')
      expect(p.sourceId).toBe('party_disclosures')
      expect(p.officialUrl).toBe('https://example.invalid/party')
      expect(p.retrievedAt).toBe('2026-09-10T06:00:00Z')
    })

    it('says how many publishers there are rather than picking one of them', () => {
      const mixed = [two[0] as (typeof two)[number], { ...(two[1] as (typeof two)[number]), publisher: 'New Zealand Parliament' }]
      expect(provenanceSpanning(mixed, ['candidate_disclosures', 'party_disclosures'], 'fallback').publisher).toBe('2 publishers, each named on its own entry')
    })

    it('claims no date at all for sources the store does not list', () => {
      const p = provenanceSpanning(two, ['not_loaded_a', 'not_loaded_b'], 'Electoral Commission')
      expect(p.publisher).toBe('Electoral Commission')
      expect(p.sourceDate).toBeNull()
      expect(p.retrievedAt).toBeNull()
    })
  })
})

describe('the sentences this product must not get wrong', () => {
  it('says a sitting member is not a candidate', () => {
    expect(NOT_A_CANDIDATE_NOTE).toContain('A sitting member is not a candidate')
  })

  it('says activity is not effectiveness and is never scored', () => {
    expect(ACTIVITY_NOT_EFFECTIVENESS_NOTE).toContain('not a measure of effectiveness')
    expect(ACTIVITY_NOT_EFFECTIVENESS_NOTE).toContain('never counted up into a score')
  })

  it('says a party’s return is not a candidate’s receipt', () => {
    expect(PARTY_NOT_CANDIDATE_RECEIPT_NOTE).toContain('not a receipt by any candidate')
  })

  it('says two boundary editions with one name are not the same area', () => {
    expect(BOUNDARY_NOT_COMPARABLE_NOTE).toContain('is not the same area')
  })

  it('discloses that the member match is between two pieces of text, not a reviewed link', () => {
    expect(REPRESENTATION_MATCH_NOTE).toContain('not a reviewed link')
    expect(REPRESENTATION_MATCH_NOTE).toContain('correspondence between two pieces of text')
  })

  it('states that no address or location is asked for, stored or sent', () => {
    expect(NO_ADDRESS_NOTE).toContain('never asks for, stores or sends an address or a location')
  })

  /**
   * One sentence for one gap, on the homepage card and the electorate card alike. The browser journey
   * asserts the first clause verbatim; the rest is what stops the sentence being narrowed back down to
   * a half-truth — a nomination and an announcement are different things, and the gap belongs to the
   * whole store rather than to this electorate.
   */
  it('says the same thing about 2026 wherever it is printed, and says all of it', () => {
    // The clause the browser journey holds this product to.
    expect(NO_2026_NOMINATION_NOTE).toContain('no official nomination for 2026 has been loaded')
    // An official nomination and a party's own announcement are not the same thing; neither is held.
    expect(NO_2026_NOMINATION_NOTE).toContain('no party announcement either')
    // The gap is the store's, so no reader may infer that some other electorate has a list.
    expect(NO_2026_NOMINATION_NOTE).toContain('for any electorate')
    // It is a clause, so both cards can lead into it; it must not arrive with its own sentence case.
    expect(NO_2026_NOMINATION_NOTE).not.toMatch(/^[A-Z]|\.$/)
  })

  it('carries none of the wording the red-line scanner refuses', () => {
    const all = [NOT_A_CANDIDATE_NOTE, ACTIVITY_NOT_EFFECTIVENESS_NOTE, PARTY_NOT_CANDIDATE_RECEIPT_NOTE, BOUNDARY_NOT_COMPARABLE_NOTE, REPRESENTATION_MATCH_NOTE, NO_ADDRESS_NOTE].join(' ')
    expect(all).not.toMatch(/\b(lied|lies|liar|dishonest|corrupt|fraud|vote for|vote against|re-?elect)\b/i)
  })
})
