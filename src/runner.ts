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
  previousTurnId?: string | null;
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
  private reconciliation?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private readonly store: JobStore,
    { binary, requestTimeoutMs, transport }: {
      binary?: string;
      requestTimeoutMs?: number;
      transport?: AppServerClient["transport"];
    } = {},
  ) {
    store.load({ recoverStale: false });
    this.client = new AppServerClient({
      notification: (method, params) => this.onNotification(method, params as TurnEvent),
      request: (id, method, params) => this.onRequest(id, method, params),
      disconnect: (error) => {
        if (this.client.transport === "ws") {
          this.reconciliation = undefined;
          for (const job of this.active.values()) job.waiter?.reject(error);
          this.active.clear();
          this.scheduleReconnect();
        } else {
          for (const job of this.active.values()) {
            this.finish(job, job.failure ? "failed" : "interrupted", job.failure ?? error.message);
          }
        }
      },
    }, binary, requestTimeoutMs, { transport, stateDir: path.dirname(store.getStateFilePath()) });
  }

  getStore(): JobStore {
    return this.store;
  }

  reconcileActiveJobs(): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Codex runner is shutting down"));
    if (this.reconciliation) return this.reconciliation;
    const reconciliation = this.reconcile().catch((error) => {
      if (this.reconciliation === reconciliation) this.reconciliation = undefined;
      throw error;
    });
    this.reconciliation = reconciliation;
    return reconciliation;
  }

  private scheduleReconnect(delayMs = 100): void {
    if (this.closing || this.reconnectTimer || !this.store.getActiveJobs().length) return;
    this.reconnectTimer = setTimeout(async () => {
      let retry = false;
      try {
        await this.reconcileActiveJobs();
        retry = !this.client.getRuntimeStatus().connected;
      } catch {
        retry = true;
      } finally {
        this.reconnectTimer = undefined;
        if (retry) this.scheduleReconnect(Math.min(delayMs * 2, 5000));
      }
    }, delayMs);
    this.reconnectTimer.unref();
  }

  private async reconcile(): Promise<void> {
    const reason = "Codex runtime restarted while job was active";
    if (this.client.transport === "stdio") {
      this.store.markStaleJobsInterrupted(reason);
      return;
    }
    await this.client.connect();
    if (this.closing) return;
    if (!this.client.getRuntimeStatus().reused) {
      this.store.markStaleJobsInterrupted(reason);
      return;
    }
    for (const job of this.store.getActiveJobs()) {
      if (this.closing || !this.client.getRuntimeStatus().connected) {
        throw new Error("Codex app-server disconnected during reconciliation");
      }
      await this.reconcileJob(job);
    }
  }

  private async reconcileJob(job: JobRecord): Promise<void> {
    const { jobId, threadId, previousTurnId } = job;
    const active = this.trackJob(job);
    const readTurn = async () => {
      const { thread } = await this.client.request<{
        thread: { status: { type: string }; turns: Turn[] };
      }>("thread/read", { threadId, includeTurns: true });
      const previousIndex = thread.turns.findIndex(({ id }) => id === previousTurnId);
      const hasBaseline = previousTurnId === null || previousIndex >= 0;
      const turn = active.turnId
        ? thread.turns.find(({ id }) => id === active.turnId)
        : hasBaseline ? thread.turns[previousIndex + 1] : undefined;
      return { turn, canResume: (active.turnId !== undefined || hasBaseline) && thread.status.type === "active" };
    };

    try {
      if (!threadId) throw new Error("Job has no recorded Codex thread");
      const { turn, canResume } = await readTurn();
      if (this.active.get(jobId) !== active) return;
      if (turn) this.setTurnId(active, turn.id);
      if (turn && turn.status !== "inProgress") {
        this.completeTurn(active, turn, true);
      } else if (canResume || turn?.status === "inProgress") {
        active.startingTurn = true;
        for (const item of turn?.items ?? []) {
          if (!("status" in item) || item.status !== "inProgress") this.recordItem(active, item);
        }
        this.updatePending(active);
        await this.client.request("thread/resume", { threadId });
        // The turn can finish between the first read and the resume subscription.
        if (this.active.get(jobId) === active) {
          const { turn: latest, canResume: stillActive } = await readTurn();
          if (this.active.get(jobId) !== active) return;
          if (latest) {
            this.setTurnId(active, latest.id);
            this.completeTurn(active, latest, true);
          } else if (!stillActive) {
            this.finish(active, "interrupted", "Codex thread has no running turn");
          }
        }
      } else {
        this.finish(active, "interrupted", "Codex thread has no running turn");
      }
      await active.finishing;
    } catch (error) {
      if (this.closing || !this.client.getRuntimeStatus().connected) throw error;
      this.finish(active, "interrupted", error instanceof Error ? error.message : String(error));
    }
  }

  private trackJob({ jobId, threadId, turnId, previousTurnId }: JobRecord): ActiveJob {
    const active: ActiveJob = {
      jobId, threadId, turnId, previousTurnId, startingTurn: false, pending: [],
      items: { commands: [], fileChanges: [], mcpToolCalls: [], webSearches: [] },
    };
    this.active.set(jobId, active);
    return active;
  }

  async startJob(options: RunOptions): Promise<JobRecord> {
    if (this.closing) throw new Error("Codex runner is shutting down");
    const workingDirectory = path.resolve(options.workingDirectory);
    if (!fs.statSync(workingDirectory, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Working directory does not exist or is not a directory: ${workingDirectory}`);
    }

    await this.reconcileActiveJobs();
    if (this.closing) throw new Error("Codex runner is shutting down");
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
    const active = this.trackJob(initial);
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
      }
      if (this.active.get(job.jobId) !== active) return;

      const threadParams = {
        model: job.model,
        cwd: job.workingDirectory,
        approvalPolicy: job.approvalPolicy,
        sandbox: job.sandboxMode,
        config: job.sandboxMode === "workspace-write" && options.additionalDirectories?.length
          ? { "sandbox_workspace_write.writable_roots": options.additionalDirectories.map((dir) => path.resolve(dir)) }
          : undefined,
      };
      const { thread } = await this.client.request<{ thread: { id: string; turns?: Turn[] } }>(
        job.threadId ? "thread/resume" : "thread/start",
        job.threadId ? { ...threadParams, threadId: job.threadId, excludeTurns: false } : threadParams,
      );
      let turns = thread.turns;
      if (job.threadId && !turns && this.active.get(job.jobId) === active) {
        const result = await this.client.request<{ thread: { turns: Turn[] } }>(
          "thread/read", { threadId: thread.id, includeTurns: true },
        );
        turns = result.thread.turns;
      }
      if (this.active.get(job.jobId) !== active) return;
      active.threadId = thread.id;
      active.previousTurnId = turns?.at(-1)?.id ?? null;
      this.store.updateJob(job.jobId, (cur) => ({
        ...cur,
        threadId: thread.id,
        previousTurnId: active.previousTurnId,
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
      if (this.active.get(job.jobId) !== active) return;
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
    if (active.turnId || turnId === active.previousTurnId) return;
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
    if (!kind || !active?.startingTurn || !request.turnId || request.turnId === active.previousTurnId) {
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
    if (active.startingTurn && event.turn && (method === "turn/started" || method === "turn/completed")) {
      this.setTurnId(active, event.turn.id);
    }
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
      const line = this.recordItem(active, event.item);
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
      this.completeTurn(active, event.turn);
    }
  }

  private recordItem(active: ActiveJob, item: Item): string | undefined {
    if (item.type === "agentMessage") active.finalResponse = item.text;
    if (item.type === "error") active.error = item.message;
    return summarizeCompletedItem(item, active.items);
  }

  private completeTurn(active: ActiveJob, turn: Turn, recovered = false): void {
    if (turn.status === "inProgress") return;
    if (recovered && turn.items?.length) {
      active.items = { commands: [], fileChanges: [], mcpToolCalls: [], webSearches: [] };
      for (const item of turn.items) this.recordItem(active, item);
    } else {
      active.finalResponse ??= turn.items?.filter((item) => item.type === "agentMessage").at(-1)?.text;
    }
    const status = turn.status === "interrupted" && active.cancelling ? "cancelled" : turn.status;
    const error = turn.error?.message ??
      (status === "failed" ? active.error ?? "Codex turn failed" : recovered ? active.error : undefined);
    this.finish(active, status, error, recovered);
  }

  private finish(active: ActiveJob, status: JobStatus, error?: string, recovered = false): void {
    if (this.active.get(active.jobId) !== active) return;
    this.active.delete(active.jobId);
    const job = this.store.getJob(active.jobId)!;
    const finishedAt = new Date().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(job.startedAt);
    const finalize = (gitSummary?: JobRecord["gitSummary"]) => {
      try {
        const updated = this.store.updateJob(active.jobId, (cur) => ({
          ...cur,
          status, error, finishedAt, durationMs, gitSummary,
          turnId: active.turnId ?? cur.turnId,
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
    if (job.kind === "run" && (status === "completed" || recovered)) {
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
    await this.reconcileActiveJobs();
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
    await this.reconcileActiveJobs();
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
    await this.reconcileActiveJobs();
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
    clearTimeout(this.reconnectTimer);
    try {
      if (this.client.transport === "stdio") {
        for (const job of this.active.values()) this.finish(job, "interrupted", "Codex runner shut down while job was active");
      }
    } finally {
      await this.client.close();
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

    let runtimeError: string | undefined;
    if (cliAvailable) {
      try {
        await this.reconcileActiveJobs();
      } catch (error) {
        runtimeError = error instanceof Error ? error.message : String(error);
      }
    }
    const jobs = this.store.listJobs();
    const runningCount = this.active.size;

    return {
      ok: cliAvailable && !runtimeError && (authJsonExists || hasApiKeyEnv),
      runtime: { ...this.client.getRuntimeStatus(), ...(runtimeError ? { error: runtimeError } : {}) },
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
