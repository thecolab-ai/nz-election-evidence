import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderCell } from '@/routes/datasets'
import { AccountabilityFooter } from './footer'
import { PREVIEW_BANNER, PreviewBanner } from './shell'
import { EmptyBlock, ErrorBlock } from './states'
import { SummaryCard } from './summary-card'
import type { SummaryRow } from '@/lib/types'

describe('compliance text on every page', () => {
  it('footer names the project, the maintainer, independence, pending review, and links the three policy documents (R8)', () => {
    render(<AccountabilityFooter />)
    const footer = screen.getByRole('contentinfo', { name: 'Project accountability and policy links' })
    for (const phrase of ['Responsible project:', 'The Colab — NZ Election Evidence project', 'Project maintainer/contact:', 'Adam Holt', 'New Zealand Parliament', 'Electoral Commission', 'any political party or candidate', 'Legal review remains pending']) {
      expect(footer.textContent).toContain(phrase)
    }
    // R8 is a human gate: until someone accepts the role the footer must say so, and must not present the maintainer as that person.
    expect(screen.getByTestId('accountable-person').textContent).toContain('Accountable person: not yet confirmed')
    expect(screen.getByTestId('accountable-person').textContent).not.toContain('Adam Holt')
    expect(footer.textContent).toContain('stays withheld until a named person has accepted it')
    const hrefs = Array.from(footer.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('https://github.com/thecolab-ai/nz-election-evidence/issues')
    for (const file of ['RED-LINES.md', 'CORRECTIONS.md', 'REVIEW-REGISTER.md']) expect(hrefs).toContain(`https://github.com/thecolab-ai/nz-election-evidence/blob/main/${file}`)
    for (const a of Array.from(footer.querySelectorAll('a'))) expect(a.getAttribute('rel')).toContain('noopener')
  })
  it('banner says what this is and is not, without scanner-listed wording', () => {
    render(<PreviewBanner />)
    expect(screen.getByTestId('preview-banner').textContent).toContain('Public read-only evidence register')
    expect(PREVIEW_BANNER).toContain('Nothing here is a finding, a ranking or a recommendation.')
    expect(PREVIEW_BANNER).not.toMatch(/\b(lied|lies|liar|fraud|corrupt|vote for|vote against|re-?elect)\b/i)
  })
})

describe('states', () => {
  it('an empty table is never presented as evidence of absence', () => {
    render(<EmptyBlock />)
    expect(screen.getByTestId('empty-state').textContent).toBe('No rows. This may mean nothing has been ingested yet — it is not evidence of absence.')
  })
  it('an error shows the service message and is not evidence of absence either', () => {
    render(<ErrorBlock error={{ message: 'simulated failure (TEST FIXTURE)', code: 'XX000' }} />)
    expect(screen.getByTestId('error-state').textContent).toContain('XX000: simulated failure (TEST FIXTURE)')
    expect(screen.getByTestId('error-state').textContent).toContain('An error is not evidence that no records exist.')
  })
})

describe('generic dataset cells', () => {
  it('says null plainly and never prints it as zero or blank', () => {
    const { container } = render(<>{renderCell(null)}</>)
    expect(container.textContent).toBe('null')
  })
  it('truncates long text and keeps structured values behind the viewer', () => {
    const long = render(<>{renderCell('x'.repeat(300))}</>)
    expect(long.container.textContent?.length).toBeLessThan(130)
    const structured = render(<>{renderCell({ title: 'TEST FIXTURE value' })}</>)
    expect(structured.container.textContent).not.toContain('TEST FIXTURE value')
  })
})

describe('model output card (R9)', () => {
  const base: SummaryRow = {
    id: 's1', summary_text: 'TEST FIXTURE summary text', output_hash: 'sha256:x', uncertainty_note: null, review_status: 'approved', created_at: '2026-09-20T00:00:00Z',
    model_metadata_status: 'recorded', provider: 'TEST FIXTURE', model_name: 'fixture-model', model_version: '1.0', prompt_or_schema_version: 'fixture-schema-v1',
    confidence: null, confidence_status: 'not_reported', confidence_basis: null, schema_agreement_rate: null, schema_agreement_sample: null,
    schema_agreement_method_url: null, schema_agreement_validated_at: null, schema_agreement_documented: false,
  }
  it('an approved output with no agreement study still carries the human-review flag, and unknown confidence is said, not shown as a number', () => {
    render(<SummaryCard summary={base} />)
    expect(screen.getByTestId('not-human-reviewed').textContent).toBe('not yet checked against human review')
    expect(screen.getByTestId('summary-confidence').textContent).toBe('not reported by the model run')
    expect(screen.getByTestId('summary-confidence').textContent).not.toMatch(/\d/)
    expect(screen.getByTestId('summary-agreement').textContent).toBe('none documented for this schema version')
    expect(screen.getByTestId('summary-model').textContent).toBe('fixture-model')
  })
  it('a reported confidence shows with its basis; a documented agreement rate clears the flag and links the method', () => {
    render(<SummaryCard summary={{ ...base, confidence: 0, confidence_status: 'reported', confidence_basis: 'self-reported 0-1', schema_agreement_documented: true,
      schema_agreement_rate: 0.85, schema_agreement_sample: 40, schema_agreement_method_url: 'https://fixture.example/method' }} />)
    expect(screen.getByTestId('summary-confidence').textContent).toBe('0.00 (self-reported 0-1)')
    expect(screen.queryByTestId('not-human-reviewed')).toBeNull()
    expect(screen.getByTestId('summary-agreement').textContent).toContain('85.0% agreement with human reviewers on a sample of 40')
    expect(screen.getByRole('link', { name: /method/ }).getAttribute('href')).toBe('https://fixture.example/method')
  })
})
