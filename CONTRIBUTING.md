# Contributing

We welcome people doing data research, source research, QA, policy analysis, writing and visualisation. This is nonpartisan public-interest infrastructure: contributions must not campaign for or against a party, candidate or person.

## Evidence standard

Every substantive claim in a pull request or analysis must use this template:

```markdown
**Claim:** one precise statement
**Class:** publisher statement | observed fact | derived classification | analyst interpretation
**Primary source:** full URL
**Locator:** table/row/page/section/paragraph or query description
**As-of date:** YYYY-MM-DD
**Method:** what was counted, transformed or compared
**Uncertainty:** known gaps; write `unverified` when unsure
**Causality:** why this does or does not support a causal claim
```

- Separate fact from interpretation in both prose and charts.
- Never imply causation from correlation, timing or a join.
- A missing record is not proof an event did not occur.
- Prefer primary publishers; explain any secondary-source use.
- Do not silently update a dated count with a live value.
- Preserve units, denominators, geography, period, vintage and revisions.

## Privacy and political-finance guardrails

Do not add person profiles, donor addresses, personal contact details, inferred sensitive traits, or bulk personal information. Do not republish original finance PDFs. Name-level public-interest work requires a separate necessity, accuracy and harm review; this starter repository is not that venue.

## Keep the record small

The repository holds human-authored text only: claim files, evidence rows, registers, schemas and docs. No file over 100 KB (500 KB under `docs/assets/`), and no binary or document formats at all. Fetched bodies, exports and bulk datasets live outside the repository and are linked. See [docs/what-lives-where.md](docs/what-lives-where.md); CI enforces it.

## Pull request checklist

- [ ] Claim template completed for changed evidence claims
- [ ] Primary links and locators included
- [ ] Facts, classifications and interpretations are labelled
- [ ] Unknown/unverified states remain explicit
- [ ] No causal language unsupported by a causal design
- [ ] No copied source bodies, unapproved data or unnecessary personal data
- [ ] No file over 100 KB and no binary or document files (see docs/what-lives-where.md)
- [ ] Rights register updated if permissions are asserted
- [ ] `python3 scripts/validate.py` and unit tests pass
- [ ] Visuals have alt text and do not compare unlike counts without explanation

By contributing original code or documentation, you agree it is provided under the MIT licence. Do not contribute third-party material unless redistribution permission is documented.
