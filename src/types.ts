import type { ApprovalMode, ModelReasoningEffort, SandboxMode, Usage } from "@openai/codex-sdk";

export type JobKind = "run" | "review" | "adversarial_review";

export type JobStatus = "running" | "waiting_approval" | "waiting_input" | "completed" | "failed" | "cancelled" | "interrupted";

export function isActiveJob(status: JobStatus): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_input";
}

export interface PendingRequest {
  requestId: string | number;
  method: string;
  kind: "command_approval" | "file_approval" | "user_input";
  summary: string;
  details: unknown;
  createdAt: string;
}

export interface GitSummary {
  isGitRepo: boolean;
  changedFiles: string[];
  diffStat: string;
  outOfScopeFiles: string[];
}

export interface CommandSummary {
  command: string;
  exitCode?: number;
  status: string;
}

export interface ItemsSummary {
  commands: CommandSummary[];
  fileChanges: Array<{ path: string; kind: string; status: string }>;
  mcpToolCalls: Array<{ server: string; tool: string; status: string }>;
  webSearches: string[];
}

export interface JobRecord {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  workingDirectory: string;
  promptPreview: string;
  model?: string;
  effort?: ModelReasoningEffort;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
  allowedPaths?: string[];
  threadId?: string;
  turnId?: string;
  pendingRequest?: PendingRequest;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  progress: string[];
  finalResponse?: string;
  itemsSummary?: ItemsSummary;
  usage?: Usage | null;
  gitSummary?: GitSummary;
  error?: string;
}

export interface RunOptions {
  kind?: JobKind;
  prompt: string;
  workingDirectory: string;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalMode;
  threadId?: string;
  resumeLatest?: boolean;
  model?: string;
  effort?: ModelReasoningEffort;
  background?: boolean;
  additionalDirectories?: string[];
  skipGitRepoCheck?: boolean;
  allowedPaths?: string[];
}
