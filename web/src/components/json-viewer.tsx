import { ChevronRight } from 'lucide-react'
import { useId, useState } from 'react'
import type { Json } from '@/lib/types'

/**
 * Collapsible viewer for a version's `safe_payload`. The payload has already passed the
 * server-side allowlist; this renders it as text only (never as HTML).
 */
export function JsonViewer({ value, label = 'Stored fields (safe payload)', defaultOpen = false }: { value: Json; label?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()
  const keyCount = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : null
  return (
    <div className="border border-border bg-paper" data-testid="json-viewer">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-muted"
      >
        <ChevronRight aria-hidden="true" className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>{label}</span>
        {keyCount !== null ? <span className="num text-xs font-normal text-muted-foreground">{keyCount} field{keyCount === 1 ? '' : 's'}</span> : null}
      </button>
      {open ? (
        <pre id={panelId} tabIndex={0} data-testid="json-viewer-content" className="max-h-96 overflow-auto border-t border-border px-3 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}
