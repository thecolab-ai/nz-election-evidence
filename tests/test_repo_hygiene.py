"""Repository hygiene checks: the record stays small and text-only (docs/what-lives-where.md)."""
import shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_validate(root: Path) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(root / 'scripts' / 'validate.py')], capture_output=True, text=True)


def copy_repo() -> Path:
    dst = Path(tempfile.mkdtemp()) / 'repo'
    shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns('.git', '__pycache__', '.venv', 'node_modules'))
    return dst


class RepoHygiene(unittest.TestCase):
    def test_clean_repository_passes(self):
        result = run_validate(ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_large_text_file_is_rejected(self):
        repo = copy_repo()
        (repo / 'examples' / 'oversized-fixture.json').write_text('[' + '1,' * 60_000 + '1]', encoding='utf-8')
        result = run_validate(repo)
        self.assertEqual(result.returncode, 1)
        self.assertIn('file too large for the record', result.stderr)

    def test_binary_or_document_file_is_rejected(self):
        repo = copy_repo()
        (repo / 'examples' / 'source-copy.pdf').write_bytes(b'%PDF-1.4 fixture, not a real document')
        result = run_validate(repo)
        self.assertEqual(result.returncode, 1)
        self.assertIn('binary or document file committed', result.stderr)

    def test_docs_assets_get_a_larger_allowance(self):
        repo = copy_repo()
        (repo / 'docs' / 'assets' / 'large-diagram.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg">' + '<!-- x -->' * 20_000 + '</svg>', encoding='utf-8')
        result = run_validate(repo)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
