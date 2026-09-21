# Methodology

## Scope

This release describes a frozen evidence inventory observed on **2026-09-19 at 19:12:17 UTC**. It does not perform new collection and should not be read as live. The 24-product catalogue represents every non-zero product in that snapshot exactly once. The 52-lane roadmap is broader and contains partial, discovery, blocked and unavailable work.

## Evidence classes

- **Publisher statement:** what a source says about itself or an event.
- **Observed fact:** a directly recorded value with source and locator.
- **Derived classification:** a reproducible label applied by the project.
- **Analyst interpretation:** a reasoned reading that may be contested.

Document/body records, normalised facts, aggregates, catalogue entries and catalogue metadata are not interchangeable. Counts show inventory scale, not importance, quality or completeness.

The party-policy type breakdown retained in this snapshot is a **preliminary model-assisted classification**. Its model name/version is unknown, schema/prompt is unavailable, confidence is unavailable, and it has not yet been checked against human review. It must not be treated as a verified finding. Future model-derived fields must carry the R9 metadata and item-level primary-source mapping before publication; unknown metadata must remain explicit rather than being reconstructed or guessed.

## Analysis rules

Define the denominator before counting. Preserve source dates separately from observation dates. Align units, geography, boundary editions, period and vintage. Record revisions. Treat joins as hypotheses until identifiers are reviewed. Before/after, proximity and co-occurrence are not causal designs. Report unknowns rather than converting them to zero.

## Snapshot checks

The validator enforces 26 unique products, 353,336 total records, evidence-form sums, JSON/CSV parity, 52 unique roadmap lanes, and exactly one roadmap mapping for each held product. These are integrity checks for this artefact, not certification of source-world completeness.
