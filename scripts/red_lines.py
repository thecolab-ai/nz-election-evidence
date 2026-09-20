#!/usr/bin/env python3
"""Red-line enforcement. See RED-LINES.md. Exit 1 on any breach.

Usage:
  python3 scripts/red_lines.py            # scan content + spend + corrections
  python3 scripts/red_lines.py --freeze-check   # also fail on election day (NZ time)
"""
from __future__ import annotations
import datetime as dt, os, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ELECTION_DAY = dt.date(2026, 11, 7)
REGULATED_PERIOD_START = dt.date(2026, 8, 7)
REGULATED_PERIOD_END = dt.date(2026, 11, 6)
NZ_UTC_OFFSET_HOURS = 13  # NZDT applies on election day
UNREGISTERED_LIMIT_NZD = 17_000
SPEND_ALERT_NZD = 10_000  # fail well before the legal limit
SCAN_DIRS = ("atlas", "docs", "examples", "published", "site", "outputs")
SCAN_SUFFIXES = {".md", ".json", ".csv", ".html", ".txt", ".yml", ".yaml", ".svg"}
EXEMPT = {"RED-LINES.md", "CONTRIBUTING.md", "CORRECTIONS.md", "scripts/red_lines.py", "tests/test_red_lines.py"}

R4_DISHONESTY = re.compile(
    r"(?i)\b(lied|lie|lies|lying|liar|dishonest(?:y|ly)?|corrupt(?:ion|ly)?|fraud(?:ulent)?|"
    r"deceived|deceit(?:ful)?|deliberately misl(?:ed|eading)|cover[- ]?up)\b"
)
R1_ADVOCACY = re.compile(
    r"(?i)\b(vote (?:for|against)|do(?:n'?t| not) vote|party vote for|back (?:the )?(?:party|govt|government)|"
    r"support (?:the )?(?:party|government)|oppose (?:the )?(?:party|government)|kick (?:them|him|her) out|"
    r"get rid of (?:the )?(?:party|government|minister)|re-?elect)\b"
)
SOURCE_LINK = re.compile(r"https?://|\[[^\]]+\]\(https?://[^)]+\)", re.I)
SPEND_AMOUNT = re.compile(r"(?:NZD\s*|\$\s*)?(\d+(?:[ ,]\d{3})*(?:\.\d{1,2})?)", re.I)
errors: list[str] = []
def fail(msg: str) -> None: errors.append(msg)

def scan_content() -> None:
    for d in SCAN_DIRS:
        base = ROOT / d
        if not base.exists(): continue
        for path in base.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in SCAN_SUFFIXES: continue
            rel = str(path.relative_to(ROOT))
            if rel in EXEMPT: continue
            text = path.read_text(encoding="utf-8", errors="replace")
            for n, line in enumerate(text.splitlines(), 1):
                # Attributed source quotations may contain the words being analysed.
                # An unlinked blockquote is ordinary published content and is scanned.
                if line.lstrip().startswith(">") and SOURCE_LINK.search(line): continue
                if R4_DISHONESTY.search(line): fail(f"R4 dishonesty/motive wording in {rel}:{n}")
                if R1_ADVOCACY.search(line): fail(f"R1 advocacy wording in {rel}:{n}")

def check_spend() -> None:
    p = ROOT / "SPEND-REGISTER.md"
    if not p.exists(): fail("R2 SPEND-REGISTER.md missing"); return
    total = 0.0
    for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells and cells[0].lower() == "date":
            continue
        if cells and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
            continue
        if len(cells) != 5 or not all(cells):
            fail(f"R2 malformed spend row at SPEND-REGISTER.md:{n}; expected five non-empty columns")
            continue
        try:
            spent_on = dt.date.fromisoformat(cells[0])
        except ValueError:
            fail(f"R2 malformed spend date at SPEND-REGISTER.md:{n}; use YYYY-MM-DD")
            continue
        if not REGULATED_PERIOD_START <= spent_on <= REGULATED_PERIOD_END:
            fail(f"R2 spend date outside the regulated period at SPEND-REGISTER.md:{n}")
        amount = SPEND_AMOUNT.fullmatch(cells[2])
        if not amount:
            fail(f"R2 malformed spend amount at SPEND-REGISTER.md:{n}; use an explicit NZD number")
            continue
        total += float(amount.group(1).replace(",", "").replace(" ", ""))
    if total > SPEND_ALERT_NZD: fail(f"R2 regulated-period spend ${total:,.2f} exceeds alert threshold ${SPEND_ALERT_NZD:,}")
    if total > UNREGISTERED_LIMIT_NZD: fail(f"R2 spend ${total:,.2f} exceeds unregistered third-party limit")

def check_corrections_append_only() -> None:
    p = ROOT / "CORRECTIONS.md"
    if not p.exists(): fail("R5 CORRECTIONS.md missing"); return
    try:
        shallow = subprocess.run(
            ["git", "rev-parse", "--is-shallow-repository"], cwd=ROOT,
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        if shallow == "true":
            fail("R5 cannot verify full corrections history from a shallow Git checkout")
            return
        commits = subprocess.run(
            ["git", "log", "--format=%H", "--", "CORRECTIONS.md"], cwd=ROOT,
            capture_output=True, text=True, check=True,
        ).stdout.splitlines()
    except (OSError, subprocess.CalledProcessError) as exc:
        fail(f"R5 could not inspect corrections history: {exc}")
        return
    current = p.read_text(encoding="utf-8")
    for commit in commits:
        try:
            historical = subprocess.run(
                ["git", "show", f"{commit}:CORRECTIONS.md"], cwd=ROOT,
                capture_output=True, text=True, check=True,
            ).stdout
        except (OSError, subprocess.CalledProcessError) as exc:
            fail(f"R5 could not read CORRECTIONS.md at {commit}: {exc}")
            return
        if not current.startswith(historical):
            fail("R5 CORRECTIONS.md is append-only; an existing historical entry was edited or removed")
            return

def check_freeze() -> None:
    now_nz = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=NZ_UTC_OFFSET_HOURS)).date()
    if now_nz == ELECTION_DAY and not os.environ.get("RED_LINES_FREEZE_OVERRIDE"):
        fail("R3 election-day freeze: no publishing or merges to main today (NZ time)")

def main(argv: list[str]) -> int:
    scan_content(); check_spend(); check_corrections_append_only()
    if "--freeze-check" in argv: check_freeze()
    if errors:
        print("RED LINE BREACH", file=sys.stderr)
        for e in errors: print(f"- {e}", file=sys.stderr)
        return 1
    print("OK: no red-line breaches"); return 0

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
