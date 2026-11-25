import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findOutOfScopeFiles, normalizeRelativePath } from "../src/git.js";
import { buildAdversarialReviewPrompt, buildReviewPrompt } from "../src/prompts.js";
import { resolveModelAlias } from "../src/runner.js";
import { JobStore } from "../src/store.js";
import type { JobRecord } from "../src/types.js";

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  const now = new Date().toISOString();
  return {
    jobId: `job-${Math.random().toString(36).slice(2, 8)}`,
    kind: "run",
    status: "completed",
    workingDirectory: "/tmp/repo-a",
    promptPreview: "test prompt",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    createdAt: now,
    startedAt: now,
    progress: [],
    ...overrides,
  };
}

test("JobStore persists, recovers interrupted running jobs, and scopes latest threadId", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-store-"));
  const stateFile = path.join(tmpDir, "jobs.json");

  try {
    const store1 = new JobStore(stateFile);
    store1.createJob(
      makeJob({
        jobId: "j-run-1",
        status: "running",
        workingDirectory: "/tmp/repo-a",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    store1.createJob(
      makeJob({
        jobId: "j-done-a",
        status: "completed",
        workingDirectory: "/tmp/repo-a",
        threadId: "thread-a-1",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    store1.createJob(
      makeJob({
        jobId: "j-done-b",
        status: "completed",
        workingDirectory: "/tmp/repo-b",
        threadId: "thread-b-1",
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );

    const store2 = new JobStore(stateFile);
    store2.load();

    const recovered = store2.getJob("j-run-1");
    assert.equal(recovered?.status, "interrupted");
    assert.match(recovered?.error ?? "", /restarted/i);

    assert.equal(store2.getLatestThreadId("/tmp/repo-a"), "thread-a-1");
    assert.equal(store2.getLatestThreadId("/tmp/repo-b"), "thread-b-1");
    assert.equal(store2.getLatestThreadId("/tmp/repo-c"), undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("JobStore prunes old finished jobs beyond 50", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-prune-"));
  const stateFile = path.join(tmpDir, "jobs.json");

  try {
    const store = new JobStore(stateFile);
    for (let i = 0; i < 55; i++) {
      store.createJob(
        makeJob({
          jobId: `j-${i}`,
          createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        }),
      );
    }
    const jobs = store.listJobs();
    assert.equal(jobs.length, 50);
    assert.equal(jobs[0]?.jobId, "j-54");
    assert.equal(jobs[49]?.jobId, "j-5");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("findOutOfScopeFiles normalizes paths and detects drift", () => {
  assert.equal(normalizeRelativePath("./src/runner.ts/"), "src/runner.ts");

  const out = findOutOfScopeFiles(
    ["src/runner.ts", "src/sub/helper.ts", "README.md", "tests/unit.test.ts"],
    ["./src/", "tests/unit.test.ts"],
  );
  assert.deepEqual(out, ["README.md"]);

  assert.deepEqual(findOutOfScopeFiles(["README.md"], undefined), []);
});

test("prompt builders include read-only constraints, baseRef, and focus", () => {
  const reviewUncommitted = buildReviewPrompt({});
  assert.match(reviewUncommitted, /Do NOT modify/i);
  assert.match(reviewUncommitted, /uncommitted/i);

  const reviewBase = buildReviewPrompt({ baseRef: "main" });
  assert.match(reviewBase, /git diff main\.\.\.HEAD/);

  const adv = buildAdversarialReviewPrompt({ baseRef: "dev", focus: "race conditions" });
  assert.match(adv, /Do NOT modify/i);
  assert.match(adv, /dev\.\.\.HEAD/);
  assert.match(adv, /race conditions/);
});

test("resolveModelAlias maps spark and passes through others", () => {
  assert.equal(resolveModelAlias("spark"), "gpt-5.3-codex-spark");
  assert.equal(resolveModelAlias("gpt-5.4"), "gpt-5.4");
  assert.equal(resolveModelAlias(""), undefined);
  assert.equal(resolveModelAlias(undefined), undefined);
});
