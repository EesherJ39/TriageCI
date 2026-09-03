import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { emptyStats, failureSignature, updateStats, type TestStats, type TestStatus } from "./analyzer.ts";
import type { RunReport } from "./validation.ts";

export class TriageDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL,
        received_at TEXT NOT NULL, completed_at TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, repository TEXT NOT NULL, run_key TEXT NOT NULL,
        attempt INTEGER NOT NULL, commit_sha TEXT NOT NULL, branch TEXT NOT NULL,
        received_at TEXT NOT NULL, duration_ms REAL NOT NULL,
        total INTEGER NOT NULL, passed INTEGER NOT NULL, failed INTEGER NOT NULL, skipped INTEGER NOT NULL,
        UNIQUE(repository, run_key, attempt)
      );
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        repository TEXT NOT NULL, commit_sha TEXT NOT NULL, test_key TEXT NOT NULL,
        suite TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
        duration_ms REAL NOT NULL, failure_signature TEXT, failure_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_observations_test ON observations(repository, test_key, id);
      CREATE INDEX IF NOT EXISTS idx_observations_commit ON observations(repository, test_key, commit_sha, status);
      CREATE TABLE IF NOT EXISTS test_stats (
        repository TEXT NOT NULL, test_key TEXT NOT NULL, suite TEXT NOT NULL, name TEXT NOT NULL,
        total_runs INTEGER NOT NULL, passes INTEGER NOT NULL, failures INTEGER NOT NULL,
        skips INTEGER NOT NULL, transitions INTEGER NOT NULL, last_status TEXT,
        failure_streak INTEGER NOT NULL,
        last_commit TEXT NOT NULL, flake_score REAL NOT NULL, state TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY(repository, test_key)
      );
      CREATE INDEX IF NOT EXISTS idx_test_stats_state ON test_stats(repository, state, flake_score DESC);
      CREATE TABLE IF NOT EXISTS webhook_events (
        delivery_id TEXT PRIMARY KEY, event_name TEXT NOT NULL, action TEXT,
        repository TEXT, received_at TEXT NOT NULL
      );
    `);
  }

  reserveDelivery(id: string, digest: string): "reserved" | "duplicate" | "conflict" {
    const existing = this.db.prepare("SELECT digest FROM deliveries WHERE id = ?").get(id) as { digest: string } | undefined;
    if (existing) return existing.digest === digest ? "duplicate" : "conflict";
    this.db.prepare("INSERT INTO deliveries(id,digest,status,received_at) VALUES(?,?,?,?)")
      .run(id, digest, "queued", new Date().toISOString());
    return "reserved";
  }

  delivery(id: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT id,status,received_at AS receivedAt,completed_at AS completedAt,error FROM deliveries WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
  }

  markDelivery(id: string, status: "completed" | "failed", error?: string): void {
    this.db.prepare("UPDATE deliveries SET status=?,completed_at=?,error=? WHERE id=?")
      .run(status, new Date().toISOString(), error ?? null, id);
  }

  ingest(report: RunReport): { duplicateRun: boolean; observations: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT id FROM runs WHERE repository=? AND run_key=? AND attempt=?")
        .get(report.repository, report.runId, report.attempt) as { id: number } | undefined;
      if (existing) {
        this.db.exec("ROLLBACK");
        return { duplicateRun: true, observations: 0 };
      }

      let passed = 0, failed = 0, skipped = 0;
      for (const test of report.tests) {
        if (test.status === "passed") passed += 1;
        if (test.status === "failed") failed += 1;
        if (test.status === "skipped") skipped += 1;
      }
      const run = this.db.prepare(`INSERT INTO runs(
        repository,run_key,attempt,commit_sha,branch,received_at,duration_ms,total,passed,failed,skipped
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        report.repository, report.runId, report.attempt, report.commitSha, report.branch,
        new Date().toISOString(), report.durationMs ?? 0, report.tests.length, passed, failed, skipped,
      );
      const runId = Number(run.lastInsertRowid);
      const insertObservation = this.db.prepare(`INSERT INTO observations(
        run_id,repository,commit_sha,test_key,suite,name,status,duration_ms,failure_signature,failure_message
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`);
      const readStats = this.db.prepare("SELECT * FROM test_stats WHERE repository=? AND test_key=?");
      const commitStatuses = this.db.prepare(`SELECT
        SUM(CASE WHEN status='passed' THEN 1 ELSE 0 END) AS passes,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failures
        FROM observations WHERE repository=? AND test_key=? AND commit_sha=?`);
      const upsertStats = this.db.prepare(`INSERT INTO test_stats(
        repository,test_key,suite,name,total_runs,passes,failures,skips,transitions,last_status,failure_streak,
        last_commit,flake_score,state,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(repository,test_key) DO UPDATE SET
        suite=excluded.suite,name=excluded.name,total_runs=excluded.total_runs,passes=excluded.passes,
        failures=excluded.failures,skips=excluded.skips,transitions=excluded.transitions,
        last_status=excluded.last_status,failure_streak=excluded.failure_streak,last_commit=excluded.last_commit,
        flake_score=excluded.flake_score,state=excluded.state,updated_at=excluded.updated_at`);

      for (const test of report.tests) {
        const testKey = `${test.suite}::${test.name}`;
        insertObservation.run(
          runId, report.repository, report.commitSha, testKey, test.suite, test.name,
          test.status, test.durationMs, failureSignature(test.failure), test.failure ?? null,
        );
        const row = readStats.get(report.repository, testKey) as Record<string, unknown> | undefined;
        const current: TestStats = row ? {
          totalRuns: Number(row.total_runs), passes: Number(row.passes), failures: Number(row.failures),
          skips: Number(row.skips), transitions: Number(row.transitions), failureStreak: Number(row.failure_streak),
          lastStatus: row.last_status as TestStatus, flakeScore: Number(row.flake_score), state: row.state as TestStats["state"],
        } : emptyStats();
        const commit = commitStatuses.get(report.repository, testKey, report.commitSha) as { passes: number; failures: number };
        const mixed = Number(commit.passes) > 0 && Number(commit.failures) > 0;
        const next = updateStats(current, test.status, mixed);
        upsertStats.run(
          report.repository, testKey, test.suite, test.name, next.totalRuns, next.passes,
          next.failures, next.skips, next.transitions, next.lastStatus, next.failureStreak, report.commitSha,
          next.flakeScore, next.state, new Date().toISOString(),
        );
      }
      this.db.exec("COMMIT");
      return { duplicateRun: false, observations: report.tests.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordWebhook(deliveryId: string, eventName: string, body: Record<string, unknown>): boolean {
    const repository = (body.repository as Record<string, unknown> | undefined)?.full_name;
    const action = typeof body.action === "string" ? body.action : null;
    const result = this.db.prepare(`INSERT OR IGNORE INTO webhook_events(
      delivery_id,event_name,action,repository,received_at
    ) VALUES(?,?,?,?,?)`).run(deliveryId, eventName, action, typeof repository === "string" ? repository : null, new Date().toISOString());
    return result.changes === 1;
  }

  summary(repository: string): Record<string, unknown> {
    const totals = this.db.prepare(`SELECT COUNT(*) AS tests,
      SUM(CASE WHEN state='flaky' THEN 1 ELSE 0 END) AS flaky,
      SUM(CASE WHEN state='regression' THEN 1 ELSE 0 END) AS regressions,
      SUM(CASE WHEN state='consistently-failing' THEN 1 ELSE 0 END) AS failing,
      SUM(total_runs) AS observations FROM test_stats WHERE repository=?`).get(repository) as Record<string, unknown>;
    const runs = this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE repository=?").get(repository) as { count: number };
    const topFlaky = this.db.prepare(`SELECT suite,name,total_runs AS totalRuns,passes,failures,transitions,
      flake_score AS flakeScore,state,updated_at AS updatedAt
      FROM test_stats WHERE repository=? AND state='flaky'
      ORDER BY flake_score DESC,total_runs DESC LIMIT 20`).all(repository);
    const clusters = this.db.prepare(`SELECT failure_signature AS signature,COUNT(*) AS occurrences,
      COUNT(DISTINCT test_key) AS affectedTests,MAX(failure_message) AS example
      FROM observations WHERE repository=? AND failure_signature IS NOT NULL
      GROUP BY failure_signature ORDER BY occurrences DESC LIMIT 10`).all(repository);
    return {
      repository,
      runs: Number(runs.count),
      tests: Number(totals.tests ?? 0),
      flaky: Number(totals.flaky ?? 0),
      regressions: Number(totals.regressions ?? 0),
      consistentlyFailing: Number(totals.failing ?? 0),
      observations: Number(totals.observations ?? 0),
      topFlaky,
      failureClusters: clusters,
    };
  }

  tests(repository: string, state?: string): unknown[] {
    if (state) {
      return this.db.prepare(`SELECT suite,name,total_runs AS totalRuns,passes,failures,skips,transitions,
        failure_streak AS failureStreak,flake_score AS flakeScore,state,last_commit AS lastCommit,updated_at AS updatedAt
        FROM test_stats WHERE repository=? AND state=? ORDER BY flake_score DESC,total_runs DESC LIMIT 500`)
        .all(repository, state);
    }
    return this.db.prepare(`SELECT suite,name,total_runs AS totalRuns,passes,failures,skips,transitions,
      failure_streak AS failureStreak,flake_score AS flakeScore,state,last_commit AS lastCommit,updated_at AS updatedAt
      FROM test_stats WHERE repository=? ORDER BY flake_score DESC,total_runs DESC LIMIT 500`)
      .all(repository);
  }

  counts(): { runs: number; observations: number; tests: number; deliveries: number } {
    const count = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    return { runs: count("runs"), observations: count("observations"), tests: count("test_stats"), deliveries: count("deliveries") };
  }

  close(): void {
    this.db.close();
  }
}
