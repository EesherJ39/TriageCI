# Security policy

TriageCI treats CI output and webhook payloads as untrusted input.

- Report ingestion requires a constant-time API-token comparison.
- GitHub webhook requests require `X-Hub-Signature-256` HMAC validation.
- Request bodies are capped before JSON parsing; reports are limited to 5,000 tests.
- SQL statements use bound parameters, and dashboard content is escaped before rendering.
- Delivery IDs are persisted and content-bound to prevent accidental or malicious replay.
- The ingestion queue is bounded and returns `429` with `Retry-After` under pressure.
- The container runs without root capabilities and with a read-only filesystem except its data volume.

For a public deployment, terminate TLS at a trusted reverse proxy, rotate both secrets, restrict dashboard access, and place the service behind network-level rate limiting.
