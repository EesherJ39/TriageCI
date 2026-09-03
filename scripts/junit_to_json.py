#!/usr/bin/env python3
"""Convert one or more JUnit XML files into a TriageCI run report."""
from __future__ import annotations

import argparse
import json
import xml.etree.ElementTree as ET


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+")
    parser.add_argument("--repository", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--attempt", type=int, default=1)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--branch", required=True)
    args = parser.parse_args()
    tests: list[dict[str, object]] = []
    for filename in args.files:
        root = ET.parse(filename).getroot()
        for case in root.iter("testcase"):
            failure = case.find("failure")
            error = case.find("error")
            skipped = case.find("skipped")
            node = failure if failure is not None else error
            status = "skipped" if skipped is not None else "failed" if node is not None else "passed"
            entry: dict[str, object] = {
                "suite": case.attrib.get("classname", root.attrib.get("name", "unknown")),
                "name": case.attrib.get("name", "unknown"),
                "status": status,
                "durationMs": round(float(case.attrib.get("time", "0")) * 1000, 3),
            }
            if node is not None:
                entry["failure"] = ((node.attrib.get("message", "") + "\n" + (node.text or "")).strip())[:8000]
            tests.append(entry)
    json.dump({"repository": args.repository, "runId": args.run_id, "attempt": args.attempt,
               "commitSha": args.commit, "branch": args.branch, "tests": tests}, fp=__import__("sys").stdout)


if __name__ == "__main__":
    main()
