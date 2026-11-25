import type { JobRecord } from "./types.js";

export function formatJobSummary(job: JobRecord) {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    workingDirectory: job.workingDirectory,
    threadId: job.threadId ?? null,
    turnId: job.turnId ?? null,
    pendingRequest: job.pendingRequest ?? null,
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
