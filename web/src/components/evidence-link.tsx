import { Link } from '@tanstack/react-router'
import { useOneQuery } from '@/lib/queries'

/** Resolves an evidence version id to its record, so the primary source is one click away. */
export function EvidenceVersionLink({ versionId, label = 'Evidence record' }: { versionId: string | null | undefined; label?: string }) {
  const version = useOneQuery<{ id: string; record_id: string }>({ view: 'record_versions', select: 'id,record_id', column: 'id', value: versionId ?? '', enabled: !!versionId })
  if (!versionId) return <span className="text-muted-foreground">no evidence version recorded</span>
  if (version.isPending) return <span className="text-muted-foreground" role="status">Looking up evidence…</span>
  if (version.isError || !version.data) return <span className="text-muted-foreground">evidence version {versionId.slice(0, 8)}… could not be resolved</span>
  return (
    <Link to="/records/$recordId" params={{ recordId: version.data.record_id }} className="doc-link" data-testid="evidence-link">
      {label}
    </Link>
  )
}
