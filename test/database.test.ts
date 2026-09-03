import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TriageDatabase } from "../src/database.ts";
import type { RunReport } from "../src/validation.ts";

function report(runId: string, commitSha: string, status: "passed" | "failed", attempt = 1): RunReport {
  return { repository: "demo/cart", runId, attempt, commitSha, branch: "main", tests: [
    { suite: "checkout", name: "charges card", status, durationMs: 12, failure: status === "failed" ? "timeout at /tmp/a.ts:99 after 500ms" : undefined },
  ] };
}

test("persists run idempotently and materializes flaky state", () => {
  const db = new TriageDatabase(":memory:");
  const sha = "abcdef1234567";
  assert.equal(db.ingest(report("1", sha, "passed")).duplicateRun, false);
  assert.equal(db.ingest(report("1", sha, "passed")).duplicateRun, true);
  db.ingest(report("2", sha, "failed"));
  db.ingest(report("3", sha, "passed"));
  db.ingest(report("4", sha, "failed"));
  const summary = db.summary("demo/cart");
  assert.equal(summary.runs, 4);
  assert.equal(summary.observations, 4);
  assert.equal(summary.flaky, 1);
  assert.equal((summary.topFlaky as unknown[]).length, 1);
  db.close();
});

test("rejects an idempotency key reused with different content", () => {
  const db = new TriageDatabase(":memory:");
  assert.equal(db.reserveDelivery("delivery-1", "hash-a"), "reserved");
  assert.equal(db.reserveDelivery("delivery-1", "hash-a"), "duplicate");
  assert.equal(db.reserveDelivery("delivery-1", "hash-b"), "conflict");
  db.markDelivery("delivery-1", "completed");
  assert.equal(db.delivery("delivery-1")?.status, "completed");
  db.close();
});

test("recovers the delivery ledger and materialized statistics after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "triageci-recovery-"));
  const path = join(dir, "triageci.db");
  try {
    let db = new TriageDatabase(path);
    assert.equal(db.reserveDelivery("durable-delivery", "hash"), "reserved");
    db.ingest(report("durable-run", "abcdef1234567", "passed"));
    db.markDelivery("durable-delivery", "completed");
    db.close();

    db = new TriageDatabase(path);
    assert.equal(db.reserveDelivery("durable-delivery", "hash"), "duplicate");
    assert.equal(db.delivery("durable-delivery")?.status, "completed");
    assert.equal(db.summary("demo/cart").observations, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
