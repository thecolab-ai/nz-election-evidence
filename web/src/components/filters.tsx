import { X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function FilterBar({ children, onClear, hasActive, label = 'Filters' }: { children: ReactNode; onClear: () => void; hasActive: boolean; label?: string }) {
  return (
    <form role="search" aria-label={label} onSubmit={(event) => event.preventDefault()} className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3 border-y border-border bg-muted/40 px-3 py-3">
      {children}
      {hasActive ? (
        <Button type="button" variant="ghost" size="sm" onClick={onClear} className="ml-auto">
          <X aria-hidden="true" /> Clear filters
        </Button>
      ) : null}
    </form>
  )
}

function FieldShell({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex min-w-[9rem] flex-col gap-1">
      <label htmlFor={htmlFor} className="eyebrow">
        {label}
      </label>
      {children}
    </div>
  )
}

/** Text filter: commits to the URL after a short pause, on Enter, or on blur. */
export function TextFilter({ label, value, onCommit, placeholder, name }: { label: string; value: string | undefined; onCommit: (value: string | undefined) => void; placeholder?: string; name: string }) {
  const id = useId()
  const [draft, setDraft] = useState(value ?? '')
  const committed = useRef(value ?? '')

  useEffect(() => {
    // The URL changed from elsewhere (back button, clear filters).
    if ((value ?? '') !== committed.current) {
      committed.current = value ?? ''
      setDraft(value ?? '')
    }
  }, [value])

  const commit = (next: string) => {
    const cleaned = next.trim()
    if (cleaned === committed.current) return
    committed.current = cleaned
    onCommit(cleaned === '' ? undefined : cleaned)
  }

  useEffect(() => {
    const handle = window.setTimeout(() => commit(draft), 350)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  return (
    <FieldShell label={label} htmlFor={id}>
      <Input
        id={id}
        name={name}
        type="search"
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(draft)
        }}
        className="h-8 w-56 rounded-sm bg-paper text-sm"
      />
    </FieldShell>
  )
}

export function SelectFilter({ label, value, onChange, options, anyLabel = 'Any', name }: { label: string; value: string | undefined; onChange: (value: string | undefined) => void; options: ReadonlyArray<{ value: string; label: string }>; anyLabel?: string; name: string }) {
  const id = useId()
  return (
    <FieldShell label={label} htmlFor={id}>
      <select
        id={id}
        name={name}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
        className="h-8 min-w-[10rem] rounded-sm border border-input bg-paper px-2 text-sm"
      >
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  )
}

export function CheckboxFilter({ label, checked, onChange, name }: { label: string; checked: boolean; onChange: (checked: boolean) => void; name: string }) {
  const id = useId()
  return (
    <div className="flex h-8 items-center gap-2 self-end">
      <input id={id} name={name} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-[var(--primary)]" />
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
    </div>
  )
}
