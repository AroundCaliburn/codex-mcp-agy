import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";
import { inspectGitWorkspace } from "./git.js";
import { JobStore } from "./store.js";
import type { ItemsSummary, JobKind, JobRecord, RunOptions } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_PROGRESS_LINES = 15;
const PROMPT_PREVIEW_LIMIT = 240;

const MODEL_ALIASES: Record<string, string> = {
  spark: "gpt-5.3-codex-spark",
};

export function resolveModelAlias(model?: string): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  return MODEL_ALIASES[trimmed] ?? trimmed;
}

function truncateText(text: string, maxLen: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen - 3)}...`;
}

function appendProgress(current: string[], line: string): string[] {
  const next = [...current, line];
  if (next.length > MAX_PROGRESS_LINES) {
    return next.slice(next.length - MAX_PROGRESS_LINES);
  }
  return next;
}

function summarizeCompletedItem(item: ThreadItem, summary: ItemsSummary): string | undefined {
  switch (item.type) {
    case "agent_message":
      return `agent: ${truncateText(item.text, 120)}`;
    case "command_execution":
      summary.commands.push({
        command: item.command,
        exitCode: item.exit_code,
        status: item.status,
      });
      return `cmd (${item.status}${item.exit_code !== undefined ? `:${item.exit_code}` : ""}): ${truncateText(item.command, 100)}`;
    case "file_change":
      for (const ch of item.changes) {
        summary.fileChanges.push({ path: ch.path, kind: ch.kind, status: item.status });
      }
      return `files (${item.status}): ${item.changes.map((c) => `${c.kind}:${c.path}`).join(", ")}`;
    case "mcp_tool_call":
      summary.mcpToolCalls.push({
        server: item.server,
        tool: item.tool,
        status: item.status,
      });
      return `mcp (${item.status}): ${item.server}.${item.tool}`;
    case "web_search":
      summary.webSearches.push(item.query);
      return `search: ${truncateText(item.query, 80)}`;
    case "error":
      return `error: ${truncateText(item.message, 120)}`;
    case "todo_list":
    case "reasoning":
      return undefined;
  }
}

export class CodexRunner {
  private readonly store: JobStore;
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(store: JobStore) {
    this.store = store;
  }

  getStore(): JobStore {
    return this.store;
  }

  private createCodexClient(): Codex {
    const options: CodexOptions = {};
    const override = process.env.CODEX_PATH_OVERRIDE?.trim();
    if (override) {
      options.codexPathOverride = override;
    }
    return new Codex(options);
  }

  async startJob(options: RunOptions): Promise<JobRecord> {
    const workingDirectory = path.resolve(options.workingDirectory);
    if (!fs.existsSync(workingDirectory)) {
      throw new Error(`Working directory does not exist: ${workingDirectory}`);
    }

    const kind: JobKind = options.kind ?? "run";
    const sandboxMode = options.sandboxMode ?? "workspace-write";
    const approvalPolicy = options.approvalPolicy ?? "never";
    const resolvedModel = resolveModelAlias(options.model);
    const now = new Date().toISOString();
    const jobId = `codex-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;

    let resumeThreadId = options.threadId?.trim() || undefined;
    if (!resumeThreadId && options.resumeLatest) {
      resumeThreadId = this.store.getLatestThreadId(workingDirectory);
    }

    const initialJob: JobRecord = {
      jobId,
      kind,
      status: "running",
      workingDirectory,
      promptPreview: truncateText(options.prompt, PROMPT_PREVIEW_LIMIT),
      model: resolvedModel,
      effort: options.effort,
      sandboxMode,
      approvalPolicy,
      allowedPaths: options.allowedPaths,
      threadId: resumeThreadId,
      createdAt: now,
      startedAt: now,
      progress: [
        resumeThreadId
          ? `Resuming thread ${resumeThreadId} in ${sandboxMode} mode`
          : `Starting new thread in ${sandboxMode} mode`,
      ],
    };

    this.store.createJob(initialJob);

    const controller = new AbortController();
    this.activeControllers.set(jobId, controller);

    const runPromise = this.executeInternal(jobId, {
      ...options,
      workingDirectory,
      sandboxMode,
      approvalPolicy,
      model: resolvedModel,
      threadId: resumeThreadId,
    }, controller);

    if (options.background) {
      runPromise.catch((err) => {
        console.error(`[codex-mcp-agy] Background job ${jobId} failed unexpectedly:`, err);
      });
      return this.store.getJob(jobId) ?? initialJob;
    }

    return await runPromise;
  }

  private async executeInternal(
    jobId: string,
    options: RunOptions & {
      sandboxMode: NonNullable<RunOptions["sandboxMode"]>;
      approvalPolicy: NonNullable<RunOptions["approvalPolicy"]>;
    },
    controller: AbortController,
  ): Promise<JobRecord> {
    const startMs = Date.now();
    const itemsSummary: ItemsSummary = {
      commands: [],
      fileChanges: [],
      mcpToolCalls: [],
      webSearches: [],
    };
    let finalResponse = "";
    let usage: Usage | null = null;
    let streamError: string | undefined;

    try {
      const codex = this.createCodexClient();
      const threadOptions: ThreadOptions = {
        workingDirectory: options.workingDirectory,
        sandboxMode: options.sandboxMode,
        approvalPolicy: options.approvalPolicy,
        skipGitRepoCheck: options.skipGitRepoCheck ?? false,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { modelReasoningEffort: options.effort } : {}),
        ...(options.additionalDirectories?.length
          ? { additionalDirectories: options.additionalDirectories.map((d) => path.resolve(d)) }
          : {}),
      };

      const thread = options.threadId
        ? codex.resumeThread(options.threadId, threadOptions)
        : codex.startThread(threadOptions);

      const { events } = await thread.runStreamed(options.prompt, {
        signal: controller.signal,
      });

      for await (const event of events as AsyncGenerator<ThreadEvent>) {
        if (controller.signal.aborted) {
          break;
        }

        switch (event.type) {
          case "thread.started":
            this.store.updateJob(jobId, (cur) => ({
              ...cur,
              threadId: event.thread_id,
              progress: appendProgress(cur.progress, `thread.started: ${event.thread_id}`),
            }));
            break;

          case "item.completed": {
            if (event.item.type === "agent_message") {
              finalResponse = event.item.text;
            }
            const line = summarizeCompletedItem(event.item, itemsSummary);
            if (line) {
              this.store.updateJob(jobId, (cur) => ({
                ...cur,
                progress: appendProgress(cur.progress, line),
              }));
            }
            break;
          }

          case "turn.completed":
            usage = event.usage;
            break;

          case "turn.failed":
            streamError = event.error.message;
            break;

          case "error":
            streamError = event.message;
            break;

          case "turn.started":
          case "item.started":
          case "item.updated":
            break;
        }
      }

      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startMs;

      if (controller.signal.aborted) {
        return (
          this.store.updateJob(jobId, (cur) => ({
            ...cur,
            status: "cancelled",
            finishedAt,
            durationMs,
            finalResponse: finalResponse || cur.finalResponse,
            itemsSummary,
            usage,
            progress: appendProgress(cur.progress, "Job cancelled"),
          })) ?? this.store.getJob(jobId)!
        );
      }

      if (streamError) {
        return (
          this.store.updateJob(jobId, (cur) => ({
            ...cur,
            status: "failed",
            finishedAt,
            durationMs,
            finalResponse: finalResponse || undefined,
            itemsSummary,
            usage,
            error: streamError,
            progress: appendProgress(cur.progress, `Failed: ${truncateText(streamError!, 120)}`),
          })) ?? this.store.getJob(jobId)!
        );
      }

      const gitSummary =
        (options.kind ?? "run") === "run"
          ? await inspectGitWorkspace(options.workingDirectory, options.allowedPaths)
          : undefined;

      return (
        this.store.updateJob(jobId, (cur) => ({
          ...cur,
          status: "completed",
          threadId: cur.threadId ?? thread.id ?? undefined,
          finishedAt,
          durationMs,
          finalResponse,
          itemsSummary,
          usage,
          gitSummary,
          progress: appendProgress(cur.progress, `Completed in ${durationMs}ms`),
        })) ?? this.store.getJob(jobId)!
      );
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startMs;
      const message = err instanceof Error ? err.message : String(err);

      if (controller.signal.aborted) {
        return (
          this.store.updateJob(jobId, (cur) => ({
            ...cur,
            status: "cancelled",
            finishedAt,
            durationMs,
            finalResponse: finalResponse || cur.finalResponse,
            itemsSummary,
            usage,
            progress: appendProgress(cur.progress, "Job cancelled"),
          })) ?? this.store.getJob(jobId)!
        );
      }

      return (
        this.store.updateJob(jobId, (cur) => ({
          ...cur,
          status: "failed",
          finishedAt,
          durationMs,
          finalResponse: finalResponse || undefined,
          itemsSummary,
          usage,
          error: message,
          progress: appendProgress(cur.progress, `Error: ${truncateText(message, 120)}`),
        })) ?? this.store.getJob(jobId)!
      );
    } finally {
      this.activeControllers.delete(jobId);
    }
  }

  cancelJob(options: { jobId?: string; workingDirectory?: string }): {
    cancelled: boolean;
    job?: JobRecord;
    reason?: string;
  } {
    let target: JobRecord | undefined;
    if (options.jobId) {
      target = this.store.getJob(options.jobId);
    } else {
      target = this.store.getRunningJobs(options.workingDirectory)[0];
    }

    if (!target) {
      return {
        cancelled: false,
        reason: options.jobId
          ? `Job not found: ${options.jobId}`
          : "No active running job found",
      };
    }

    const controller = this.activeControllers.get(target.jobId);
    if (!controller) {
      return {
        cancelled: false,
        job: target,
        reason: `Job ${target.jobId} is not actively running in this server process (status: ${target.status})`,
      };
    }

    controller.abort();
    const updated = this.store.updateJob(target.jobId, (cur) => ({
      ...cur,
      status: "cancelled",
      finishedAt: cur.finishedAt ?? new Date().toISOString(),
      progress: appendProgress(cur.progress, "Cancellation requested"),
    }));

    return {
      cancelled: true,
      job: updated ?? target,
    };
  }

  abortAll(): void {
    for (const [jobId, controller] of this.activeControllers.entries()) {
      controller.abort();
      this.store.updateJob(jobId, (cur) => ({
        ...cur,
        status: "cancelled",
        finishedAt: cur.finishedAt ?? new Date().toISOString(),
        progress: appendProgress(cur.progress, "Aborted due to server shutdown"),
      }));
    }
    this.activeControllers.clear();
  }

  async checkHealth(): Promise<Record<string, unknown>> {
    const codexBin = process.env.CODEX_PATH_OVERRIDE?.trim() || "codex";
    let cliAvailable = false;
    let cliVersion: string | null = null;
    let cliError: string | null = null;

    try {
      const { stdout } = await execFileAsync(codexBin, ["--version"], { timeout: 5000 });
      cliAvailable = true;
      cliVersion = stdout.trim();
    } catch (err) {
      cliError = err instanceof Error ? err.message : String(err);
    }

    const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    const authJsonExists = fs.existsSync(path.join(codexHome, "auth.json"));
    const configTomlExists = fs.existsSync(path.join(codexHome, "config.toml"));
    const hasApiKeyEnv = Boolean(
      process.env.OPENAI_API_KEY?.trim() || process.env.CODEX_API_KEY?.trim(),
    );

    const jobs = this.store.listJobs();
    const runningCount = jobs.filter((j) => j.status === "running").length;

    return {
      ok: cliAvailable && (authJsonExists || hasApiKeyEnv),
      nodeVersion: process.version,
      codexCli: {
        binary: codexBin,
        available: cliAvailable,
        version: cliVersion,
        ...(cliError ? { error: cliError } : {}),
      },
      auth: {
        codexHome,
        authJsonExists,
        configTomlExists,
        hasApiKeyEnv,
      },
      store: {
        stateFile: this.store.getStateFilePath(),
        totalStoredJobs: jobs.length,
        activeRunningJobs: runningCount,
      },
    };
  }
}
