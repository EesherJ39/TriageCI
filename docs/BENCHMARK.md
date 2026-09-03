# Stress-test results

## Workload

Each run submitted 5,000 reports containing 25 tests apiece through the HTTP API: 125,000 observations per run. Sixty-four concurrent clients targeted four background workers. Five deterministic tests oscillated between pass and fail; three passed initially and then entered a sustained failure streak. After processing completed, the harness replayed 100 delivery IDs and sent an invalid-token request.

Environment: Node.js 24.12.0, Windows 11, Intel Core i7-13700K (24 logical cores), 32 GB RAM, local loopback, SQLite WAL on local storage. Results below are local measurements, not production capacity claims.

| Run | End-to-end time | Reports/s | Observations/s | HTTP p50 | HTTP p95 | HTTP p99 | Processing failures |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 10.194 s | 490.47 | 12,261.64 | 130.11 ms | 148.00 ms | 170.87 ms | 0 |
| 2 | 10.181 s | 491.11 | 12,277.85 | 128.32 ms | 141.59 ms | 144.86 ms | 0 |
| 3 | 10.509 s | 475.80 | 11,895.03 | 132.44 ms | 153.80 ms | 173.60 ms | 0 |
| Median | 10.194 s | 490.47 | 12,261.64 | 130.11 ms | 148.00 ms | 170.87 ms | 0 |

Across the three clean-database runs, TriageCI transactionally processed 375,000 observations with zero processing failures. It correctly surfaced all five seeded flaky tests and all three seeded regressions on every run, deduplicated all 300 replayed deliveries, and rejected every invalid-token request.

HTTP percentiles measure time to authenticate, validate, reserve the idempotency key, admit the report to the bounded queue, and return `202`; overall throughput waits for every delivery to reach a terminal persisted state. The harness and latest machine-readable result are produced by `npm run stress`.
