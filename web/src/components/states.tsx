import { CircleAlert, CircleSlash, Inbox, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export const EMPTY_MESSAGE = 'No rows. This may mean nothing has been ingested yet — it is not evidence of absence.'

export function LoadingBlock({ label = 'Loading…', rows = 6 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" data-testid="loading-state" className="space-y-2 py-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-7 w-full rounded-sm" />
      ))}
    </div>
  )
}

export function EmptyBlock({ message = EMPTY_MESSAGE }: { message?: string }) {
  return (
    <div role="status" aria-live="polite" data-testid="empty-state" className="flex items-start gap-3 border border-dashed border-rule bg-paper px-4 py-5 text-sm text-muted-foreground">
      <Inbox aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>{message}</p>
    </div>
  )
}

/**
 * The dataset a panel reads is not on the deployment being read.
 *
 * This is NOT an error and must never be shown as one: a store that has not had a product imported
 * yet answers "the relation does not exist", and a red alert printing a PostgREST code tells a reader
 * the site is broken when the honest answer is that this deployment holds nothing here and claims
 * nothing either way.
 */
export function NotLoadedBlock({ datasetName }: { datasetName: string }) {
  return (
    <div role="status" data-testid="not-loaded" className="flex items-start gap-3 border border-dashed border-caution-foreground/50 bg-caution px-4 py-4 text-sm text-caution-foreground">
      <CircleSlash aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium">This part of the store is not on the deployment you are reading.</p>
        <p>
          The <code className="font-mono text-[12.5px]">{datasetName}</code> dataset answered that it does not exist here, so there is nothing to show
          and it makes no claim either way. It may exist on another deployment, or not be loaded yet.
        </p>
      </div>
    </div>
  )
}

export function ErrorBlock({ error, onRetry, title = 'The data service returned an error' }: { error: Error | { message: string; code?: string | null; hint?: string | null }; onRetry?: () => void; title?: string }) {
  const code = 'code' in error ? error.code : null
  const hint = 'hint' in error ? error.hint : null
  return (
    <div role="alert" aria-live="assertive" data-testid="error-state" className="border border-destructive/50 bg-paper px-4 py-4 text-sm">
      <div className="flex items-start gap-3">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-1">
          <p className="font-semibold">{title}</p>
          <p className="break-words font-mono text-[13px]">
            {code ? `${code}: ` : ''}
            {error.message}
          </p>
          {hint ? <p className="break-words text-muted-foreground">{hint}</p> : null}
          <p className="text-muted-foreground">An error is not evidence that no records exist.</p>
          {onRetry ? (
            <Button type="button" variant="outline" size="sm" onClick={onRetry} className="mt-2">
              <RotateCw aria-hidden="true" /> Retry
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
