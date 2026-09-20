# Review register (R10)

A surface, feed, bot, or data product does not go live until a row exists here **and its review outcome is approved**. A `PENDING` row records an open gate; it is not approval. Technical edits, automated checks, maintainer review, or this register entry cannot substitute for the independent legal review required by R10. This register is project process documentation, not legal advice.

| Date | Surface | Reviewed by | Red lines checked | Outcome | Notes |
|---|---|---|---|---|---|
| 2026-09-20 | Repository README and source catalogue (existing public surface) | Not appointed | R1–R10 pending | **PENDING — NOT REVIEWED** | Independent legal review is outstanding. R8 responsible legal entity/formal accountable legal role is unresolved. This row does not approve publication. |
| 2026-09-20 | Evidence atlas (existing public surface) | Not appointed | R1–R10 pending | **PENDING — NOT REVIEWED** | Independent legal review is outstanding. Accountability and disclaimer text added for transparency; technical changes do not satisfy R10. This row does not approve publication. |
| 2026-09-20 | Evidence explorer (GitHub Pages inspector shell; new surface) | Not appointed | R1–R10 pending | **PENDING — NOT REVIEWED** | Static shell with no evidence data in the bundle; data is returned only to signed-in users holding a server-side inspector membership. Deployment is blocked by `scripts/release_gate.py` until this row is superseded by an approved row naming a reviewer. This row does not approve publication. |
| 2026-09-20 | Supabase evidence store and scheduled ingestion (private; new data product) | Not appointed | R1–R10 pending | **PENDING — NOT REVIEWED** | Private schema, inspector-only views, closed published schema. Remote migrations, function deployment and schedule activation await coordinator release review. All publisher rights rows remain pending. This row does not approve publication. |
