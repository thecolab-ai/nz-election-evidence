# Data dictionary

## Source catalogue

- `product_id`: stable public ID allocated by this repository; not a private storage identifier.
- `title`, `publisher`, `domain`: human-readable description and grouping.
- `source_url`: HTTPS publisher landing page or clearly labelled secondary index.
- `snapshot_at_utc`: frozen inventory timestamp shared by all 24 rows.
- `record_count`: distinct records observed in the dated snapshot.
- `evidence_forms`: typed counts whose sum equals `record_count`.
- `observed_start_utc`, `observed_end_utc`: earliest/latest capture observations in the snapshot, **not automatically event coverage**.
- `coverage_window`: bounded subject/reference window when known; otherwise an explicit limitation.
- `release_mode`: what this repository publishes (`metadata-and-links-only`).
- `rights_status`: source-specific rights review state.
- `known_limitations`: gaps and interpretation constraints.

In the rights register, `verified_permissions` is an explicit decision-state field. Pending rows use `Not verified; release restricted to catalogue metadata and source links pending rights review`; they do not assert permission.

## Roadmap

- `lane_id`: public roadmap ID.
- `status`: `held_snapshot`, `held_partial`, `held_validation_pending`, `roadmap_partial`, `roadmap_discovery`, `not_yet_available`, or `blocked_unverified`.
- `held_product_ids`: zero or more links to the 24-product catalogue.
- `next_verification`: bounded evidence needed next.

Missing text is empty only where the schema allows it. Unknown evidence should be written explicitly as `unknown` or `unverified`, never encoded as zero.
