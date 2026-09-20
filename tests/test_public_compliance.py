import csv
import json
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
PENDING_PERMISSION = (
    "Not verified; release restricted to catalogue metadata and source links "
    "pending rights review"
)


class FooterParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_footer = False
        self.footer_labels = []
        self.footer_hrefs = []
        self.footer_link_text = []
        self._current_link_text = None
        self.footer_text = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "footer":
            self.in_footer = True
            self.footer_labels.append(attributes.get("aria-label", ""))
        if self.in_footer and tag == "a":
            self.footer_hrefs.append(attributes.get("href", ""))
            self._current_link_text = []

    def handle_data(self, data):
        if self.in_footer:
            self.footer_text.append(data)
            if self._current_link_text is not None:
                self._current_link_text.append(data)

    def handle_endtag(self, tag):
        if self.in_footer and tag == "a" and self._current_link_text is not None:
            self.footer_link_text.append("".join(self._current_link_text).strip())
            self._current_link_text = None
        if tag == "footer":
            self.in_footer = False


class PublicComplianceTests(unittest.TestCase):
    def test_atlas_footer_has_accountability_disclaimer_and_policy_links(self):
        parser = FooterParser()
        parser.feed((ROOT / "atlas/index.html").read_text())
        text = " ".join(" ".join(parser.footer_text).split())

        self.assertEqual(parser.footer_labels, ["Project accountability and policy links"])
        self.assertIn("The Colab — NZ Election Evidence project", text)
        self.assertIn("Adam Holt", text)
        self.assertIn("New Zealand Parliament", text)
        self.assertIn("Electoral Commission", text)
        self.assertIn("political party", text)
        self.assertIn("Legal review remains pending", text)
        self.assertTrue(all(parser.footer_link_text), "Footer links need accessible text")

        required = {"../RED-LINES.md", "../CORRECTIONS.md", "../REVIEW-REGISTER.md"}
        self.assertTrue(required.issubset(parser.footer_hrefs))
        for href in parser.footer_hrefs:
            if urlparse(href).scheme:
                continue
            self.assertTrue((ROOT / "atlas" / href).resolve().is_file(), href)

    def test_readme_discloses_unresolved_r8_and_r10_gates(self):
        readme = (ROOT / "README.md").read_text()
        for phrase in (
            "Responsible project: **The Colab — NZ Election Evidence project**",
            "Project maintainer/contact: **Adam Holt",
            "responsible legal entity and an independent legal reviewer have not been confirmed",
            "not completed legal review",
            "Technical changes and automated checks cannot complete",
            "New Zealand Parliament, the Electoral Commission, or any political party",
            "[red lines](RED-LINES.md)",
            "[corrections log](CORRECTIONS.md)",
        ):
            self.assertIn(phrase, readme)

    def test_review_register_rows_are_pending_not_approval(self):
        register = (ROOT / "REVIEW-REGISTER.md").read_text()
        self.assertEqual(register.count("**PENDING — NOT REVIEWED**"), 2)
        self.assertEqual(register.count("| Not appointed |"), 2)
        self.assertIn("cannot substitute for the independent legal review", register)
        self.assertNotIn("| APPROVED |", register.upper())

    def test_all_rights_rows_are_explicitly_unverified_and_match_csv(self):
        rows = json.loads((ROOT / "catalogue/rights-register.json").read_text())
        with (ROOT / "catalogue/rights-register.csv").open(newline="") as handle:
            csv_rows = list(csv.DictReader(handle))

        self.assertEqual(len(rows), 19)
        self.assertEqual(len(csv_rows), 19)
        self.assertEqual(rows, csv_rows_as_json(csv_rows))
        for row in rows:
            self.assertEqual(row["review_status"], "pending")
            self.assertEqual(row["verified_permissions"], PENDING_PERMISSION)
            self.assertEqual(row["reviewed_on"], "")

    def test_historical_model_classification_carries_unknowns_and_warning(self):
        products = json.loads((ROOT / "catalogue/sources.json").read_text())
        notice = next(row for row in products if row["product_id"] == "P13")[
            "known_limitations"
        ]
        for phrase in (
            "preliminary model-assisted classification",
            "Model name/version unknown",
            "schema/prompt unavailable",
            "confidence unavailable",
            "not yet checked against human review",
            "unreviewed, not verified findings",
        ):
            self.assertIn(phrase, notice)
        self.assertIn(notice, (ROOT / "atlas/index.html").read_text())

    def test_artwork_provenance_gap_is_conditional_not_a_model_claim(self):
        report = (ROOT / "docs/sanitization-report.md").read_text()
        self.assertIn("generation provenance is not recorded", report)
        self.assertIn("does not establish whether a model was used", report)
        self.assertIn("If a model was used", report)

    def test_election_day_stale_check_limitation_is_disclosed(self):
        readme = (ROOT / "README.md").read_text()
        self.assertIn("not a durable election-day merge lock", readme)
        self.assertIn("must block merges and rerun the freeze check", readme)


def csv_rows_as_json(rows):
    converted = []
    for row in rows:
        item = dict(row)
        item["product_ids"] = item["product_ids"].split(";")
        converted.append(item)
    return converted


if __name__ == "__main__":
    unittest.main()
