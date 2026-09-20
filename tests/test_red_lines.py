import importlib.util, re, unittest
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

if __name__ == "__main__": unittest.main()
