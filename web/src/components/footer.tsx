import { ExternalLink } from './page'

const POLICY_BASE = 'https://github.com/thecolab-ai/nz-election-evidence/blob/main/'
/** R8 contact route. A public issue tracker, so nobody's private address is published here. */
export const CONTACT_URL = 'https://github.com/thecolab-ai/nz-election-evidence/issues'

export const POLICY_LINKS = [
  { file: 'RED-LINES.md', label: 'Red lines (RED-LINES.md)' },
  { file: 'CORRECTIONS.md', label: 'Corrections log (CORRECTIONS.md)' },
  { file: 'REVIEW-REGISTER.md', label: 'Review register (REVIEW-REGISTER.md)' },
] as const

/**
 * R8: named accountability on every surface. Rendered by the shell, so every route carries it.
 * The accountable person is a HUMAN decision: this component names one only after that person has accepted the
 * role in writing (README and REVIEW-REGISTER.md). Until then it says so plainly, and the database gate
 * r8_accountable_legal_entity keeps every evidence row from anonymous readers.
 */
export function AccountabilityFooter() {
  return (
    <footer aria-label="Project accountability and policy links" className="mt-16 border-t border-rule bg-muted/50">
      <div className="mx-auto grid max-w-[92rem] gap-6 px-5 py-8 text-sm lg:grid-cols-[2fr_1fr] lg:px-8">
        <div className="max-w-3xl space-y-2">
          <p>
            <strong className="font-semibold">Responsible project:</strong> The Colab — NZ Election Evidence project.
          </p>
          <p>
            <strong className="font-semibold">Project maintainer/contact:</strong> Adam Holt.{' '}
            <ExternalLink href={CONTACT_URL}>Contact the project or report a problem</ExternalLink>
          </p>
          <p data-testid="accountable-person">
            <strong className="font-semibold">Accountable person:</strong> not yet confirmed. Nobody has formally accepted that role, so none is named
            here, and the evidence in this explorer stays withheld until a named person has accepted it and that is recorded.
          </p>
          <p>
            This is an independent project. It is not affiliated with, endorsed by, or acting for the New Zealand Parliament, the
            Electoral Commission, or any political party or candidate.
          </p>
          <p>Legal review remains pending. These project notices are not legal advice.</p>
        </div>
        <nav aria-label="Policy documents">
          <p className="eyebrow mb-2">Policy documents</p>
          <ul className="space-y-1.5">
            {POLICY_LINKS.map((link) => (
              <li key={link.file}>
                <ExternalLink href={`${POLICY_BASE}${link.file}`}>{link.label}</ExternalLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  )
}
