import { ExternalLink as ExternalLinkIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <header className="mb-6 border-b border-rule pb-5">
      {eyebrow ? <p className="eyebrow mb-1.5">{eyebrow}</p> : null}
      <h1 className="text-[1.9rem] leading-tight">{title}</h1>
      {children ? <div className="mt-3 max-w-3xl space-y-2 text-[0.95rem] text-muted-foreground">{children}</div> : null}
    </header>
  )
}

export function Section({ title, description, children, id, className }: { title: string; description?: ReactNode; children: ReactNode; id?: string; className?: string }) {
  const headingId = id ? `${id}-heading` : undefined
  return (
    <section aria-labelledby={headingId} id={id} className={cn('mb-10', className)}>
      <h2 id={headingId} className="text-xl">
        {title}
      </h2>
      {description ? <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  )
}

export function Note({ children, testId, tone = 'plain' }: { children: ReactNode; testId?: string; tone?: 'plain' | 'caution' }) {
  return (
    <p
      data-testid={testId}
      className={cn(
        'max-w-3xl border-l-2 py-1.5 pl-3 text-sm',
        tone === 'caution' ? 'border-caution-foreground/60 bg-caution text-caution-foreground pr-3' : 'border-primary/50 text-foreground',
      )}
    >
      {children}
    </p>
  )
}

/** Outbound link to a publisher. Always opens without an opener or a referrer. */
export function ExternalLink({ href, children, className }: { href: string; children?: ReactNode; className?: string }) {
  const safe = /^https?:\/\//i.test(href)
  if (!safe) return <span className={className}>{children ?? href}</span>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn('doc-link inline-flex max-w-full items-baseline gap-1 break-all', className)}>
      <span>{children ?? href}</span>
      <ExternalLinkIcon aria-hidden="true" className="size-3 shrink-0 self-center" />
      <span className="sr-only">(opens the publisher site in a new tab)</span>
    </a>
  )
}

export function KeyValueList({ items, columns = 2 }: { items: ReadonlyArray<{ label: string; value: ReactNode; testId?: string }>; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cn('grid gap-x-8 gap-y-3 border-y border-border py-4 text-sm', columns === 1 ? 'grid-cols-1' : columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3')}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0" data-testid={item.testId}>
          <dt className="eyebrow">{item.label}</dt>
          <dd className="mt-0.5 break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code title={title} className="break-all font-mono text-[12.5px]">
      {children}
    </code>
  )
}
