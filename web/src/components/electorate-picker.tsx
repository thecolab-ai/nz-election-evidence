import { useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import { electorateAddress, matchElectorates, moveActiveIndex, type ElectorateChoice } from '@/lib/electorate'
import { cn } from '@/lib/utils'

/**
 * The first action on the site: pick an electorate by name.
 *
 * It asks for a NAME, never a location. There is no address box, no "use my location", no map
 * click and nothing that could carry where a reader lives to this application or to anyone else.
 * The whole list is already in the page, so typing filters it in the browser and sends nothing.
 *
 * Keyboard: type to filter, ArrowUp/ArrowDown/Home/End to move, Enter to open, Escape to close.
 * It is an ARIA combobox with a listbox popup; the option count is announced politely as it changes.
 */
export function ElectoratePicker({
  electorates,
  label = 'Find an electorate by name',
  autoFocus = false,
}: {
  electorates: readonly ElectorateChoice[]
  label?: string
  autoFocus?: boolean
}) {
  const navigate = useNavigate()
  const baseId = useId()
  const listId = `${baseId}-listbox`
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)

  // An electorate is offered when this application can address it. That is the store's own slug where
  // the deployment releases one, and the same fold of the name where it does not — see electorateAddress.
  const matches = useMemo(() => matchElectorates(electorates, query).filter((e) => electorateAddress(e)), [electorates, query])
  const activeId = active >= 0 && active < matches.length ? `${baseId}-option-${active}` : undefined

  function choose(choice: ElectorateChoice | undefined): void {
    const slug = choice ? electorateAddress(choice) : null
    if (!slug) return
    setOpen(false)
    void navigate({ to: '/electorate/$slug', params: { slug } })
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setOpen(true)
      setActive((current) => moveActiveIndex(open ? current : -1, matches.length, event.key as 'ArrowDown'))
      return
    }
    if (event.key === 'Enter') {
      if (open && active >= 0) {
        event.preventDefault()
        choose(matches[active])
      } else if (matches.length === 1) {
        event.preventDefault()
        choose(matches[0])
      }
      return
    }
    if (event.key === 'Escape') {
      setOpen(false)
      setActive(-1)
    }
  }

  return (
    <div className="relative max-w-xl">
      <label htmlFor={`${baseId}-input`} className="eyebrow mb-1.5 block">
        {label}
      </label>
      <div className="flex items-center gap-2 border border-input bg-paper px-3 py-2 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40">
        <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <input
          id={`${baseId}-input`}
          ref={inputRef}
          data-testid="electorate-search"
          type="text"
          role="combobox"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the page exists to do this one thing
          autoFocus={autoFocus}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={`${baseId}-help`}
          placeholder="Start typing, for example Ōtaki or Mana"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          onBlur={(e) => {
            if (!e.currentTarget.parentElement?.parentElement?.contains(e.relatedTarget as Node)) setOpen(false)
          }}
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-[15px]"
        />
      </div>
      <p id={`${baseId}-help`} className="mt-1.5 text-[12.5px] text-muted-foreground">
        Macrons are optional when typing. {electorates.length > 0 ? `${electorates.length} electorates are loaded.` : 'No electorate list is loaded.'}
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {open ? `${matches.length} electorate${matches.length === 1 ? '' : 's'} match` : ''}
      </p>
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Electorates"
          data-testid="electorate-options"
          className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto border border-rule bg-paper shadow-lg"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-3 text-sm text-muted-foreground" data-testid="electorate-no-match">
              No loaded electorate name matches “{query}”. That does not mean no such electorate exists.
            </li>
          ) : (
            matches.map((e, index) => (
              <li
                key={e.id}
                id={`${baseId}-option-${index}`}
                role="option"
                aria-selected={index === active}
                data-testid="electorate-option"
                onMouseDown={(event) => {
                  event.preventDefault()
                  choose(e)
                }}
                onMouseEnter={() => setActive(index)}
                className={cn('cursor-pointer px-3 py-2 text-[15px]', index === active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted')}
              >
                {e.name}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  )
}
