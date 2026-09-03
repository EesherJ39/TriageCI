import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createApp } from "../src/server.ts";

const REPORTS = Number(process.env.REPORTS ?? 1200);
const TESTS_PER_REPORT = Number(process.env.TESTS_PER_REPORT ?? 25);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const dir = mkdtempSync(join(tmpdir(), "triageci-stress-"));
const app = createApp({ host: "127.0.0.1", port: 0, databasePath: join(dir, "stress.db"), apiToken: "stress-token", githubSecret: "stress-secret", queueCapacity: 2048, workers: 4, maxBodyBytes: 2_097_152, rateLimitPerMinute: REPORTS * 4 });
const address = await app.listen();
const base = `http://127.0.0.1:${address.port}`;
const latencies = [];

function report(index) {
  const commit = (BigInt("0xabcdef1234567") + BigInt(Math.floor(index / 3))).toString(16).padStart(13, "0");
  return {
    repository: "demo/checkout", runId: `run-${index}`, attempt: 1, commitSha: commit, branch: "main", durationMs: 900,
    tests: Array.from({ length: TESTS_PER_REPORT }, (_, testIndex) => {
      const flaky = testIndex < 5;
      const regression = testIndex >= 5 && testIndex < 8;
      const failed = flaky ? ((index * 17 + testIndex * 13) % 11 < 3) : regression ? index > REPORTS / 2 : false;
      return { suite: testIndex % 2 ? "checkout.integration" : "cart.unit", name: `test-${testIndex}`, status: failed ? "failed" : "passed", durationMs: 3 + ((index + testIndex) % 40), failure: failed ? `Timeout at /runner/work/cart/test-${testIndex}.ts:${80 + index % 20} after ${500 + index % 50}ms` : undefined };
    }),
  };
}

let cursor = 0;
async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= REPORTS) return;
    const started = performance.now();
    const response = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify(report(index)), headers: { "content-type": "application/json", "x-triageci-token": "stress-token", "idempotency-key": `delivery-${index}` } });
    latencies.push(performance.now() - started);
    if (response.status !== 202) throw new Error(`unexpected status ${response.status}: ${await response.text()}`);
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
while (app.counters.processed + app.counters.failed < REPORTS) await new Promise((resolve) => setTimeout(resolve, 10));
const completed = performance.now();

for (let i = 0; i < Math.min(100, REPORTS); i++) {
  const response = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify(report(i)), headers: { "content-type": "application/json", "x-triageci-token": "stress-token", "idempotency-key": `delivery-${i}` } });
  if (response.status !== 200) throw new Error(`duplicate request was not deduplicated: ${response.status}`);
}
const badAuth = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify(report(0)), headers: { "x-triageci-token": "wrong" } });
if (badAuth.status !== 401) throw new Error("invalid token was accepted");
const summary = await (await fetch(`${base}/api/v1/summary?repository=demo%2Fcheckout`)).json();
latencies.sort((a, b) => a - b);
const percentile = (p) => Number(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))].toFixed(2));
const elapsedSeconds = (completed - started) / 1000;
const result = {
  environment: { node: process.version, platform: `${process.platform}-${process.arch}`, concurrency: CONCURRENCY, workers: 4 },
  workload: { reports: REPORTS, testsPerReport: TESTS_PER_REPORT, observations: REPORTS * TESTS_PER_REPORT, duplicateReplays: Math.min(100, REPORTS) },
  results: { elapsedSeconds: Number(elapsedSeconds.toFixed(3)), reportsPerSecond: Number((REPORTS / elapsedSeconds).toFixed(2)), observationsPerSecond: Number((REPORTS * TESTS_PER_REPORT / elapsedSeconds).toFixed(2)), requestLatencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) }, processed: app.counters.processed, failed: app.counters.failed, deduplicated: app.counters.duplicates, detectedFlaky: summary.flaky, detectedRegressions: summary.regressions, detectedConsistentlyFailing: summary.consistentlyFailing } };
writeFileSync("benchmark-results.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await app.close();
rmSync(dir, { recursive: true, force: true });
