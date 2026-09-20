# Red lines

**Status: binding.** Every contributor, script, agent and model run in this repository must comply. A change that crosses a red line is not merged, regardless of who wrote it or how useful it is. `scripts/red_lines.py` enforces the machine-checkable parts in CI; the rest is enforced by the pull-request checklist and a human reviewer.

This document is not legal advice. It is the project's own operating boundary, drawn conservatively inside New Zealand law so that nothing we publish depends on a close legal call. Named laws are listed so reviewers know *why* a line exists; the line itself is the rule.

Version: 1.0 · Adopted: 2026-09-20 · Election day: Saturday 7 November 2026 · Regulated period: 7 August – 6 November 2026

## The ten red lines

### R1 — No vote recommendation, no advocacy
Nothing published from this repository may encourage or persuade anyone to vote, or not vote, for a party, candidate, list, or referendum option. This includes implication by framing, ranking, scoring, colour, emoji, or tone. Results are never aggregated or ranked by party or by person in a way that reads as a scoreboard.

*Why:* Electoral Act 1993 election-advertising rules; the project's own brief ("it won't recommend a vote").

### R2 — No promoter statement needed, ever
We do not produce election advertisements. If a reviewer believes an output could be read as one, it is rewritten until it cannot, not published with a promoter statement. Any money spent on publishing or promoting outputs during the regulated period is recorded in `SPEND-REGISTER.md` before it is spent. Cumulative spend must stay well under the unregistered third-party limit ($17,000 incl. GST for 2026). Registration as a third-party promoter is not a path this project takes.

*Why:* Electoral Act 1993 ss 3A, 204B–204H; Electoral Commission guidance for third-party promoters.

### R3 — Election-day freeze
From 00:00 NZDT on election day until polls close at 19:00, nothing new is published, pushed to a public surface, posted, or promoted. Published surfaces are frozen read-only. CI blocks merges to `main` on election day. The same freeze applies to any advance-voting-period content the Electoral Commission designates.

*Why:* Electoral Act 1993 s 197.

### R4 — No allegation of dishonesty or motive
We describe the delta between a statement and the evidence. We never say or imply that a named person or party lied, is lying, is a liar, is dishonest, corrupt, fraudulent, or deliberately misled anyone. We do not speculate about motive. "The statement said X; the primary source shows Y; the difference is Z" is the whole finding. Every published claim uses the claim / class / source / locator / as-of / method / uncertainty template from `CONTRIBUTING.md`.

*Why:* Defamation Act 1992 (truth and honest-opinion defences require exactly this discipline).

### R5 — Corrections within the hour
A confirmed factual error is corrected, flagged on the affected surface, and logged in `CORRECTIONS.md` within one hour of confirmation. `CORRECTIONS.md` is append-only: entries are never deleted or edited after the fact, only superseded by a later entry. The corrections log is linked from every published surface.

*Why:* Defamation Act 1992 mitigation; the project's own brief ("open and fast about being wrong").

### R6 — Link and quote, never republish
Third-party text is quoted only to the extent needed to identify the claim, with a link to the primary source. No full article bodies, no scraped news text, no source PDFs stored in the repository or served from any surface. Hansard, written questions, and other Parliament material are used under their CC BY 4.0 licence with attribution. A source whose terms prohibit automated access is not ingested; the rights register records the decision.

*Why:* Copyright Act 1994; publisher terms of use; `DATA-LICENSING.md`.

### R7 — No personal data of members of the public
Only elected members, candidates, parties, and office-holders acting in their public capacity appear by name. No person profiles, no contact details, no inferred traits, no raw comments from the public. Public submissions and comments are distilled into aggregate meaning before anything is published; the raw text is retained only as long as the distillation needs it, then deleted. The repository never contains a member of the public's name attached to an opinion.

*Why:* Privacy Act 2020; Harmful Digital Communications Act 2015; the project's own brief ("won't publish people's comments raw").

### R8 — Named accountability on every surface
Every published surface shows: the responsible entity, a named accountable person, a plain-language disclaimer that this is an independent project not affiliated with Parliament, the Electoral Commission, or any party, and a link to `RED-LINES.md` and `CORRECTIONS.md`. Nothing goes live under an anonymous or unincorporated banner.

*Why:* Personal-liability exposure of unincorporated groups; trust design in the brief.

### R9 — Model outputs are labelled, versioned, and never the last word
Any classification, probability, or summary produced by a model (Jev, an LLM, or otherwise) is published with the model name and version, the schema or prompt used, the confidence value, and a visible "not yet checked against human review" flag until a documented human-agreement rate exists for that schema. A model reading is never presented as a fact about a person. The primary source is always one click away.

*Why:* R4 and R1 depend on it; the brief's "show the fact-checking process".

### R10 — New surface, new review
No new public-facing surface, feed, bot, or data product goes live until a legal-review entry exists in `REVIEW-REGISTER.md` naming who reviewed it, when, and against which red lines. A change to R1–R9 requires the same.

*Why:* Advisory from the group (Yogi, 2026-09-20): take legal advice before progressing.

## Enforcement

| Line | Mechanism |
|------|-----------|
| R1, R4 | `scripts/red_lines.py` scans published-content paths for advocacy and dishonesty phrasing; CI fails on a hit. Reviewer confirms tone. |
| R2 | `SPEND-REGISTER.md` running total checked by `scripts/red_lines.py`; fails above the alert threshold. |
| R3 | `scripts/red_lines.py --freeze-check` fails on election day (NZ time) unless `RED_LINES_FREEZE_OVERRIDE` is set by a named owner with a logged reason. |
| R5 | `CORRECTIONS.md` must exist and be append-only (CI compares to previous commit). |
| R6, R7 | Existing publication-boundary scanner in `scripts/validate.py`; reviewer checks rights register. |
| R8, R9, R10 | Pull-request checklist; a reviewer other than the author must tick them. |

Allowed exceptions: none. If a red line blocks something genuinely valuable, open an issue to change the red line under R10; do not route around it.

## Words that trip the scanner

Applied to a named person, party, or office-holder these fail CI in published-content paths: *lied, lie, lies, lying, liar, dishonest, corrupt, corruption, fraud, fraudulent, deceived, deceit, deliberately misled, cover-up, vote for, vote against, don't vote, do not vote, party vote, back [party], support [party], oppose [party], kick out, get rid of, re-elect*. The scanner is a floor, not a ceiling: passing it does not mean the text complies.
