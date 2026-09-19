# First steps: three useful starter tasks

Each task is intentionally small enough for a first contribution. Comment on or open an issue before expanding scope.

## 1. Verify five primary source links (source research)

Pick five rows from `catalogue/sources.csv`. Confirm the publisher, page title, final public URL and whether the page states a licence or terms. Record the check date and archived redirect notes in a pull request. **Do not download or commit page bodies.** Success: five links checked, rights claims supported by exact terms URLs, unknowns left pending.

## 2. Improve one coverage limitation (data research + QA)

Pick one `Pxx` product. Find an official index or documentation page that clarifies its denominator, time window, geography or update cadence. Add a cited note; do not change a count without evidence from the same dated snapshot. Success: a reviewer can reproduce your reasoning from public URLs and distinguish snapshot facts from interpretation.

## 3. Prototype one honest visual (analysis + visualisation)

Use only catalogue metadata (counts, evidence forms, rights state or roadmap status) to make an accessible chart. Label it **snapshot metadata**, include alt text and disclose that record counts across unlike evidence forms are not directly comparable. Success: source code is included, no personal data appears, and `python3 scripts/validate.py` still passes.
