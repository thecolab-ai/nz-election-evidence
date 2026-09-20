import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { entityRoute } from '@/lib/graph'

/**
 * Links a reference to the page of the entity it names, when that kind of entity has one. A party label
 * goes to the party identity, an electorate to the electorate version, a name to the source identity.
 * Without an id (or for a kind with no page) the text is shown unlinked.
 */
export function EntityLink({ kind, id, children, testId }: { kind: string; id: string | null | undefined; children: ReactNode; testId?: string }) {
  const route = id ? entityRoute(kind, id) : null
  if (!route) return <>{children}</>
  if (route.to === '/people/$identityId') return <Link to={route.to} params={route.params} className="doc-link" data-testid={testId}>{children}</Link>
  if (route.to === '/parties/$identityId') return <Link to={route.to} params={route.params} className="doc-link" data-testid={testId}>{children}</Link>
  return <Link to={route.to} params={route.params} className="doc-link" data-testid={testId}>{children}</Link>
}
