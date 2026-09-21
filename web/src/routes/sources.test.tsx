import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { effectiveSort, parseListSearch } from '@/lib/search'
import { sourcesSpec } from '@/lib/specs'
import { HeldCell, RECORDS_COUNTED_ON_THE_SOURCE_PAGE, SOURCES_COLUMNS, SOURCES_SELECT } from './sources'

// Invented values labelled as fixtures; none of this is evidence.

describe('the sources list does not pay for a count it does not print', () => {
  it('the list asks for no record count, and says where the count is instead of standing a number in for it', () => {
    expect(SOURCES_SELECT.split(',')).not.toContain('live_records')
    expect(SOURCES_SELECT.split(',')).not.toContain('content_versions')
    render(<HeldCell source={{ statistical_observations: null, statistical_observations_without_a_number: null, statistical_catalogue_entries: null }} />)
    expect(screen.getByTestId('held-deferred').textContent).toBe(RECORDS_COUNTED_ON_THE_SOURCE_PAGE)
    // No figure is printed in place of the count — not a zero, not an "unknown" that reads as one.
    expect(document.body.textContent).not.toMatch(/[0-9]/)
  })

  it('a statistics source still shows the counts recorded when its load finished', () => {
    render(<HeldCell source={{ statistical_observations: 57888, statistical_observations_without_a_number: 12, statistical_catalogue_entries: 4 }} />)
    const held = screen.getByTestId('held-statistics').textContent ?? ''
    expect(held).toContain('57,888')
    expect(held).toContain('4')
    expect(held).toContain('with no number printed by the publisher')
  })

  it('still prints a record count where one is given, so the cell keeps its contract for any caller that reads one', () => {
    render(<HeldCell source={{ live_records: 187956, statistical_observations: null, statistical_observations_without_a_number: null, statistical_catalogue_entries: null }} />)
    expect(screen.getByTestId('held-records').textContent).toBe('187,956 records')
  })
})

describe('no URL can put the count back into the list', () => {
  it('a hand-typed ?sort=live_records is dropped, and the ordering sent to the server is the default', () => {
    const search = parseListSearch(sourcesSpec, { sort: 'live_records', dir: 'desc' })
    // Not carried in the validated search at all, so no header renders as sorted by it either.
    expect(search.sort).toBeUndefined()
    expect(search.dir).toBeUndefined()
    expect(sourcesSpec.sortable).not.toContain('live_records')
    const columns = effectiveSort(sourcesSpec, search).map((rule) => rule.column)
    expect(columns).not.toContain('live_records')
    expect(columns).toEqual(['source_id'])
  })

  it('a sort key the URL does carry is still honoured, so the list did not lose sorting', () => {
    const search = parseListSearch(sourcesSpec, { sort: 'publisher', dir: 'desc' })
    expect(effectiveSort(sourcesSpec, search)).toEqual([
      { column: 'publisher', dir: 'desc' },
      { column: 'source_id', dir: 'asc' },
    ])
  })

  it('every sortable column is one this list actually fetches, so an ordering is never over an unshown number', () => {
    for (const column of sourcesSpec.sortable) expect(SOURCES_COLUMNS).toContain(column)
  })
})
