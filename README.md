# NZ Election Evidence

[![Validate catalogue](https://github.com/thecolab-ai/nz-election-evidence/actions/workflows/validate.yml/badge.svg)](https://github.com/thecolab-ai/nz-election-evidence/actions/workflows/validate.yml)

A community-maintained, nonpartisan map of New Zealand election evidence: what public sources exist, what a dated research snapshot contained, where the gaps are, and how to make claims that readers can trace back to publishers.

This is a practical starting point for **The Colab WhatsApp community** to work together without needing a database, ETL system or specialist software. It is not affiliated with, endorsed by, or an advocacy vehicle for any political party or candidate.

![Abstract map of evidence cards connected to a central source ledger](docs/assets/evidence-network.svg)

## What is here

- **24 dated source-product records**, mapped once each, totalling **351,710 distinct records in the 19 September 2026 snapshot**.
- A separate **52-lane research roadmap**. It is a plan, **not a claim that 52 datasets are complete**.
- Publisher links, observed timestamps, evidence types, counts, limitations and rights-review state.
- A self-contained [interactive evidence atlas](atlas/index.html).
- Dependency-free validation and metadata queries.

No copied PDFs, articles, full policy bodies, donor addresses, database exports, private history, credentials or operational infrastructure details are included. The initial dataset is deliberately **metadata-and-links only** while publisher rights are reviewed.

## Quick start (Python 3 only)

```bash
python3 scripts/validate.py
python3 -m unittest discover -s tests -v
python3 scripts/query.py --domain Elections
python3 scripts/query.py --roadmap-status held_snapshot
python3 -m http.server 8000
# Then open http://localhost:8000/atlas/
```

You can also open `atlas/index.html` directly. No packages, network access, server, database or API key are required.

## Start here

Read [FIRST-STEPS.md](FIRST-STEPS.md) for three bounded contributions that are ready to pick up. Roles include data research, source research, quality assurance, policy analysis and visualisation. See [CONTRIBUTING.md](CONTRIBUTING.md) before making evidence claims.

## Read the snapshot correctly

The count is a dated observation of a prior research snapshot, not a live counter and not proof of universal completeness. Capture timestamps describe when records were observed; they are not automatically the dates the underlying events occurred. Examples of important caveats:

- 17 party-policy records are **17 substantive policy URLs, not 17 manifestos**. The bounded review classified 2 manifestos, 4 collections, 2 platforms and 9 hubs.
- 12 poll records were held; methodology/sponsor disclosure was verified for 9, while 3 remained unresolved.
- 492 candidate-finance document records were held; 224 were image-only. This repository does not redistribute those PDFs.
- Written-question validation was still pending; its count is not a completeness certificate.

Read [methodology](docs/methodology.md), the [data dictionary](docs/data-dictionary.md), [coverage and limitations](docs/coverage-and-limitations.md), [data licensing](DATA-LICENSING.md), and the [sanitisation/publication-readiness report](docs/sanitization-report.md).

## Principles

1. **Primary sources first.** Cite the publisher page and a precise locator.
2. **Facts are not interpretations.** Label observations, classifications and inferences separately.
3. **Correlation is not causation.** A join, timeline or co-occurrence does not establish influence or effect.
4. **Unknown is not zero.** Use `unverified`, `unknown` or `not yet available` when evidence is incomplete.
5. **Minimise personal data.** No person profiling, donor addresses or unnecessary contact details.
6. **No party advocacy.** Apply the same methods and evidence standards across parties.

## Repository map

- `catalogue/sources.{json,csv}` — the 24-product dated catalogue
- `catalogue/roadmap.{json,csv}` — the separate 52-lane research roadmap
- `catalogue/rights-register.{json,csv}` — per-publisher review queue
- `catalogue/schema.json` — machine-readable catalogue contract
- `atlas/index.html` — self-contained static explorer
- `docs/` — methods, provenance, collaboration and project ideas
- `scripts/` and `tests/` — portable offline tooling

## Licence and citation

Original repository-authored code and documentation are MIT licensed. Third-party source material and data are **not** relicensed; see [DATA-LICENSING.md](DATA-LICENSING.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Suggested citation: *The Colab contributors, NZ Election Evidence, source-catalogue snapshot 2026-09-19, repository version/commit consulted.* Cite the underlying publisher too.
