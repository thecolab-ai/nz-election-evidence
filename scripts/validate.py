#!/usr/bin/env python3
"""Portable, offline integrity and publication-boundary checks."""
from __future__ import annotations
import csv, json, re, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
errors=[]
def fail(msg): errors.append(msg)
def load(p): return json.loads((ROOT/p).read_text(encoding='utf-8'))
rows=load('catalogue/sources.json'); roadmap=load('catalogue/roadmap.json'); rights=load('catalogue/rights-register.json')
required={'product_id','title','publisher','domain','source_url','snapshot_at_utc','record_count','evidence_forms','observed_start_utc','observed_end_utc','coverage_window','release_mode','rights_status','known_limitations'}
if len(rows)!=24: fail(f'expected 24 source products, got {len(rows)}')
ids=[r.get('product_id') for r in rows]
if len(set(ids))!=len(ids): fail('duplicate product_id')
if set().union(*(set(r) for r in rows))!=required: fail('catalogue field set differs from schema contract')
if sum(r['record_count'] for r in rows)!=351710: fail('record total is not 351710')
for r in rows:
 if not re.fullmatch(r'P\d{2}',r['product_id']): fail(f"bad public ID: {r['product_id']}")
 if not r['source_url'].startswith('https://'): fail(f"non-HTTPS source: {r['product_id']}")
 if sum(x['count'] for x in r['evidence_forms'])!=r['record_count']: fail(f"evidence form sum mismatch: {r['product_id']}")
 if r['release_mode']!='metadata-and-links-only': fail(f"unsafe release mode: {r['product_id']}")
 if r['rights_status']!='pending-publisher-review': fail(f"unexpected rights claim: {r['product_id']}")
with (ROOT/'catalogue/sources.csv').open(newline='',encoding='utf-8') as f: csvrows=list(csv.DictReader(f))
if [(x['product_id'],int(x['record_count'])) for x in csvrows] != [(x['product_id'],x['record_count']) for x in rows]: fail('JSON/CSV catalogue parity failed')
if len(roadmap)!=52 or len({x['lane_id'] for x in roadmap})!=52: fail('roadmap must contain 52 unique lanes')
mapped=[p for lane in roadmap for p in lane['held_product_ids']]
if sorted(mapped)!=sorted(ids): fail('each of 24 products must map to the roadmap exactly once')
if any(r['review_status']!='pending' or r['default_release']!='link-only' for r in rights): fail('rights register must default to pending/link-only')
# Scan tracked candidate text, including dotfiles, before git exists.
blocked=[
 (re.compile('/'+'home/|/'+'Users/'), 'absolute home path'),
 (re.compile(r'(?i)' + 'click' + r'house|ssh\s+|database\s*=|raw storage'), 'operational backend term'),
 (re.compile(r'(?i)(ghp_|github_pat_|AKIA[0-9A-Z]{16}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)'), 'credential signature'),
 (re.compile(r'(?i)donor address'), 'donor address phrase'),
]
allowed_phrase={'DATA-LICENSING.md','README.md','SECURITY.md','CONTRIBUTING.md','docs/coverage-and-limitations.md'}
for path in ROOT.rglob('*'):
 if not path.is_file() or '.git' in path.parts: continue
 if path.suffix.lower() not in {'.md','.json','.csv','.py','.html','.yml','.yaml','.svg','.txt'}: continue
 text=path.read_text(encoding='utf-8',errors='replace')
 rel=str(path.relative_to(ROOT))
 if rel == 'scripts/validate.py': continue  # Scanner signatures are defined here.
 for rx,label in blocked:
  if label=='donor address phrase' and rel in allowed_phrase: continue
  if rx.search(text): fail(f'{label} found in {rel}')
if errors:
 print('VALIDATION FAILED',file=sys.stderr)
 for e in errors: print(f'- {e}',file=sys.stderr)
 raise SystemExit(1)
print(f'OK: 24 products, {sum(r["record_count"] for r in rows):,} records, 52 roadmap lanes, {len(rights)} rights rows')
