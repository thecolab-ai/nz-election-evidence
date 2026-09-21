# Sanitisation and publication-readiness report

Status: **public catalogue preview; independent and legal review pending**

Reviewed scope: current repository tree
Evidence snapshot represented: 2026-09-19T19:12:17.178902Z

## Included

- 24 metadata-only source-product records with public IDs, publisher URLs, record counts, evidence forms, observed timestamps, stated coverage and limitations
- 52 separately labelled roadmap lanes; every held product maps to exactly one lane
- 19 source-specific rights-review rows, all `pending` and `link-only`
- New repository-authored documentation, portable Python tooling, tests, issue templates, static atlas and SVG artwork

The SVG's generation provenance is not recorded. That gap does not establish whether a model was used. If a model was used, the model/version, prompt or schema, confidence treatment and human-review state must be recorded before the artwork can be described as R9-compliant.

## Excluded by design

- credentials, contact lists and person profiles
- personal street-address fields
- copied PDFs, article bodies, page captures and full policy text
- internal storage locations, private host details, infrastructure configuration and operational source identifiers
- private repository names, links, history or working-path notes
- production exports and database dependencies

## Automated checks

The dependency-free validator and test suite check:

- exactly 26 unique public product IDs and a total of 353,336 records
- evidence-form subtotals equal each product count
- JSON/CSV catalogue parity
- exactly 52 unique roadmap lanes
- all 24 held products map once, with no omissions or duplicates
- all rights rows remain pending/link-only
- text scan for common credential signatures, local home paths, private network addresses, backend terms and personal-address phrasing outside policy documents

Run:

```bash
python3 scripts/validate.py
python3 -m unittest discover -s tests -v
```

The self-contained atlas was also browser-checked for all 24 product cards, all 52 roadmap cards and working search/filter behaviour.

## Independent review of the current public preview

1. Inspect the complete Git tree and commit diff.
2. Re-run both offline commands above.
3. Review every source and the rights register; leave link-only defaults in place unless written permission or publisher terms have been recorded.
4. Confirm the snapshot wording is still prominent and that no text implies live data or universal completeness.
5. Do not treat this technical report, CI, or the pending review-register rows as completing R10 legal review.

This report is not a legal opinion and does not itself grant redistribution rights.
