# Design notes

## Goals

TriageCI turns language-agnostic test observations into an explainable CI health signal. It deliberately separates report adapters from the analysis service: any test runner can emit the small JSON schema, and the included JUnit adapter handles the common XML interchange format.

## Write path

1. Authenticate and enforce the body limit before parsing.
2. Validate the complete report and bind an idempotency key to its SHA-256 digest.
3. Respond with `202` after admission to a bounded queue.
4. Insert the run, observations, and materialized statistics in one SQLite transaction.
5. Expose delivery completion for callers that need end-to-end acknowledgement.

SQLite runs in WAL mode so dashboard reads do not block the single transactional writer. The current process uses four workers, but the database transaction remains the serialization point. A production multi-node version would replace the in-process queue and SQLite with a durable broker and partitioned database while keeping the API and analyzer boundary.

## Detection model

The analyzer distinguishes three useful cases:

- stable: decisive observations are all passing;
- consistently failing: decisive observations are all failing;
- regression: a previously passing test enters a sustained failure streak without oscillation;
- flaky: a sufficiently sampled history contains both outcomes and repeated transitions, or the same commit has both outcomes.

The score combines outcome diversity, sample confidence, and transition evidence. This is intentionally inspectable rather than an opaque classifier. It does not automatically quarantine tests; it provides evidence so a team can make that policy decision.

## Failure clustering

Stack traces are normalized by removing paths, line numbers, UUIDs, addresses, durations, and other volatile values. A truncated SHA-256 digest groups recurring signatures without storing an index on the entire message. Raw examples remain available for debugging.

## Failure modes

- A saturated queue rejects new work rather than growing memory without bound.
- Replayed deliveries are deduplicated across restarts.
- Reuse of an idempotency key with different content returns `409`.
- Invalid signatures, tokens, schemas, and oversized bodies fail before persistence.
- A process crash after reservation but before processing leaves a visible queued delivery. A production broker should lease and retry these jobs; this single-node version documents rather than hides that limitation.
