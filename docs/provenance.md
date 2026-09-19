# Provenance specification

Every future released fact should carry:

| Field | Meaning |
|---|---|
| `publisher` | Organisation responsible for the primary source |
| `source_url` | Exact publisher URL, not a private storage location |
| `source_title` | Title as published |
| `published_at` | Publisher date, if stated |
| `observed_at` | When the project observed it |
| `source_locator` | Page, table, row, cell, paragraph or character span |
| `evidence_class` | Publisher statement, observed fact, classification or interpretation |
| `unit` / `denominator` | What a number measures and divides by |
| `geography` / `period` / `vintage` | Spatial and temporal meaning |
| `transformation` | Reproducible derivation and version |
| `quality_state` | Verified, provisional, unverified or known gap |
| `rights_state` | Permission basis and review date |

If privately retained source bytes are used, a checksum may identify them without publishing the bytes. Never publish private paths or storage IDs. A citation must let a reader return to the publisher and understand exactly what supports the claim.

See `examples/provenance-example.json` for a synthetic, non-claim example.
