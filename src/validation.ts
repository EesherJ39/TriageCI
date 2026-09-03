import type { TestStatus } from "./analyzer.ts";

export interface TestResult {
  suite: string;
  name: string;
  status: TestStatus;
  durationMs: number;
  failure?: string;
}

export interface RunReport {
  repository: string;
  runId: string;
  attempt: number;
  commitSha: string;
  branch: string;
  startedAt?: string;
  durationMs?: number;
  tests: TestResult[];
}

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[a-fA-F0-9]{7,64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,300}$/;

function cleanText(value: unknown, field: string, max = 300): string {
  if (typeof value !== "string" || !SAFE_TEXT.test(value) || value.length > max) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

export function validateReport(input: unknown, maxTests = 5000): RunReport {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("body must be an object");
  const raw = input as Record<string, unknown>;
  if (typeof raw.repository !== "string" || !REPOSITORY.test(raw.repository)) {
    throw new Error("repository must be owner/name");
  }
  const runId = cleanText(raw.runId, "runId", 160);
  const branch = cleanText(raw.branch, "branch", 200);
  if (typeof raw.commitSha !== "string" || !SHA.test(raw.commitSha)) throw new Error("commitSha is invalid");
  const attempt = Number(raw.attempt ?? 1);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 1000) throw new Error("attempt is invalid");
  if (!Array.isArray(raw.tests) || raw.tests.length < 1 || raw.tests.length > maxTests) {
    throw new Error(`tests must contain 1-${maxTests} results`);
  }
  const tests = raw.tests.map((entry, index): TestResult => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`tests[${index}] is invalid`);
    const test = entry as Record<string, unknown>;
    const status = test.status;
    if (status !== "passed" && status !== "failed" && status !== "skipped") {
      throw new Error(`tests[${index}].status is invalid`);
    }
    const durationMs = Number(test.durationMs ?? 0);
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 86_400_000) {
      throw new Error(`tests[${index}].durationMs is invalid`);
    }
    const failure = test.failure === undefined ? undefined : cleanText(test.failure, `tests[${index}].failure`, 8000);
    return {
      suite: cleanText(test.suite, `tests[${index}].suite`, 300),
      name: cleanText(test.name, `tests[${index}].name`, 300),
      status,
      durationMs,
      failure,
    };
  });
  return {
    repository: raw.repository,
    runId,
    attempt,
    commitSha: raw.commitSha.toLowerCase(),
    branch,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
    durationMs: raw.durationMs === undefined ? undefined : Number(raw.durationMs),
    tests,
  };
}
