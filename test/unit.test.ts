import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { AppServerClient, resolveCodexCommand } from "../src/app-server.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { findOutOfScopeFiles, normalizeRelativePath } from "../src/git.js";
import { buildAdversarialReviewPrompt, buildReviewPrompt } from "../src/prompts.js";
import { CodexRunner, resolveModelAlias } from "../src/runner.js";
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

test("JobStore persists, recovers interrupted active jobs, and scopes latest threadId", () => {
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

    for (const status of ["waiting_approval", "waiting_input"] as const) {
      store1.createJob(makeJob({
        jobId: status, status,
        pendingRequest: {
          requestId: 1, method: "fixture", kind: status === "waiting_input" ? "user_input" : "command_approval",
          summary: "pending", details: {}, createdAt: new Date().toISOString(),
        },
      }));
    }

    const store2 = new JobStore(stateFile);
    store2.load();

    const recovered = store2.getJob("j-run-1");
    assert.equal(recovered?.status, "interrupted");
    assert.match(recovered?.error ?? "", /restarted/i);
    for (const status of ["waiting_approval", "waiting_input"]) {
      const job = store2.getJob(status);
      assert.equal(job?.status, "interrupted");
      assert.equal(job?.pendingRequest, undefined);
      assert.ok(job?.finishedAt);
    }

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

const mockServer = fileURLToPath(new URL("../../test/fixtures/mock-app-server.mjs", import.meta.url));

test("app-server reconnects and reinitializes after an exit", { timeout: 5000 }, async (t) => {
  const client = new AppServerClient({}, mockServer);
  t.after(() => client.shutdown());
  assert.deepEqual(await client.request("thread/start", {}), { thread: { id: "fixture-thread" } });
  await assert.rejects(client.request("fixture/exit"), /exited/);
  assert.deepEqual(await client.request("thread/start", {}), { thread: { id: "fixture-thread" } });
});

function makeRunnerFixture(t: TestContext, requestTimeoutMs?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-runner-"));
  const store = new JobStore(path.join(dir, "jobs.json"));
  const runner = new CodexRunner(store, { binary: mockServer, requestTimeoutMs });
  t.after(async () => {
    await runner.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { runner, store, options: { workingDirectory: dir, skipGitRepoCheck: true } };
}

test("runner handles framed approval and input requests, steering, and paused cancellation", { timeout: 5000 }, async (t) => {
  const { runner, options } = makeRunnerFixture(t);
  const approval = await runner.startJob({ ...options, prompt: "approve then answer" });
  const { jobId } = approval;
  assert.equal(approval.status, "waiting_approval");
  assert.equal(approval.pendingRequest?.requestId, "approval-1");
  assert.ok(approval.turnId);
  await assert.rejects(runner.steerJob({ jobId, prompt: "too early" }), /running turn/);
  await assert.rejects(runner.respondToJob({ jobId, answers: {} }), /approval decision/);
  const input = await runner.respondToJob({ jobId, decision: "accept", wait: true });
  assert.equal(input.status, "waiting_input");
  assert.equal(input.pendingRequest?.requestId, 42);

  const finished = runner.respondToJob({ jobId, answers: { color: ["blue"] }, wait: true });
  assert.equal((await runner.steerJob({ jobId, prompt: "more instructions" })).jobId, jobId);
  const completed = await finished;
  assert.equal(completed.status, "completed");
  assert.equal(completed.pendingRequest, undefined);
  assert.equal(completed.finalResponse, "blue");

  const paused = await runner.startJob({ ...options, prompt: "cancel while paused", resumeLatest: true });
  assert.equal(paused.pendingRequest?.kind, "file_approval");
  const cancelled = await runner.cancelJob({ jobId: paused.jobId });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.job?.status, "cancelled");
  assert.equal(cancelled.job?.pendingRequest, undefined);
});

test("runner requires the current requestId when approvals are queued and checks its type", { timeout: 5000 }, async (t) => {
  const { runner, options } = makeRunnerFixture(t);
  const first = await runner.startJob({ ...options, prompt: "queue approvals" });
  const { jobId } = first;
  assert.equal(first.pendingRequest?.requestId, 7);
  await assert.rejects(runner.respondToJob({ jobId, decision: "accept" }), /multiple pending requests.*requestId/);
  await assert.rejects(runner.respondToJob({ jobId, requestId: "7", decision: "accept" }), /does not match/);

  const second = await runner.respondToJob({ jobId, requestId: 7, decision: "accept", wait: true });
  assert.equal(second.pendingRequest?.requestId, "7");
  await assert.rejects(runner.respondToJob({ jobId, requestId: 7, decision: "accept" }), /does not match/);
  const finished = await runner.respondToJob({ jobId, requestId: "7", decision: "decline", wait: true });
  assert.equal(finished.status, "completed");
});

test("a delayed turn/start acknowledgement fails the job and recycles the app-server", { timeout: 5000 }, async (t) => {
  const { runner, options, store } = makeRunnerFixture(t, 750);
  const failed = await runner.startJob({ ...options, prompt: "delay turn acknowledgment" });
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /timed out: turn\/start/);
  assert.deepEqual(store.getActiveJobs(), []);

  const next = await runner.startJob({ ...options, prompt: "Reply with exactly: CODEX_MCP_OK" });
  assert.equal(next.status, "completed");
  assert.equal(next.turnId, "fixture-turn-1");
});

test("a pause write failure cancels the remote request and settles the local waiter", { timeout: 5000 }, async (t) => {
  const { runner, options, store } = makeRunnerFixture(t);
  const updateJob = store.updateJob.bind(store);
  t.mock.method(store, "updateJob", (jobId: string, update: (job: JobRecord) => JobRecord) =>
    updateJob(jobId, (job) => {
      const next = update(job);
      if (next.status === "waiting_approval") throw new Error("disk full");
      return next;
    }),
  );
  const failed = await runner.startJob({ ...options, prompt: "pause write failure" });
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /pending request state: disk full/);
  assert.equal(failed.pendingRequest, undefined);
  assert.deepEqual(store.getActiveJobs(), []);
  const next = await runner.startJob({ ...options, prompt: "verify pause cancellation" });
  assert.equal(next.status, "completed");
  assert.equal(next.turnId, "fixture-turn-2");
});

test("Codex command resolution prefers overrides and PATH, then uses the bundled launcher", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-path-"));
  const oldPath = process.env.PATH;
  const oldOverride = process.env.CODEX_PATH_OVERRIDE;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldOverride === undefined) delete process.env.CODEX_PATH_OVERRIDE;
    else process.env.CODEX_PATH_OVERRIDE = oldOverride;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.PATH = dir;
  process.env.CODEX_PATH_OVERRIDE = mockServer;
  assert.equal(resolveCodexCommand().command, mockServer);
  delete process.env.CODEX_PATH_OVERRIDE;
  const executable = path.join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "", { mode: 0o755 });
  assert.equal(resolveCodexCommand().command, executable);
  fs.unlinkSync(executable);
  const bundled = resolveCodexCommand();
  assert.equal(bundled.command, process.execPath);
  assert.match(bundled.binary, /codex\.js$/);
  assert.deepEqual(bundled.args, [bundled.binary]);
});

test("CLI watch reloads updates without recovering the live job and exits 2 on timeout", { timeout: 5000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-watch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, "jobs.json");
  const store = new JobStore(stateFile);
  const { jobId } = store.createJob(makeJob({ status: "running" }));
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const watch = (timeout: string) => promisify(execFile)(
    process.execPath, [cli, "watch", "--job-id", jobId, "--interval", "10", "--timeout", timeout],
    { env: { ...process.env, CODEX_MCP_STATE_FILE: stateFile } },
  );
  await assert.rejects(watch("0"), { code: 2, stdout: "" });
  const result = watch("2");
  await setTimeout(150);
  assert.equal(new JobStore(stateFile, false).getJob(jobId)?.status, "running");
  store.updateJob(jobId, (job) => ({ ...job, status: "waiting_input" }));
  assert.equal(JSON.parse((await result).stdout).status, "waiting_input");
});
