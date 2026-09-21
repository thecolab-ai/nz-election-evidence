import { Link, Outlet } from '@tanstack/react-router'
import { Eye } from 'lucide-react'
import { appConfig } from '@/lib/env'
import { useSurfaceStatus } from '@/routes/access'
import { AccountabilityFooter } from './footer'
import { OwnerOverrideNotice } from './owner-override-notice'

export const PREVIEW_BANNER = 'Public read-only evidence register. Records are links and metadata from official publishers, shown with their provenance. Nothing here is a finding, a ranking or a recommendation.'

const NAV_GROUPS = [
  {
    label: 'Start here',
    items: [{ to: '/', label: 'Find an electorate', exact: true }],
  },
  {
    label: 'Evidence',
    items: [
      { to: '/overview', label: 'Overview' },
      { to: '/sources', label: 'Sources' },
      { to: '/records', label: 'Records' },
      { to: '/documents', label: 'Documents' },
    ],
  },
  {
    label: 'Civic model',
    items: [
      { to: '/people', label: 'People' },
      { to: '/parliament', label: 'Parliament' },
      { to: '/elections', label: 'Elections' },
      { to: '/finance', label: 'Finance' },
      { to: '/donations', label: 'Donations' },
      { to: '/statistics', label: 'Statistics' },
      { to: '/graph', label: 'Relationships' },
    ],
  },
  {
    label: 'Stewardship',
    items: [
      { to: '/datasets', label: 'Datasets and schema' },
      { to: '/rights', label: 'Rights register' },
      { to: '/operations', label: 'Operations' },
    ],
  },
] as const

export function PreviewBanner() {
  return (
    <div role="note" aria-label="Preview notice" data-testid="preview-banner" className="border-b border-caution-foreground/30 bg-caution text-caution-foreground">
      <p className="mx-auto flex max-w-[92rem] items-start gap-2 px-5 py-2 text-[13px] lg:px-8">
        <Eye aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span>{PREVIEW_BANNER}</span>
      </p>
    </div>
  )
}

export function Shell() {
  const showNav = appConfig !== null
  // Disabled (no request) when the shell is not connected. The notice reflects the database's answer, nothing else.
  const surface = useSurfaceStatus()
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-paper focus:px-3 focus:py-2 focus:shadow">
        Skip to main content
      </a>
      <PreviewBanner />
      <OwnerOverrideNotice status={surface.data} />
      <header className="border-b border-rule bg-paper">
        <div className="mx-auto flex max-w-[92rem] items-center justify-between gap-4 px-5 py-4 lg:px-8">
          <Link to="/" className="group flex items-baseline gap-3 no-underline">
            <span className="font-serif text-xl font-semibold tracking-tight">Evidence Explorer</span>
            <span className="eyebrow hidden sm:inline">NZ Election Evidence</span>
          </Link>
          <span className="eyebrow hidden md:inline">Read-only · no sign-in</span>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-[92rem] flex-1 flex-col lg:flex-row">
        {showNav ? (
          <nav aria-label="Sections" className="border-b border-border px-5 py-3 lg:w-56 lg:shrink-0 lg:border-r lg:border-b-0 lg:px-6 lg:py-8">
            <div className="flex flex-wrap gap-x-8 gap-y-3 lg:sticky lg:top-6 lg:flex-col lg:gap-6">
              {NAV_GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="eyebrow mb-1.5">{group.label}</p>
                  <ul className="flex flex-wrap gap-x-4 gap-y-1 lg:flex-col lg:gap-0.5">
                    {group.items.map((item) => (
                      <li key={item.to}>
                        <Link
                          to={item.to}
                          activeOptions={{ exact: 'exact' in item && item.exact, includeSearch: false }}
                          className="-mx-2 block rounded-sm border-l-2 border-transparent px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
                          activeProps={{ className: 'border-primary! text-foreground! font-semibold', 'aria-current': 'page' }}
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </nav>
        ) : null}
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-5 py-8 outline-none lg:px-10">
          <Outlet />
        </main>
      </div>
      <AccountabilityFooter />
    </div>
  )
}
