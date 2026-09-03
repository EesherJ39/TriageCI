import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TriageDatabase } from "./database.ts";
import { BoundedQueue } from "./queue.ts";
import { verifyApiToken, verifyGithubSignature } from "./auth.ts";
import { validateReport, type RunReport } from "./validation.ts";
import { DASHBOARD_HTML } from "./dashboard.ts";

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  apiToken: string;
  githubSecret: string;
  queueCapacity: number;
  workers: number;
  maxBodyBytes: number;
  rateLimitPerMinute: number;
}

interface IngestJob { deliveryId: string; report: RunReport }
interface Counters { requests: number; accepted: number; rejected: number; duplicates: number; processed: number; failed: number; observations: number }

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw Object.assign(new Error("payload too large"), { statusCode: 413 });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      req.destroy();
      throw Object.assign(new Error("payload too large"), { statusCode: 413 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

class FixedWindowLimiter {
  #entries = new Map<string, { window: number; count: number }>();
  readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  allow(key: string, now = Date.now()): boolean {
    const window = Math.floor(now / 60_000);
    const current = this.#entries.get(key);
    if (!current || current.window !== window) {
      this.#entries.set(key, { window, count: 1 });
      if (this.#entries.size > 10_000) this.#entries.clear();
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}

export function defaultConfig(): AppConfig {
  const dataDir = process.env.TRIAGECI_DATA_DIR ?? ".triageci";
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 8080),
    databasePath: process.env.TRIAGECI_DB ?? join(dataDir, "triageci.db"),
    apiToken: process.env.TRIAGECI_TOKEN ?? "local-development-token",
    githubSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "local-webhook-secret",
    queueCapacity: Number(process.env.QUEUE_CAPACITY ?? 1024),
    workers: Number(process.env.WORKERS ?? 4),
    maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 2_097_152),
    rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 10_000),
  };
}

export function createApp(config: AppConfig = defaultConfig()) {
  const db = new TriageDatabase(config.databasePath);
  const queue = new BoundedQueue<IngestJob>(config.queueCapacity);
  const limiter = new FixedWindowLimiter(config.rateLimitPerMinute);
  const counters: Counters = { requests: 0, accepted: 0, rejected: 0, duplicates: 0, processed: 0, failed: 0, observations: 0 };
  const workerTasks = Array.from({ length: config.workers }, async () => {
    while (true) {
      const job = await queue.pop();
      if (!job) return;
      try {
        const result = db.ingest(job.report);
        if (result.duplicateRun) counters.duplicates += 1;
        counters.processed += 1;
        counters.observations += result.observations;
        db.markDelivery(job.deliveryId, "completed");
      } catch (error) {
        counters.failed += 1;
        db.markDelivery(job.deliveryId, "failed", error instanceof Error ? error.message : String(error));
      }
    }
  });

  const server = createServer(async (req, res) => {
    counters.requests += 1;
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const client = req.socket.remoteAddress ?? "unknown";
    if (!limiter.allow(client)) {
      counters.rejected += 1;
      res.setHeader("retry-after", "60");
      return json(res, 429, { error: "rate limit exceeded" });
    }
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
        return res.end(DASHBOARD_HTML);
      }
      if (req.method === "GET" && url.pathname === "/health/live") return json(res, 200, { status: "live" });
      if (req.method === "GET" && url.pathname === "/health/ready") return json(res, 200, { status: "ready", queueDepth: queue.depth });
      if (req.method === "GET" && url.pathname === "/metrics") {
        const persisted = db.counts();
        const lines = [
          "# TYPE triageci_requests_total counter", `triageci_requests_total ${counters.requests}`,
          "# TYPE triageci_reports_accepted_total counter", `triageci_reports_accepted_total ${counters.accepted}`,
          "# TYPE triageci_reports_processed_total counter", `triageci_reports_processed_total ${counters.processed}`,
          "# TYPE triageci_reports_rejected_total counter", `triageci_reports_rejected_total ${counters.rejected}`,
          "# TYPE triageci_observations_total counter", `triageci_observations_total ${persisted.observations}`,
          "# TYPE triageci_queue_depth gauge", `triageci_queue_depth ${queue.depth}`,
        ];
        const body = `${lines.join("\n")}\n`;
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
        return res.end(body);
      }
      if (req.method === "GET" && url.pathname === "/api/v1/summary") {
        const repository = url.searchParams.get("repository") ?? "";
        if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) return json(res, 400, { error: "repository must be owner/name" });
        return json(res, 200, db.summary(repository));
      }
      if (req.method === "GET" && url.pathname === "/api/v1/tests") {
        const repository = url.searchParams.get("repository") ?? "";
        const state = url.searchParams.get("state") ?? undefined;
        if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) return json(res, 400, { error: "repository must be owner/name" });
        if (state && !["stable", "flaky", "regression", "consistently-failing", "insufficient-data"].includes(state)) return json(res, 400, { error: "state is invalid" });
        return json(res, 200, { repository, tests: db.tests(repository, state) });
      }
      const deliveryMatch = url.pathname.match(/^\/api\/v1\/deliveries\/([A-Za-z0-9_.:-]{1,200})$/);
      if (req.method === "GET" && deliveryMatch) {
        const delivery = db.delivery(deliveryMatch[1]);
        return delivery ? json(res, 200, delivery) : json(res, 404, { error: "delivery not found" });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/runs") {
        if (!verifyApiToken(req.headers["x-triageci-token"] as string | undefined, config.apiToken)) {
          counters.rejected += 1;
          return json(res, 401, { error: "invalid token" });
        }
        const body = await readBody(req, config.maxBodyBytes);
        let parsed: unknown;
        try { parsed = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
        let report: RunReport;
        try { report = validateReport(parsed); } catch (error) { return json(res, 422, { error: (error as Error).message }); }
        const deliveryId = String(req.headers["idempotency-key"] ?? randomUUID());
        if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(deliveryId)) return json(res, 400, { error: "invalid idempotency key" });
        const digest = createHash("sha256").update(body).digest("hex");
        const reservation = db.reserveDelivery(deliveryId, digest);
        if (reservation === "duplicate") { counters.duplicates += 1; return json(res, 200, { deliveryId, status: "duplicate" }); }
        if (reservation === "conflict") return json(res, 409, { error: "idempotency key reused with a different payload" });
        if (!queue.tryPush({ deliveryId, report })) {
          db.markDelivery(deliveryId, "failed", "queue saturated");
          counters.rejected += 1;
          res.setHeader("retry-after", "1");
          return json(res, 429, { error: "ingestion queue saturated" });
        }
        counters.accepted += 1;
        return json(res, 202, { deliveryId, status: "queued" });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/github/webhook") {
        const body = await readBody(req, config.maxBodyBytes);
        if (!verifyGithubSignature(body, req.headers["x-hub-signature-256"] as string | undefined, config.githubSecret)) {
          counters.rejected += 1;
          return json(res, 401, { error: "invalid webhook signature" });
        }
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
        const deliveryId = String(req.headers["x-github-delivery"] ?? "");
        const eventName = String(req.headers["x-github-event"] ?? "unknown");
        if (!/^[A-Za-z0-9-]{1,100}$/.test(deliveryId)) return json(res, 400, { error: "missing GitHub delivery id" });
        const inserted = db.recordWebhook(deliveryId, eventName, payload);
        return json(res, inserted ? 202 : 200, { deliveryId, status: inserted ? "accepted" : "duplicate" });
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      const status = Number((error as { statusCode?: number }).statusCode ?? 500);
      if (status >= 500) console.error(error);
      counters.rejected += 1;
      if (!res.headersSent) return json(res, status, { error: status === 500 ? "internal server error" : (error as Error).message });
      res.end();
    }
  });

  return {
    server, db, queue, counters,
    async listen(): Promise<{ host: string; port: number }> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => resolve());
      });
      const address = server.address();
      return { host: config.host, port: typeof address === "object" && address ? address.port : config.port };
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      queue.close();
      await Promise.all(workerTasks);
      db.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const app = createApp();
  const address = await app.listen();
  console.log(`TriageCI listening on http://${address.host}:${address.port}`);
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
