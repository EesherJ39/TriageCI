import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubSignature } from "../src/auth.ts";
import { createApp, type AppConfig } from "../src/server.ts";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "triageci-test-"));
  const config: AppConfig = { host: "127.0.0.1", port: 0, databasePath: join(dir, "db.sqlite"), apiToken: "test-token", githubSecret: "webhook-secret", queueCapacity: 8, workers: 2, maxBodyBytes: 32_000, rateLimitPerMinute: 1000 };
  const app = createApp(config);
  const address = await app.listen();
  return { app, dir, base: `http://127.0.0.1:${address.port}` };
}

const sample = { repository: "demo/cart", runId: "run-1", attempt: 1, commitSha: "abcdef1234567", branch: "main", tests: [{ suite: "unit", name: "adds item", status: "passed", durationMs: 3 }] };

test("ingests authenticated reports asynchronously and exposes results", async () => {
  const f = await fixture();
  try {
    const unauthorized = await fetch(`${f.base}/api/v1/runs`, { method: "POST", body: JSON.stringify(sample), headers: { "content-type": "application/json" } });
    assert.equal(unauthorized.status, 401);
    const accepted = await fetch(`${f.base}/api/v1/runs`, { method: "POST", body: JSON.stringify(sample), headers: { "content-type": "application/json", "x-triageci-token": "test-token", "idempotency-key": "delivery-1" } });
    assert.equal(accepted.status, 202);
    for (let i = 0; i < 50; i++) {
      const status = await (await fetch(`${f.base}/api/v1/deliveries/delivery-1`)).json();
      if (status.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const summary = await (await fetch(`${f.base}/api/v1/summary?repository=demo%2Fcart`)).json();
    assert.equal(summary.runs, 1);
    assert.equal(summary.observations, 1);
    const duplicate = await fetch(`${f.base}/api/v1/runs`, { method: "POST", body: JSON.stringify(sample), headers: { "content-type": "application/json", "x-triageci-token": "test-token", "idempotency-key": "delivery-1" } });
    assert.equal(duplicate.status, 200);
    const conflictBody = JSON.stringify({ ...sample, branch: "feature" });
    const conflict = await fetch(`${f.base}/api/v1/runs`, { method: "POST", body: conflictBody, headers: { "content-type": "application/json", "x-triageci-token": "test-token", "idempotency-key": "delivery-1" } });
    assert.equal(conflict.status, 409);
    assert.match(await (await fetch(`${f.base}/metrics`)).text(), /triageci_observations_total 1/);
    assert.equal((await fetch(`${f.base}/health/ready`)).status, 200);
    assert.match(await (await fetch(f.base)).text(), /TriageCI/);
  } finally { await f.app.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("validates GitHub signatures and deduplicates webhook deliveries", async () => {
  const f = await fixture();
  try {
    const body = Buffer.from(JSON.stringify({ action: "completed", repository: { full_name: "demo/cart" } }));
    const headers = { "x-hub-signature-256": githubSignature(body, "webhook-secret"), "x-github-delivery": "abc-123", "x-github-event": "workflow_run" };
    assert.equal((await fetch(`${f.base}/api/v1/github/webhook`, { method: "POST", body, headers })).status, 202);
    assert.equal((await fetch(`${f.base}/api/v1/github/webhook`, { method: "POST", body, headers })).status, 200);
    assert.equal((await fetch(`${f.base}/api/v1/github/webhook`, { method: "POST", body, headers: { ...headers, "x-hub-signature-256": "sha256=bad" } })).status, 401);
  } finally { await f.app.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("rejects oversized and malformed payloads", async () => {
  const f = await fixture();
  try {
    const oversized = "x".repeat(33_000);
    const large = await fetch(`${f.base}/api/v1/runs`, { method: "POST", body: oversized, headers: { "x-triageci-token": "test-token", "content-length": String(oversized.length) } });
    assert.equal(large.status, 413);
    const malformed = await fetch(`${f.base}/api/v1/runs`, { method: "POST", body: "{", headers: { "x-triageci-token": "test-token" } });
    assert.equal(malformed.status, 400);
  } finally { await f.app.close(); rmSync(f.dir, { recursive: true, force: true }); }
});
