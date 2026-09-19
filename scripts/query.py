#!/usr/bin/env python3
"""Query snapshot metadata with Python's standard library."""
import argparse, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser()
p.add_argument('--domain',help='case-insensitive catalogue domain')
p.add_argument('--roadmap-status',help='exact roadmap status')
a=p.parse_args()
if not (a.domain or a.roadmap_status): p.error('choose --domain or --roadmap-status')
if a.domain:
 rows=json.loads((ROOT/'catalogue/sources.json').read_text())
 rows=[r for r in rows if r['domain'].casefold()==a.domain.casefold()]
 for r in rows: print(f"{r['product_id']}\t{r['record_count']}\t{r['title']}\t{r['source_url']}")
else:
 rows=json.loads((ROOT/'catalogue/roadmap.json').read_text())
 rows=[r for r in rows if r['status']==a.roadmap_status]
 for r in rows: print(f"{r['lane_id']}\t{r['title']}\t{','.join(r['held_product_ids']) or '-'}")
print(f"matches={len(rows)}")
