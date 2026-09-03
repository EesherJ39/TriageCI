import test from "node:test";
import assert from "node:assert/strict";
import { emptyStats, failureSignature, normalizeFailure, updateStats } from "../src/analyzer.ts";

test("classifies stable, consistently failing, and flaky histories", () => {
  let stable = emptyStats();
  for (let i = 0; i < 8; i++) stable = updateStats(stable, "passed");
  assert.equal(stable.state, "stable");
  assert.equal(stable.flakeScore, 0);

  let failing = emptyStats();
  for (let i = 0; i < 6; i++) failing = updateStats(failing, "failed");
  assert.equal(failing.state, "consistently-failing");
  assert.equal(failing.flakeScore, 0);

  let flaky = emptyStats();
  for (const status of ["passed", "failed", "passed", "failed", "passed"] as const) flaky = updateStats(flaky, status);
  assert.equal(flaky.state, "flaky");
  assert.ok(flaky.flakeScore > 40);
});

test("same-commit pass/fail evidence can establish flakiness", () => {
  let stats = emptyStats();
  stats = updateStats(stats, "passed");
  stats = updateStats(stats, "passed");
  stats = updateStats(stats, "failed");
  stats = updateStats(stats, "failed", true);
  assert.equal(stats.state, "flaky");
});

test("distinguishes a sustained regression from oscillating flakiness", () => {
  let stats = emptyStats();
  for (const status of ["passed", "passed", "passed", "failed", "failed", "failed"] as const) stats = updateStats(stats, status);
  assert.equal(stats.state, "regression");
  assert.equal(stats.failureStreak, 3);
});

test("normalizes volatile failure values before clustering", () => {
  const a = "Timeout at C:\\agent\\work\\cart.test.ts:91 after 1200ms id 314159";
  const b = "Timeout at /runner/work/cart.test.ts:18 after 800ms id 271828";
  assert.equal(normalizeFailure(a), normalizeFailure(b));
  assert.equal(failureSignature(a), failureSignature(b));
  assert.equal(failureSignature(undefined), null);
});
