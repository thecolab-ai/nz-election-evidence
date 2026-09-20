# What lives where

The repository is the authoritative record. It stays small, text-only and human-reviewed. Everything bulky, fetched or regenerable lives outside it. `scripts/validate.py` enforces the size and file-type rules in CI.

## The rule

| Kind of thing | Lives in | Why |
|---|---|---|
| Claim files, evidence rows, registers, schemas, policy docs | **This repository** | Human-authored, reviewed by PR, content-addressed by commit hash, publicly cloneable. A claim file is 1–2 KB; thirty policies of ten claims is well under 1 MB. |
| Fetched source pages, PDFs, Hansard transcripts, publisher exports | **Not in the repository** | R6 forbids storing bodies; they are 100 KB–5 MB each and would dominate history. Link to the publisher and record a locator, hash and retrieval date instead. |
| Bulk datasets (written questions, election results, statistics series) | **Evidence store (Supabase) or the publisher** | Machine-fetched and regenerable. The repository holds the catalogue row and the rights status, not the rows. |
| Rendered pages, screenshots, build output, dependencies | **Generated on demand** | Rebuilt from the record; committing them creates noise and drift. |
| Diagrams and illustrations the docs need | `docs/assets/` | Text formats only (SVG). Larger allowance, still capped. |

## Limits enforced in CI

- No file over **100 KB** anywhere, except `docs/assets/` which allows **500 KB**.
- No binary or document formats at all: PDF, Office files, archives, raster images, audio, video, databases, pickles, compiled artefacts. The list is in `scripts/validate.py`.
- If a change genuinely needs more, open an issue first. The answer is almost always "store it elsewhere and link", not "raise the limit".

## Why not Git LFS

LFS would let binaries in without bloating history, but the project has no legitimate binary to store: publisher documents are linked, not copied (R6), and everything else is text. Refusing binaries outright is simpler than managing LFS for contributors who otherwise need nothing but Python 3.

## Authoritative versus derived

- **Repository:** authoritative. A published claim is a file at a commit hash.
- **Evidence store:** derived. It indexes claims by `path`, `commit_sha`, `blob_sha`, `sha256`, `published_at` and `tag`, serves the site, and is never edited by hand. Anything in the store that cannot be traced to a commit hash is not published.
- **External anchor:** see the tamper-evidence proposal (issue #10) for signed tags and timestamps.

This is project process documentation, not legal advice.
