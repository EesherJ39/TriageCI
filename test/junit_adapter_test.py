from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class JunitAdapterTest(unittest.TestCase):
    def test_converts_pass_fail_and_skip(self) -> None:
        xml = """<?xml version="1.0"?>
<testsuite name="checkout" tests="3">
  <testcase classname="cart" name="adds" time="0.004" />
  <testcase classname="cart" name="charges" time="0.125"><failure message="timeout">stack</failure></testcase>
  <testcase classname="cart" name="coupon" time="0"><skipped /></testcase>
</testsuite>"""
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "junit.xml"
            report.write_text(xml, encoding="utf-8")
            command = [sys.executable, "scripts/junit_to_json.py", str(report), "--repository", "demo/cart",
                       "--run-id", "42", "--commit", "abcdef1234567", "--branch", "main"]
            result = subprocess.run(command, check=True, capture_output=True, text=True)
        payload = json.loads(result.stdout)
        self.assertEqual([test["status"] for test in payload["tests"]], ["passed", "failed", "skipped"])
        self.assertEqual(payload["tests"][1]["durationMs"], 125.0)
        self.assertIn("timeout", payload["tests"][1]["failure"])


if __name__ == "__main__":
    unittest.main()
