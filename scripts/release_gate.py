#!/usr/bin/env python3
"""R10 release gate for deployable surfaces. Exit 0 only when the named surface has an approved row
in REVIEW-REGISTER.md with a named reviewer. A PENDING row, a missing row, or an unnamed reviewer all
fail closed. CI calls this before any Pages deployment; passing CI never substitutes for the review.

Usage:
  python3 scripts/release_gate.py --surface "Evidence explorer"
"""
from __future__ import annotations
import argparse, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UNNAMED = {"", "not appointed", "tbc", "tbd", "pending", "unknown", "n/a"}


def register_rows(text: str) -> list[dict[str, str]]:
    rows = []
    for line in text.splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) != 6 or cells[0].lower() == "date" or all(re.fullmatch(r":?-{3,}:?", c) for c in cells):
            continue
        rows.append(dict(zip(("date", "surface", "reviewed_by", "red_lines", "outcome", "notes"), cells)))
    return rows


def gate(text: str, surface: str) -> tuple[bool, str]:
    matches = [r for r in register_rows(text) if surface.lower() in r["surface"].lower()]
    if not matches:
        return False, f"no REVIEW-REGISTER.md row for surface '{surface}'"
    latest = matches[-1]
    outcome = re.sub(r"[*_`]", "", latest["outcome"]).strip().upper()
    reviewer = re.sub(r"[*_`]", "", latest["reviewed_by"]).strip().lower()
    if not outcome.startswith("APPROVED"):
        return False, f"latest row for '{surface}' is not approved: {latest['outcome']}"
    if reviewer in UNNAMED:
        return False, f"latest row for '{surface}' names no reviewer"
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", latest["date"]):
        return False, f"latest row for '{surface}' has no ISO date"
    return True, f"approved on {latest['date']} by {latest['reviewed_by']}"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--surface", required=True)
    args = parser.parse_args(argv)
    ok, reason = gate((ROOT / "REVIEW-REGISTER.md").read_text(encoding="utf-8"), args.surface)
    print(("RELEASE GATE OPEN: " if ok else "RELEASE GATE CLOSED: ") + reason, file=sys.stdout if ok else sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
