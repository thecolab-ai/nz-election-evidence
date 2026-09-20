# Publication policy for the evidence store

This is project process documentation, not legal advice. It restates how the binding [red lines](../../RED-LINES.md) apply to the store and explorer.

## Owner authorization of 2026-09-20 (read before the rest)

The repository owner has decided to publish a first connected release ahead of the reviews described below. That decision is recorded in [`governance/owner-authorizations.json`](../../governance/owner-authorizations.json) and explained in [connected-release.md](connected-release.md). It is the owner's decision and a stated **departure from R8 and R10 as written**. It is **not** a review, **not** an accountable-person acceptance and **not** a publisher's approval: the review register stays PENDING, both database gates stay closed, every rights row stays pending and link-only, and the site says so on every page. Everything under "What opening publication requires" is still required and still outstanding. As of this revision nothing has been deployed or applied to a hosted project.

## Current state: nothing is published

- No migration has been applied to a hosted project and the explorer is not deployed.
- The store is designed for **public read-only transparency within source rights**: default deny, provable source lineage for every projected object, and a release tier per source ([architecture](architecture.md#default-deny-source-lineage-and-release-tiers)). Transparency does not waive a publisher's rights.
- Inside the database, anonymous readers receive evidence rows only while the `r10_public_surface_review` and `r8_accountable_legal_entity` gates are both open. Both are **closed** by default. The dataset catalogue and column list are always readable.
- All 21 rights rows are **pending**, so every real source is `link_only`: the public would see identifiers, official links, dates, hashes and statuses, and **no** names, titles, labels, figures, payloads or publisher identifiers. A source with no rights row, or a `refused`, `restricted` or `withheld` one, shows nothing at all, including everything descended from it.
- The explorer deployment is blocked by `tools/release_gate.ts` until `REVIEW-REGISTER.md` carries an approved row naming a reviewer, or, while that row is PENDING, a current owner decision with the `pages_deploy` scope exists (reported as an owner override, never as a review); and by the repository variable `PAGES_DEPLOY_ENABLED`. Passing CI is not approval.
- Under a current owner decision, anonymous readers receive rows with the gates still closed, and see content only in the fields that decision names for that one source. `surface_status.release_basis` says which basis applies. A source whose rights row is refused, restricted or withheld shows nothing regardless.

## What opening publication requires

1. R8: responsible legal entity and accountable person recorded.
2. R10: an approved `REVIEW-REGISTER.md` row for each new surface (explorer; evidence store), naming the reviewer and the red lines checked.
3. Per publisher, a recorded rights review. Content appears only when the register row is `approved` with release mode `approved-fields` **and** names each field in `approved_fields`; an administrator syncs that row (the worker cannot). Release review should also confirm the link-metadata list in `classify_public_columns()` and the withheld register.
4. Apply migrations, then open the two gates with `scripts/db/set_release_gate.sql`, each with its evidence reference and a named person.
5. Set `PAGES_DEPLOY_ENABLED` for the Pages shell.

Closing either gate with the same script withholds every row from anonymous readers immediately, without a deployment.

## Standing rules

- **Summaries are not cleared by existing.** A model summary is private and `unreviewed` until a human review of that exact output hash is recorded; text is immutable and a regenerated summary is a new row. Model name, version and prompt version are required, or explicitly `historical_unknown` (R9). A URL plus a generated summary is not the same thing as link-only metadata.
- **No donor contacts, no full documents, no archive locations.** Finance rows hold return status and the official URL; the table has no donor, address or contact columns. Document rows hold the publisher URL, never a stored copy (R6, R7).
- **No scoreboards.** Results and polls are stored in source order with explicit value status; no ranking, score or party aggregate is derived (R1).
- **No allegation wording.** Findings describe the difference between a statement and a source (R4).
- **Corrections** supersede and are logged in `CORRECTIONS.md` within the hour (R5); the store's `corrections` rows point at the log entry.
- **Election-day freeze** (R3): the deploy workflow runs the freeze check; schedules should be deactivated for the freeze window with `scripts/db/activate_schedule.sql -v deactivate=1`, and no release function is run.
- The inspector layer is for reviewers who need the withheld columns. It is read-only by grant and by view structure, and granting it is an administrator decision recorded with a reason.
- Adding a table or column: mark anything sensitive in `public_withheld` with its reason in the same migration, then call `rebuild_exposed_views()`. CI fails on drift.
