#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { formatJobSummary } from "./job-summary.js";
import { CodexRunner } from "./runner.js";
import { JobStore, resolveStateFilePath } from "./store.js";

const usage = `Usage:
  codex-mcp-agy-cli watch --job-id <id> [--timeout <seconds>] [--interval <ms>]
  codex-mcp-agy-cli run --prompt <text> --cwd <dir> [--sandbox <mode>] [--approval <policy>]
                       [--model <name>] [--effort <level>] [--allowed-paths <csv>]`;

function print(job: Parameters<typeof formatJobSummary>[0]): void {
  console.log(JSON.stringify(formatJobSummary(job)));
}

async function watch(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "job-id": { type: "string" },
      timeout: { type: "string", default: "60" },
      interval: { type: "string", default: "250" },
    },
  });
  const jobId = values["job-id"];
  const timeout = Number(values.timeout) * 1000;
  const interval = Number(values.interval);
  if (!jobId || !Number.isFinite(timeout) || timeout < 0 ||
      !Number.isSafeInteger(interval) || interval <= 0 || interval > 2_147_483_647) {
    throw new Error("watch requires --job-id, a nonnegative --timeout and a positive integer --interval");
  }

  const stateFile = resolveStateFilePath();
  const deadline = performance.now() + timeout;
  for (;;) {
    const job = new JobStore(stateFile, false).getJob(jobId);
    if (job && job.status !== "running") {
      print(job);
      return;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      process.exitCode = 2;
      return;
    }
    await setTimeout(Math.min(interval, remaining));
  }
}

const RunFlags = z.object({
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  approval: z.enum(["never", "on-request", "on-failure", "untrusted"]).optional(),
  model: z.string().optional(),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"]).optional(),
  "allowed-paths": z.string().optional(),
});

async function run(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      prompt: { type: "string" },
      cwd: { type: "string" },
      sandbox: { type: "string" },
      approval: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "allowed-paths": { type: "string" },
    },
  });
  const flags = RunFlags.parse(values);
  // A standalone run owns its app-server and must leave the MCP job store available to the MCP process.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-cli-"));
  const runner = new CodexRunner(new JobStore(path.join(dir, "jobs.json")));
  const shutdown = (signal: NodeJS.Signals) => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    void runner.shutdown().catch((err) => console.error(err));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const job = await runner.startJob({
      prompt: flags.prompt,
      workingDirectory: flags.cwd,
      sandboxMode: flags.sandbox,
      approvalPolicy: flags.approval,
      model: flags.model,
      effort: flags.effort,
      allowedPaths: flags["allowed-paths"]?.split(",").map((entry) => entry.trim()).filter(Boolean),
      skipGitRepoCheck: true,
    });
    print(job);
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    try {
      await runner.shutdown();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "watch") await watch(args);
  else if (command === "run") await run(args);
  else if (command === "--help" || command === "-h") console.log(usage);
  else throw new Error(usage);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
