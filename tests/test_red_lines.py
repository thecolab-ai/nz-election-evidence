import importlib.util, subprocess, tempfile, unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location("red_lines", Path(__file__).resolve().parents[1] / "scripts" / "red_lines.py")
rl = importlib.util.module_from_spec(spec); spec.loader.exec_module(rl)

class RedLineRegexes(unittest.TestCase):
    def test_r4_catches_dishonesty(self):
        for s in ["The Minister lied about the figure", "a dishonest claim", "this cover-up", "deliberately misled voters"]:
            self.assertTrue(rl.R4_DISHONESTY.search(s), s)
    def test_r4_allows_delta_language(self):
        for s in ["The statement said $2b; the Treasury table shows $1.4b.", "The claim is unverified.", "The figure differs from the primary source."]:
            self.assertFalse(rl.R4_DISHONESTY.search(s), s)
    def test_r1_catches_advocacy(self):
        for s in ["vote for them", "Don't vote National", "re-elect the government", "kick them out"]:
            self.assertTrue(rl.R1_ADVOCACY.search(s), s)
    def test_r1_allows_neutral(self):
        for s in ["Party vote share in 2023 was 38%.", "The Minister of Transport replied on 2024-05-01."]:
            self.assertFalse(rl.R1_ADVOCACY.search(s), s)

class EnforcementRegressions(unittest.TestCase):
    def setUp(self):
        self.old_root = rl.ROOT
        rl.errors.clear()

    def tearDown(self):
        rl.ROOT = self.old_root
        rl.errors.clear()

    def test_unlinked_blockquote_does_not_bypass_advocacy_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            rl.ROOT = Path(tmp)
            (rl.ROOT / "docs").mkdir()
            (rl.ROOT / "docs" / "finding.md").write_text("> Vote for Party X\n")
            rl.scan_content()
        self.assertTrue(any("R1 advocacy" in error for error in rl.errors), rl.errors)

    def test_linked_blockquote_is_treated_as_attributed_source_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            rl.ROOT = Path(tmp)
            (rl.ROOT / "docs").mkdir()
            (rl.ROOT / "docs" / "finding.md").write_text(
                "> Vote for Party X ([primary source](https://example.test/source))\n"
            )
            rl.scan_content()
        self.assertEqual(rl.errors, [])

    def test_noncanonical_spend_cannot_bypass_threshold(self):
        with tempfile.TemporaryDirectory() as tmp:
            rl.ROOT = Path(tmp)
            (rl.ROOT / "SPEND-REGISTER.md").write_text(
                "| Date | Item | NZD incl. GST | Paid by | Note |\n"
                "|---|---|---|---|---|\n"
                "| 2026-09-20 | Promotion | NZD 11 000 | Project | Planned |\n"
            )
            rl.check_spend()
        self.assertTrue(any("exceeds alert threshold" in error for error in rl.errors), rl.errors)

    def test_malformed_spend_row_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            rl.ROOT = Path(tmp)
            (rl.ROOT / "SPEND-REGISTER.md").write_text(
                "| Date | Item | NZD incl. GST | Paid by | Note |\n"
                "|---|---|---|---|---|\n"
                "| sometime | Promotion | eleven thousand | Project | Planned |\n"
            )
            rl.check_spend()
        self.assertTrue(any("malformed" in error for error in rl.errors), rl.errors)

    def test_correction_edit_cannot_be_hidden_by_later_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rl.ROOT = root
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.test"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
            corrections = root / "CORRECTIONS.md"
            corrections.write_text("# Corrections\n\noriginal entry\n")
            subprocess.run(["git", "add", "CORRECTIONS.md"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-qm", "initial correction"], cwd=root, check=True)
            corrections.write_text("# Corrections\n\nrewritten entry\n")
            subprocess.run(["git", "add", "CORRECTIONS.md"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-qm", "rewrite correction"], cwd=root, check=True)
            (root / "later.txt").write_text("later\n")
            subprocess.run(["git", "add", "later.txt"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-qm", "later unrelated change"], cwd=root, check=True)
            rl.check_corrections_append_only()
        self.assertTrue(any("append-only" in error for error in rl.errors), rl.errors)

if __name__ == "__main__": unittest.main()
