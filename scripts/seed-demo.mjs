const base = process.env.TRIAGECI_URL ?? "http://127.0.0.1:8080";
const token = process.env.TRIAGECI_TOKEN ?? "local-development-token";

for (let run = 0; run < 18; run++) {
  const report = {
    repository: "demo/checkout",
    runId: `demo-${run}`,
    attempt: 1,
    commitSha: (BigInt("0xabcdef1234567") + BigInt(Math.floor(run / 3))).toString(16),
    branch: "main",
    tests: [
      { suite: "cart.unit", name: "adds item", status: "passed", durationMs: 8 + run },
      { suite: "checkout.integration", name: "charges card", status: run % 3 === 1 ? "failed" : "passed", durationMs: 210 + run, failure: run % 3 === 1 ? `Timeout at /runner/work/checkout.ts:${80 + run} after ${500 + run}ms` : undefined },
      { suite: "checkout.integration", name: "applies coupon", status: run < 12 ? "passed" : "failed", durationMs: 55, failure: run < 12 ? undefined : "Expected 20.00 but received 25.00" },
    ],
  };
  const response = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify(report), headers: { "content-type": "application/json", "x-triageci-token": token, "idempotency-key": `demo-delivery-${run}` } });
  if (![200, 202].includes(response.status)) throw new Error(`seed failed: ${response.status} ${await response.text()}`);
}
console.log("Seeded demo/checkout with stable, flaky, and regression histories.");
