# Publication policy for the evidence store

This is project process documentation, not legal advice. It restates how the binding [red lines](../../RED-LINES.md) apply to the store and explorer.

## Current state: nothing is published

- The published schema `evidence_api` is **not exposed** by the REST API and browser roles hold no privilege on it.
- All three release gates (`r10_public_surface_review`, `r8_accountable_legal_entity`, `election_day_freeze_clear`) are **closed**. A gate cannot be opened without an evidence reference, a named person and a date.
- All 19 rights rows are **pending**. The release function refuses pending rights even when every gate is open.
- The explorer deployment is blocked by `scripts/release_gate.py` until `REVIEW-REGISTER.md` carries an approved row naming a reviewer, and by the repository variable `PAGES_DEPLOY_ENABLED`. Passing CI is not approval.

## What opening publication would require

1. R8: responsible legal entity and accountable person recorded.
2. R10: an approved `REVIEW-REGISTER.md` row for each new surface (explorer; evidence store and any API), naming the reviewer and the red lines checked.
3. Per-publisher rights decisions recorded in the rights register (and mirrored), with field scope.
4. A **new, reviewed migration** that exposes `evidence_api` and grants `SELECT` to browser roles. It deliberately does not exist yet and must not be written before steps 1–3.
5. Release through `publish_batch()` only: allowlisted columns, current versions, referential closure (a document's source must be published), and a withdrawal path that removes published rows while keeping the batch record.

## Standing rules

- **Summaries are not cleared by existing.** A model summary is private and `unreviewed` until a human review of that exact output hash is recorded; text is immutable and a regenerated summary is a new row. Model name, version and prompt version are required, or explicitly `historical_unknown` (R9). A URL plus a generated summary is not the same thing as link-only metadata.
- **No donor contacts, no full documents, no archive locations.** Finance rows hold return status and the official URL; the table has no donor, address or contact columns. Document rows hold the publisher URL, never a stored copy (R6, R7).
- **No scoreboards.** Results and polls are stored in source order with explicit value status; no ranking, score or party aggregate is derived (R1).
- **No allegation wording.** Findings describe the difference between a statement and a source (R4).
- **Corrections** supersede and are logged in `CORRECTIONS.md` within the hour (R5); the store's `corrections` rows point at the log entry.
- **Election-day freeze** (R3): the deploy workflow runs the freeze check; schedules should be deactivated for the freeze window with `scripts/db/activate_schedule.sql -v deactivate=1`, and no release function is run.
- The inspector role is for reviewers. It is read-only by grant and by view structure, and granting it is an administrator decision recorded with a reason.
