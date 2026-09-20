import { ExternalLink } from './page'

const POLICY_BASE = 'https://github.com/thecolab-ai/nz-election-evidence/blob/main/'

export const POLICY_LINKS = [
  { file: 'RED-LINES.md', label: 'Red lines (RED-LINES.md)' },
  { file: 'CORRECTIONS.md', label: 'Corrections log (CORRECTIONS.md)' },
  { file: 'REVIEW-REGISTER.md', label: 'Review register (REVIEW-REGISTER.md)' },
] as const

/** R8: named accountability on every surface. Rendered by the shell, so every route carries it. */
export function AccountabilityFooter() {
  return (
    <footer aria-label="Project accountability and policy links" className="mt-16 border-t border-rule bg-muted/50">
      <div className="mx-auto grid max-w-[92rem] gap-6 px-5 py-8 text-sm lg:grid-cols-[2fr_1fr] lg:px-8">
        <div className="max-w-3xl space-y-2">
          <p>
            <strong className="font-semibold">Responsible project:</strong> The Colab — NZ Election Evidence project.
          </p>
          <p>
            <strong className="font-semibold">Project maintainer/contact:</strong> Adam Holt.
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
