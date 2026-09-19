import json, subprocess, sys, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class CatalogueTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.sources=json.loads((ROOT/'catalogue/sources.json').read_text())
  cls.roadmap=json.loads((ROOT/'catalogue/roadmap.json').read_text())
 def test_snapshot_total(self): self.assertEqual(sum(r['record_count'] for r in self.sources),351710)
 def test_all_24_mapped_once(self):
  ids=[r['product_id'] for r in self.sources]; mapped=[p for lane in self.roadmap for p in lane['held_product_ids']]
  self.assertCountEqual(ids,mapped); self.assertEqual(len(mapped),24)
 def test_52_is_roadmap_not_completion(self):
  self.assertEqual(len(self.roadmap),52)
  self.assertTrue(any(r['status'] in {'not_yet_available','blocked_unverified'} for r in self.roadmap))
 def test_validator(self):
  p=subprocess.run([sys.executable,str(ROOT/'scripts/validate.py')],capture_output=True,text=True)
  self.assertEqual(p.returncode,0,p.stdout+p.stderr)
if __name__=='__main__': unittest.main()
