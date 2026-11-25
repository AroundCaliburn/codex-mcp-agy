import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildAdversarialReviewPrompt, buildReviewPrompt } from "./prompts.js";
import { CodexRunner } from "./runner.js";
import { JobStore } from "./store.js";
import type { JobRecord } from "./types.js";

const SandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const ApprovalPolicySchema = z.enum(["never", "on-request", "on-failure", "untrusted"]);
const EffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
]);

function jsonContent(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorContent(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: message }, null, 2),
      },
    ],
  };
}

function formatJobSummary(job: JobRecord) {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    workingDirectory: job.workingDirectory,
    threadId: job.threadId ?? null,
    resumeHint: job.threadId ? `codex resume ${job.threadId}` : null,
    model: job.model ?? "default",
    effort: job.effort ?? "default",
    sandboxMode: job.sandboxMode,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt ?? null,
    durationMs: job.durationMs ?? null,
    progress: job.progress,
    finalResponse: job.finalResponse ?? null,
    itemsSummary: job.itemsSummary ?? null,
    usage: job.usage ?? null,
    gitSummary: job.gitSummary ?? null,
    error: job.error ?? null,
  };
}

export function createServer(): { server: McpServer; runner: CodexRunner } {
  const store = new JobStore();
  store.load();
  const runner = new CodexRunner(store);

  const server = new McpServer({
    name: "codex-mcp-agy",
    version: "0.1.0",
  });

  server.registerTool(
    "codex_run",
    {
      description:
        "Delegate an implementation, debugging, refactoring, or investigation task to Codex via @openai/codex-sdk. Supports synchronous or background execution, thread resumption, and allowedPaths drift checking.",
      inputSchema: {
        prompt: z.string().min(1).describe("Clear, self-contained task specification for Codex."),
        workingDirectory: z
          .string()
          .min(1)
          .describe("Absolute path to the repository or workspace root."),
        sandboxMode: SandboxModeSchema.default("workspace-write").describe(
          "Filesystem sandbox mode: read-only, workspace-write (default), or danger-full-access.",
        ),
        approvalPolicy: ApprovalPolicySchema.default("never").describe(
          "Approval policy for Codex commands (defaults to never for headless MCP calls).",
        ),
        threadId: z
          .string()
          .optional()
          .describe("Existing Codex thread ID to resume for follow-up fixes."),
        resumeLatest: z
          .boolean()
          .optional()
          .describe("If true and threadId is omitted, resume the latest Codex thread for workingDirectory."),
        model: z
          .string()
          .optional()
          .describe("Optional model override (supports alias 'spark' -> 'gpt-5.3-codex-spark')."),
        effort: EffortSchema.optional().describe("Optional reasoning effort override."),
        background: z
          .boolean()
          .default(false)
          .describe("If true, return jobId immediately and run asynchronously."),
        additionalDirectories: z
          .array(z.string())
          .optional()
          .describe("Extra directories writable alongside workingDirectory."),
        skipGitRepoCheck: z
          .boolean()
          .optional()
          .describe("Allow running outside a Git repository."),
        allowedPaths: z
          .array(z.string())
          .optional()
          .describe("Relative paths Codex is expected to touch; any other modified files are flagged in gitSummary.outOfScopeFiles."),
      },
    },
    async (args) => {
      try {
        const job = await runner.startJob({
          kind: "run",
          prompt: args.prompt,
          workingDirectory: args.workingDirectory,
          sandboxMode: args.sandboxMode,
          approvalPolicy: args.approvalPolicy,
          threadId: args.threadId,
          resumeLatest: args.resumeLatest,
          model: args.model,
          effort: args.effort,
          background: args.background,
          additionalDirectories: args.additionalDirectories,
          skipGitRepoCheck: args.skipGitRepoCheck,
          allowedPaths: args.allowedPaths,
        });
        return jsonContent(formatJobSummary(job));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "codex_review",
    {
      description:
        "Run a strict read-only Codex code review on uncommitted changes or against a base Git ref (e.g. main). Always runs in read-only sandbox.",
      inputSchema: {
        workingDirectory: z.string().min(1).describe("Absolute path to the Git repository."),
        baseRef: z
          .string()
          .optional()
          .describe("Optional base Git branch/commit ref to diff against (e.g. 'main')."),
        model: z.string().optional().describe("Optional model override."),
        effort: EffortSchema.optional().describe("Optional reasoning effort override."),
        background: z
          .boolean()
          .default(false)
          .describe("If true, return jobId immediately and run asynchronously."),
      },
    },
    async (args) => {
      try {
        const job = await runner.startJob({
          kind: "review",
          prompt: buildReviewPrompt({ baseRef: args.baseRef }),
          workingDirectory: args.workingDirectory,
          sandboxMode: "read-only",
          approvalPolicy: "never",
          model: args.model,
          effort: args.effort,
          background: args.background,
        });
        return jsonContent(formatJobSummary(job));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "codex_adversarial_review",
    {
      description:
        "Run a steerable, read-only adversarial review that challenges design assumptions, tradeoffs, failure modes, and race conditions.",
      inputSchema: {
        workingDirectory: z.string().min(1).describe("Absolute path to the Git repository."),
        focus: z
          .string()
          .optional()
          .describe("Specific risk area or design decision to pressure-test."),
        baseRef: z
          .string()
          .optional()
          .describe("Optional base Git branch/commit ref to diff against."),
        model: z.string().optional().describe("Optional model override."),
        effort: EffortSchema.optional().describe("Optional reasoning effort override."),
        background: z
          .boolean()
          .default(false)
          .describe("If true, return jobId immediately and run asynchronously."),
      },
    },
    async (args) => {
      try {
        const job = await runner.startJob({
          kind: "adversarial_review",
          prompt: buildAdversarialReviewPrompt({
            baseRef: args.baseRef,
            focus: args.focus,
          }),
          workingDirectory: args.workingDirectory,
          sandboxMode: "read-only",
          approvalPolicy: "never",
          model: args.model,
          effort: args.effort,
          background: args.background,
        });
        return jsonContent(formatJobSummary(job));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "codex_status",
    {
      description:
        "Check status and live progress of running or recent Codex jobs (optionally filtered by jobId or workingDirectory).",
      inputSchema: {
        jobId: z.string().optional().describe("Specific job ID to inspect."),
        workingDirectory: z.string().optional().describe("Filter jobs by repository path."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Maximum number of jobs to return when jobId is omitted."),
      },
    },
    async (args) => {
      try {
        if (args.jobId) {
          const job = store.getJob(args.jobId);
          if (!job) {
            return errorContent(new Error(`Job not found: ${args.jobId}`));
          }
          return jsonContent({
            jobId: job.jobId,
            kind: job.kind,
            status: job.status,
            workingDirectory: job.workingDirectory,
            threadId: job.threadId ?? null,
            createdAt: job.createdAt,
            finishedAt: job.finishedAt ?? null,
            durationMs: job.durationMs ?? null,
            progress: job.progress,
            error: job.error ?? null,
          });
        }

        const jobs = store.listJobs({
          workingDirectory: args.workingDirectory,
          limit: args.limit,
        });

        return jsonContent({
          count: jobs.length,
          jobs: jobs.map((j) => ({
            jobId: j.jobId,
            kind: j.kind,
            status: j.status,
            workingDirectory: j.workingDirectory,
            threadId: j.threadId ?? null,
            promptPreview: j.promptPreview,
            createdAt: j.createdAt,
            finishedAt: j.finishedAt ?? null,
            durationMs: j.durationMs ?? null,
            lastProgress: j.progress[j.progress.length - 1] ?? null,
          })),
        });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "codex_result",
    {
      description:
        "Retrieve the full stored result, threadId (with codex resume hint), usage, and git diff summary of a finished Codex job.",
      inputSchema: {
        jobId: z
          .string()
          .optional()
          .describe("Specific job ID; if omitted, returns the latest finished job (optionally scoped to workingDirectory)."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Repository path used to find the latest finished job when jobId is omitted."),
      },
    },
    async (args) => {
      try {
        const job = args.jobId
          ? store.getJob(args.jobId)
          : store.getLatestFinishedJob(args.workingDirectory);

        if (!job) {
          return errorContent(
            new Error(
              args.jobId
                ? `Job not found: ${args.jobId}`
                : "No finished Codex job found",
            ),
          );
        }

        return jsonContent(formatJobSummary(job));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "codex_cancel",
    {
      description: "Cancel an active background Codex job by jobId or workingDirectory.",
      inputSchema: {
        jobId: z.string().optional().describe("Job ID to cancel."),
        workingDirectory: z
          .string()
          .optional()
          .describe("If jobId is omitted, cancels the newest running job in this directory."),
      },
    },
    async (args) => {
      try {
        const res = runner.cancelJob({
          jobId: args.jobId,
          workingDirectory: args.workingDirectory,
        });
        return jsonContent({
          cancelled: res.cancelled,
          reason: res.reason ?? null,
          job: res.job ? formatJobSummary(res.job) : null,
        });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "codex_health",
    {
      description:
        "Check Codex CLI availability, auth file presence (never exposes secrets), and job store status.",
      inputSchema: {},
    },
    async () => {
      try {
        const health = await runner.checkHealth();
        return jsonContent(health);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  return { server, runner };
}

async function main() {
  const { server, runner } = createServer();
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    runner.abortAll();
    try {
      await server.close();
    } catch {
      // ignore close errors during shutdown
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
}

main().catch((err) => {
  console.error("[codex-mcp-agy] Fatal startup error:", err);
  process.exit(1);
});
