import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Usage } from "@openai/codex-sdk";
import { AppServerClient, RpcTimeoutError } from "./app-server.js";
import { inspectGitWorkspace } from "./git.js";
import { JobStore } from "./store.js";
import type { ItemsSummary, JobRecord, JobStatus, PendingRequest, RunOptions } from "./types.js";

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

type Item =
  | { type: "agentMessage"; text: string }
  | { type: "commandExecution"; command: string; exitCode?: number | null; status: string }
  | { type: "fileChange"; changes: Array<{ path: string; kind: { type: string } | string }>; status: string }
  | { type: "mcpToolCall"; server: string; tool: string; status: string }
  | { type: "webSearch"; query: string }
  | { type: "error"; message: string };

interface Turn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: { message: string } | null;
  items?: Item[];
}

interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface TurnEvent {
  threadId: string;
  turnId?: string;
  turn?: Turn;
  item?: Item;
  tokenUsage?: { total: TokenCounts };
  requestId?: PendingRequest["requestId"];
  error?: { message: string };
  willRetry?: boolean;
}

interface ActiveJob {
  jobId: string;
  threadId?: string;
  turnId?: string;
  startingTurn: boolean;
  cancelling?: boolean;
  startup?: Promise<void>;
  finishing?: Promise<void>;
  pending: PendingRequest[];
  waiter?: { resolve: (job: JobRecord) => void; reject: (error: unknown) => void };
  items: ItemsSummary;
  finalResponse?: string;
  usage?: Usage;
  error?: string;
  failure?: string;
}

const REQUEST_KINDS = new Map<string, PendingRequest["kind"]>([
  ["item/commandExecution/requestApproval", "command_approval"],
  ["item/fileChange/requestApproval", "file_approval"],
  ["item/tool/requestUserInput", "user_input"],
]);

type Decision = "accept" | "acceptForSession" | "decline" | "cancel";

function textInput(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

function summarizeCompletedItem(item: Item, summary: ItemsSummary): string | undefined {
  switch (item.type) {
    case "agentMessage":
      return `agent: ${truncateText(item.text, 120)}`;
    case "commandExecution": {
      const exitCode = item.exitCode ?? undefined;
      summary.commands.push({ command: item.command, exitCode, status: item.status });
      return `cmd (${item.status}${exitCode !== undefined ? `:${exitCode}` : ""}): ${truncateText(item.command, 100)}`;
    }
    case "fileChange": {
      const changes = item.changes.map(({ path, kind }) => ({
        path,
        kind: typeof kind === "string" ? kind : kind.type,
        status: item.status,
      }));
      summary.fileChanges.push(...changes);
      return `files (${item.status}): ${changes.map((c) => `${c.kind}:${c.path}`).join(", ")}`;
    }
    case "mcpToolCall":
      summary.mcpToolCalls.push({ server: item.server, tool: item.tool, status: item.status });
      return `mcp (${item.status}): ${item.server}.${item.tool}`;
    case "webSearch":
      summary.webSearches.push(item.query);
      return `search: ${truncateText(item.query, 80)}`;
    case "error":
      return `error: ${truncateText(item.message, 120)}`;
  }
}

export class CodexRunner {
  private readonly active = new Map<string, ActiveJob>();
  private readonly client: AppServerClient;
  private closing = false;

  constructor(
    private readonly store: JobStore,
    { binary, requestTimeoutMs }: { binary?: string; requestTimeoutMs?: number } = {},
  ) {
    this.client = new AppServerClient({
      notification: (method, params) => this.onNotification(method, params as TurnEvent),
      request: (id, method, params) => this.onRequest(id, method, params),
      disconnect: (error) => {
        for (const job of this.active.values()) {
          this.finish(job, job.failure ? "failed" : "interrupted", job.failure ?? error.message);
        }
      },
    }, binary, requestTimeoutMs);
  }

  getStore(): JobStore {
    return this.store;
  }

  async startJob(options: RunOptions): Promise<JobRecord> {
    if (this.closing) throw new Error("Codex runner is shutting down");
    const workingDirectory = path.resolve(options.workingDirectory);
    if (!fs.statSync(workingDirectory, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Working directory does not exist or is not a directory: ${workingDirectory}`);
    }

    const threadId = options.threadId?.trim() ||
      (options.resumeLatest ? this.store.getLatestThreadId(workingDirectory) : undefined);
    if (threadId && this.activeThread(threadId)) {
      throw new Error(`Thread ${threadId} already has an active job. Use codex_steer or codex_respond.`);
    }
    const now = new Date().toISOString();
    const jobId = `codex-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const initial = this.store.createJob({
      jobId,
      kind: options.kind ?? "run",
      status: "running",
      workingDirectory,
      promptPreview: truncateText(options.prompt, PROMPT_PREVIEW_LIMIT),
      model: resolveModelAlias(options.model),
      effort: options.effort,
      sandboxMode: options.sandboxMode ?? "workspace-write",
      approvalPolicy: options.approvalPolicy ?? "never",
      allowedPaths: options.allowedPaths,
      threadId,
      createdAt: now,
      startedAt: now,
      progress: [threadId
        ? `Resuming thread ${threadId} in ${options.sandboxMode ?? "workspace-write"} mode`
        : `Starting new thread in ${options.sandboxMode ?? "workspace-write"} mode`],
    });
    const active: ActiveJob = {
      jobId, threadId, startingTurn: false, pending: [],
      items: { commands: [], fileChanges: [], mcpToolCalls: [], webSearches: [] },
    };
    this.active.set(jobId, active);
    const result = options.background ? initial : this.waitForJob(active);
    active.startup = this.startTurn(active, initial, options);
    return result;
  }

  private async startTurn(active: ActiveJob, job: JobRecord, options: RunOptions): Promise<void> {
    try {
      if (!options.skipGitRepoCheck) {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: job.workingDirectory,
          timeout: 5000,
        }).catch(() => ({ stdout: "" }));
        if (stdout.trim() !== "true") {
          throw new Error("Working directory is outside a Git repository. Set skipGitRepoCheck to run here.");
        }
        if (!this.active.has(job.jobId)) return;
      }

      const threadParams = {
        model: job.model,
        cwd: job.workingDirectory,
        approvalPolicy: job.approvalPolicy,
        sandbox: job.sandboxMode,
        config: job.sandboxMode === "workspace-write" && options.additionalDirectories?.length
          ? { "sandbox_workspace_write.writable_roots": options.additionalDirectories.map((dir) => path.resolve(dir)) }
          : undefined,
      };
      const { thread } = await this.client.request<{ thread: { id: string } }>(
        job.threadId ? "thread/resume" : "thread/start",
        job.threadId ? { ...threadParams, threadId: job.threadId } : threadParams,
      );
      if (!this.active.has(job.jobId)) return;
      active.threadId = thread.id;
      this.store.updateJob(job.jobId, (cur) => ({
        ...cur,
        threadId: thread.id,
        progress: appendProgress(cur.progress, `thread.started: ${thread.id}`),
      }));

      active.startingTurn = true;
      const { turn } = await this.client.request<{ turn: Turn }>("turn/start", {
        threadId: thread.id,
        input: textInput(options.prompt),
        cwd: job.workingDirectory,
        approvalPolicy: job.approvalPolicy,
        effort: job.effort,
      });
      if (!this.active.has(job.jobId)) return;
      this.setTurnId(active, turn.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof RpcTimeoutError && err.method === "turn/start" && this.active.has(active.jobId)) {
        active.failure = message;
        await this.client.reset();
      }
      this.finish(active, "failed", message);
    }
  }

  private activeThread(threadId: string): ActiveJob | undefined {
    return [...this.active.values()].find((job) => job.threadId === threadId);
  }

  private waitForJob(active: ActiveJob): Promise<JobRecord> {
    return new Promise((resolve, reject) => { active.waiter = { resolve, reject }; });
  }

  private publish(active: ActiveJob, job: JobRecord): void {
    active.waiter?.resolve(job);
    active.waiter = undefined;
  }

  private setTurnId(active: ActiveJob, turnId: string): void {
    if (active.turnId) return;
    active.turnId = turnId;
    this.store.updateJob(active.jobId, (cur) => ({ ...cur, turnId }));
  }

  private updatePending(active: ActiveJob): JobRecord | undefined {
    const pendingRequest = active.pending[0];
    try {
      const job = this.store.updateJob(active.jobId, (cur) => ({
        ...cur,
        turnId: active.turnId,
        pendingRequest,
        status: !pendingRequest ? "running" : pendingRequest.kind === "user_input" ? "waiting_input" : "waiting_approval",
      }))!;
      if (pendingRequest) this.publish(active, job);
      return job;
    } catch (err) {
      const message = `Failed to save pending request state: ${err instanceof Error ? err.message : String(err)}`;
      active.failure = message;
      try {
        for (const request of active.pending) {
          if (request.kind === "user_input") this.client.reject(request.requestId, message, -32603);
          else this.client.respond(request.requestId, { decision: "cancel" });
        }
      } catch {
        void this.client.reset().then(() => this.finish(active, "failed", message));
        return;
      }
      this.finish(active, "failed", message);
    }
  }

  private onRequest(id: PendingRequest["requestId"], method: string, details: unknown): void {
    const request = details as {
      threadId: string;
      turnId: string;
      command?: string;
      reason?: string;
      questions?: Array<{ question: string }>;
    };
    const kind = REQUEST_KINDS.get(method);
    const active = this.activeThread(request?.threadId);
    if (!kind || !active?.startingTurn || !request.turnId) {
      this.client.reject(id, `Unsupported request or inactive turn: ${method}`);
      return;
    }
    active.turnId ??= request.turnId;
    if (active.turnId !== request.turnId) {
      this.client.reject(id, `Unsupported request or inactive turn: ${method}`);
      return;
    }

    const summary = request.questions?.map((q) => q.question).join(" ") ||
      request.command || request.reason || (kind === "file_approval" ? "File change approval" : "Codex needs input");
    active.pending.push({ requestId: id, method, kind, summary, details, createdAt: new Date().toISOString() });
    if (active.pending.length === 1) this.updatePending(active);
  }

  private onNotification(method: string, event: TurnEvent): void {
    if (!event?.threadId) return;
    const active = this.activeThread(event.threadId);
    if (!active) return;
    if (method === "turn/started" && active.startingTurn && event.turn) this.setTurnId(active, event.turn.id);
    if (method === "serverRequest/resolved") {
      const pending = active.pending.filter((request) => request.requestId !== event.requestId);
      if (pending.length !== active.pending.length) {
        active.pending = pending;
        this.updatePending(active);
      }
      return;
    }
    if (!active.turnId || active.turnId !== (event.turn?.id ?? event.turnId)) return;

    if (method === "item/completed" && event.item) {
      if (event.item.type === "agentMessage") active.finalResponse = event.item.text;
      if (event.item.type === "error") active.error = event.item.message;
      const line = summarizeCompletedItem(event.item, active.items);
      if (line) this.store.updateJob(active.jobId, (cur) => ({ ...cur, progress: appendProgress(cur.progress, line) }));
    } else if (method === "thread/tokenUsage/updated" && event.tokenUsage) {
      const counts = event.tokenUsage.total;
      active.usage = {
        input_tokens: counts.inputTokens,
        cached_input_tokens: counts.cachedInputTokens,
        cache_write_input_tokens: counts.cacheWriteInputTokens ?? 0,
        output_tokens: counts.outputTokens,
        reasoning_output_tokens: counts.reasoningOutputTokens,
      };
    } else if (method === "error" && !event.willRetry) {
      active.error = event.error?.message;
    } else if (method === "turn/completed" && event.turn && event.turn.status !== "inProgress") {
      const status = event.turn.status === "interrupted" && active.cancelling ? "cancelled" : event.turn.status;
      const error = event.turn.error?.message ?? (status === "failed" ? active.error ?? "Codex turn failed" : undefined);
      active.finalResponse ??= event.turn.items?.filter((item) => item.type === "agentMessage").at(-1)?.text;
      this.finish(active, status, error);
    }
  }

  private finish(active: ActiveJob, status: JobStatus, error?: string): void {
    if (!this.active.delete(active.jobId)) return;
    const job = this.store.getJob(active.jobId)!;
    const finishedAt = new Date().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(job.startedAt);
    const finalize = (gitSummary?: JobRecord["gitSummary"]) => {
      try {
        const updated = this.store.updateJob(active.jobId, (cur) => ({
          ...cur,
          status, error, finishedAt, durationMs, gitSummary,
          pendingRequest: undefined,
          itemsSummary: active.items,
          usage: active.usage ?? null,
          finalResponse: active.finalResponse ?? (status === "completed" ? "" : undefined),
          progress: appendProgress(cur.progress, error ? `Error: ${truncateText(error, 120)}` : `Job ${status} in ${durationMs}ms`),
        }))!;
        this.publish(active, updated);
      } catch (err) {
        if (active.waiter) active.waiter.reject(err);
        else console.error(`[codex-mcp-agy] Failed to save job ${active.jobId}:`, err);
        active.waiter = undefined;
      }
    };
    if (status === "completed" && job.kind === "run") {
      active.finishing = inspectGitWorkspace(job.workingDirectory, job.allowedPaths).then(finalize, () => finalize());
    } else {
      finalize();
    }
  }

  async respondToJob(options: {
    jobId: string;
    requestId?: PendingRequest["requestId"];
    decision?: Decision;
    answers?: Record<string, string[]>;
    wait?: boolean;
  }): Promise<JobRecord> {
    const active = this.active.get(options.jobId);
    const pending = active?.pending[0];
    if (!active || !pending || active.cancelling || active.failure) {
      throw new Error(`Job ${options.jobId} has no pending request available to answer`);
    }
    if (options.requestId === undefined && active.pending.length > 1) {
      throw new Error(`Job ${options.jobId} has multiple pending requests. Provide requestId ${JSON.stringify(pending.requestId)} for the current request.`);
    }
    if (options.requestId !== undefined && options.requestId !== pending.requestId) {
      throw new Error(`requestId ${JSON.stringify(options.requestId)} does not match the current pending request ${JSON.stringify(pending.requestId)}`);
    }

    if (pending.kind === "user_input") {
      if (!options.answers || options.decision !== undefined) throw new Error("This job requires answers");
      const answers = Object.fromEntries(Object.entries(options.answers).map(([id, answers]) => [id, { answers }]));
      this.client.respond(pending.requestId, { answers });
    } else {
      if (!options.decision || options.answers !== undefined) throw new Error("This job requires an approval decision");
      this.client.respond(pending.requestId, { decision: options.decision });
    }
    active.pending.shift();
    const updated = this.updatePending(active);
    if (!updated) throw new Error(active.failure);
    return options.wait && updated.status === "running" ? this.waitForJob(active) : updated;
  }

  async steerJob({ jobId, prompt }: { jobId: string; prompt: string }): Promise<JobRecord> {
    const active = this.active.get(jobId);
    const job = this.store.getJob(jobId);
    if (!active?.threadId || !active.turnId || active.cancelling || job?.status !== "running") {
      throw new Error(`Job ${jobId} does not have a running turn`);
    }
    await this.client.request("turn/steer", {
      threadId: active.threadId,
      expectedTurnId: active.turnId,
      input: textInput(prompt),
    });
    return this.store.getJob(jobId) ?? job;
  }

  async cancelJob({ jobId, workingDirectory }: { jobId?: string; workingDirectory?: string }): Promise<{
    cancelled: boolean;
    job?: JobRecord;
    reason?: string;
  }> {
    const job = jobId ? this.store.getJob(jobId) : this.store.getActiveJobs(workingDirectory)
      .find((candidate) => this.active.has(candidate.jobId));
    if (!job) return { cancelled: false, reason: jobId ? `Job not found: ${jobId}` : "No active job found" };

    const active = this.active.get(job.jobId);
    if (!active || active.cancelling) return { cancelled: false, job, reason: "Job is finishing or has no active turn in this process" };
    active.cancelling = true;
    try {
      if (active.startingTurn && !active.turnId) await active.startup;
      if (!this.active.has(job.jobId)) {
        await active.finishing;
        const current = this.store.getJob(job.jobId)!;
        return { cancelled: current.status === "cancelled", job: current };
      }
      if (active.threadId && active.turnId) {
        await this.client.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId });
      }
      this.finish(active, "cancelled");
      await active.finishing;
      const current = this.store.getJob(job.jobId)!;
      return { cancelled: current.status === "cancelled", job: current };
    } catch (err) {
      active.cancelling = false;
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    try {
      for (const job of this.active.values()) this.finish(job, "interrupted", "Codex runner shut down while job was active");
    } finally {
      await this.client.shutdown();
    }
  }

  async checkHealth(): Promise<Record<string, unknown>> {
    const { binary: codexBin, command, args } = this.client.executable;
    let cliAvailable = false;
    let cliVersion: string | null = null;
    let cliError: string | null = null;

    try {
      const { stdout } = await execFileAsync(command, [...args, "--version"], { timeout: 5000 });
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
    const runningCount = this.active.size;

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
