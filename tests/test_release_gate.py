import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release_gate", ROOT / "scripts/release_gate.py")
release_gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_gate)

HEADER = "| Date | Surface | Reviewed by | Red lines checked | Outcome | Notes |\n|---|---|---|---|---|---|\n"


class ReleaseGateTests(unittest.TestCase):
    def test_live_register_keeps_the_explorer_gate_closed(self):
        ok, reason = release_gate.gate((ROOT / "REVIEW-REGISTER.md").read_text(), "Evidence explorer")
        self.assertFalse(ok)
        self.assertIn("not approved", reason)

    def test_missing_row_fails_closed(self):
        self.assertFalse(release_gate.gate(HEADER, "Evidence explorer")[0])

    def test_pending_row_fails_closed(self):
        text = HEADER + "| 2026-09-20 | Evidence explorer | Not appointed | R1–R10 pending | **PENDING — NOT REVIEWED** | x |\n"
        self.assertFalse(release_gate.gate(text, "Evidence explorer")[0])

    def test_approval_without_named_reviewer_fails_closed(self):
        text = HEADER + "| 2026-10-01 | Evidence explorer | Not appointed | R1–R10 | **APPROVED** | x |\n"
        self.assertFalse(release_gate.gate(text, "Evidence explorer")[0])

    def test_latest_row_wins_so_a_later_withdrawal_closes_the_gate(self):
        text = (HEADER + "| 2026-10-01 | Evidence explorer | Fixture Reviewer | R1–R10 | **APPROVED** | x |\n"
                + "| 2026-10-02 | Evidence explorer | Fixture Reviewer | R1–R10 | **WITHDRAWN** | x |\n")
        self.assertFalse(release_gate.gate(text, "Evidence explorer")[0])

    def test_named_dated_approval_opens_the_gate(self):
        text = HEADER + "| 2026-10-01 | Evidence explorer | Fixture Reviewer | R1–R10 | **APPROVED** | x |\n"
        ok, reason = release_gate.gate(text, "Evidence explorer")
        self.assertTrue(ok)
        self.assertIn("Fixture Reviewer", reason)

    def test_another_surface_approval_does_not_open_this_gate(self):
        text = HEADER + "| 2026-10-01 | Evidence atlas | Fixture Reviewer | R1–R10 | **APPROVED** | x |\n"
        self.assertFalse(release_gate.gate(text, "Evidence explorer")[0])

    def test_deploy_workflow_is_gated_and_least_privilege(self):
        workflow = (ROOT / ".github/workflows/explorer.yml").read_text()
        self.assertIn("permissions:\n  contents: read", workflow)
        self.assertIn("scripts/release_gate.py --surface \"Evidence explorer\"", workflow)
        self.assertIn("scripts/red_lines.py --freeze-check", workflow)
        self.assertIn("vars.PAGES_DEPLOY_ENABLED == 'true'", workflow)
        deploy = workflow[workflow.index("\n  deploy:"):]
        self.assertIn("needs: [compliance, ingest, database, web, web-e2e, release-gate]", deploy)
        self.assertIn("pages: write", deploy)
        self.assertIn("id-token: write", deploy)
        self.assertNotIn("contents: write", workflow)
        # The workflow holds no secret at all: public build variables only.
        self.assertNotIn("secrets.", workflow)
        self.assertNotIn("pull_request_target", workflow)


if __name__ == "__main__":
    unittest.main()
