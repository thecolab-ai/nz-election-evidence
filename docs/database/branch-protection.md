# Branch protection: recommended settings

**Nothing here has been applied.** This work does not modify the repository's remote settings. These are recommendations for the repository owner, written so that two different things stay separate:

- **Merging private development into `main`** should need *build and test* checks and an owner review. It should **not** need a release approval: merging code publishes nothing (the Pages deploy job and the database gates are separate, below).
- **Deploying or releasing** needs the R10 review, the owner switch and the database gates. None of those should be a merge requirement, or development would stall on a legal review that code cannot complete.

## 1. Required status checks for `main` (build and test only)

Require these to pass before merging, with "require branches to be up to date":

| Check (job name) | Workflow | What it proves |
|---|---|---|
| `Existing compliance checks` | `explorer.yml` | Catalogue validation, red lines, election-day freeze, compliance unit tests |
| `TypeScript tooling - ingestion, release gate, receipts (typecheck and unit tests)` | `explorer.yml` | Adapters, fetch guard, export contract, release-gate logic, workflow invariants, Deno check |
| `Migrations and role tests on a disposable database` | `explorer.yml` | All migrations from scratch, pgTAP (rights lineage, field-aware release, adversarial input, role allow/deny), generated-type drift, ingestion integration tests under the scoped login with skips forbidden |
| `Explorer typecheck, unit tests and Pages build` | `explorer.yml` | Type contract against generated types, unit tests, build and bundle safety |
| `Explorer browser tests - anonymous browsing, private and write denial, release gate, Pages routing` | `explorer.yml` | Anonymous boundary, mixed-rights fixtures, every public dataset walked for withheld content, Pages routing |
| `offline-validation` | `validate.yml` | The original catalogue validation |
| `red-lines` | `red-lines.yml` | The original red-line enforcement |

**Do not** add `R10 release gate and election-day freeze` or `Deploy explorer shell to GitHub Pages` to the required checks. They run only on `main`, the gate is *expected* to be closed until a review is recorded, and requiring them would block every merge.

## 2. Reviews

- Require a pull request with at least one approving review, and **require review from Code Owners**. `CODEOWNERS` covers the red lines, the review and rights registers, migrations, functions, release tools, operator scripts, workflows, the application, generated database types, package manifests and lockfiles.
- Dismiss stale approvals when new commits are pushed. Do not allow bypassing these settings, including for administrators, during the regulated period.
- Restrict who can push to `main`; disallow force pushes and deletions.

## 3. Deploy and release controls (separate from merging)

| Control | Where | Opened by |
|---|---|---|
| Pages deploy job | `explorer.yml`, `deploy` needs every check job **and** `release-gate` | An approved `REVIEW-REGISTER.md` row for surface id `explorer-pages` naming a reviewer (exact outcome `APPROVED`), plus repository variable `PAGES_DEPLOY_ENABLED=true` |
| `github-pages` environment | Repository settings | Recommended: required reviewers on the environment, and deployment branches limited to `main` |
| Public evidence rows | Database, `release_gates` | `scripts/db/set_release_gate.sql` for R8 and R10, each with an evidence reference and a named person |
| Content fields of a source | Database, `source_rights` | A recorded publisher approval with release mode approved-fields and named fields, synced by an administrator |
| Election-day freeze | `red_lines.py --freeze-check` in CI, and the owner | A previously green check is not a durable lock; on election day the owner must block merges and deployments by hand |

## 4. Secrets and variables

The workflow uses no secrets. `EXPLORER_SUPABASE_URL` and `EXPLORER_SUPABASE_ANON_KEY` are repository **variables** (public values). A service-role key, a database password or the cron secret must never be added to this repository's Actions settings; the build refuses a privileged key and the bundle check fails on key material.
