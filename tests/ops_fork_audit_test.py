import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('fork_audit', Path(__file__).resolve().parents[1] / 'scripts/ops/fork-push.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class ForkAuditTests(unittest.TestCase):
    def test_credential_values_are_reported_as_reasons_only(self):
        value = b'sk-' + b'X' * 40
        reasons = audit.scan_blob(b'"api_key":"' + value + b'"', 'fixture.js', 100)
        self.assertIn('credential_pattern', reasons)
        self.assertNotIn(value.decode(), str(reasons))

    def test_provider_import_examples_are_not_real_credentials(self):
        for value in (b'access_token', b'ya29.a0...', b'your-api-key'):
            self.assertEqual(audit.scan_blob(b'"access_token":"' + value + b'"', 'fixture.js', 100), [])

    def test_artifact_paths_and_large_blobs_require_review(self):
        self.assertIn('local_artifact_path', audit.scan_blob(b'', '.plans/runlog.md', 1))
        self.assertIn('sensitive_or_artifact_path', audit.scan_blob(b'', 'snapshot.sqlite', 1))
        self.assertIn('large_blob_over_10MiB', audit.scan_blob(b'', 'fixture.bin', 11 * 1024 * 1024))


if __name__ == '__main__':
    unittest.main()
