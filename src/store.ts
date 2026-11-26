import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isActiveJob, type JobRecord } from "./types.js";

const MAX_JOBS = 50;

interface StoreData {
  version: 1;
  jobs: JobRecord[];
}

export function resolveStateFilePath(): string {
  if (process.env.CODEX_MCP_STATE_FILE && process.env.CODEX_MCP_STATE_FILE.trim()) {
    return path.resolve(process.env.CODEX_MCP_STATE_FILE.trim());
  }
  const stateHome = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.trim()
    ? process.env.XDG_STATE_HOME.trim()
    : path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "codex-mcp-agy", "jobs.json");
}

export class JobStore {
  private readonly filePath: string;
  private jobs: JobRecord[] = [];
  private loaded = false;

  constructor(filePath: string = resolveStateFilePath(), private readonly recover = true) {
    this.filePath = path.resolve(filePath);
  }

  getStateFilePath(): string {
    return this.filePath;
  }

  load({ recoverStale = this.recover } = {}): void {
    if (this.loaded) return;
    this.loaded = true;

    try {
      this.jobs = this.read();
    } catch (err) {
      console.error(`[codex-mcp-agy] Failed to load job store (${this.filePath}):`, err);
    }
    if (recoverStale) this.markStaleJobsInterrupted("MCP server restarted while job was active");
  }

  markStaleJobsInterrupted(reason: string): void {
    this.load({ recoverStale: false });
    if (!this.jobs.some((job) => isActiveJob(job.status))) return;
    const now = new Date().toISOString();
    this.jobs = this.jobs.map((job) => isActiveJob(job.status) ? {
      ...job,
      status: "interrupted",
      pendingRequest: undefined,
      finishedAt: job.finishedAt ?? now,
      error: job.error ?? reason,
    } : job);
    this.save();
  }

  private read(): JobRecord[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoreData>;
      return Array.isArray(parsed.jobs) ? parsed.jobs : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    this.prune();
    const payload: StoreData = {
      version: 1,
      jobs: this.jobs,
    };
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
  }

  private prune(): void {
    if (this.jobs.length <= MAX_JOBS) return;
    const running = this.jobs.filter((j) => isActiveJob(j.status));
    const nonRunning = this.jobs
      .filter((j) => !isActiveJob(j.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const remainingSlots = Math.max(0, MAX_JOBS - running.length);
    const kept = [...running, ...nonRunning.slice(0, remainingSlots)];
    kept.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.jobs = kept;
  }

  createJob(job: JobRecord): JobRecord {
    this.load();
    const normalized: JobRecord = {
      ...job,
      workingDirectory: path.resolve(job.workingDirectory),
    };
    this.jobs.push(normalized);
    this.save();
    return normalized;
  }

  updateJob(jobId: string, updater: (current: JobRecord) => JobRecord): JobRecord | undefined {
    this.load();
    const idx = this.jobs.findIndex((j) => j.jobId === jobId);
    if (idx === -1) return undefined;
    const updated = updater(this.jobs[idx]);
    this.jobs[idx] = updated;
    this.save();
    return updated;
  }

  getJob(jobId: string): JobRecord | undefined {
    this.load();
    return this.jobs.find((j) => j.jobId === jobId);
  }

  listJobs(options: { workingDirectory?: string; limit?: number } = {}): JobRecord[] {
    this.load();
    const normDir = options.workingDirectory ? path.resolve(options.workingDirectory) : undefined;
    const filtered = normDir
      ? this.jobs.filter((j) => j.workingDirectory === normDir)
      : [...this.jobs];

    filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (options.limit && options.limit > 0) {
      return filtered.slice(0, options.limit);
    }
    return filtered;
  }

  getActiveJobs(workingDirectory?: string): JobRecord[] {
    return this.listJobs({ workingDirectory }).filter((j) => isActiveJob(j.status));
  }

  getLatestFinishedJob(workingDirectory?: string): JobRecord | undefined {
    return this.listJobs({ workingDirectory }).find((j) => !isActiveJob(j.status));
  }

  getLatestThreadId(workingDirectory: string): string | undefined {
    const normDir = path.resolve(workingDirectory);
    const match = this.listJobs({ workingDirectory: normDir }).find(
      (j) => typeof j.threadId === "string" && j.threadId.length > 0,
    );
    return match?.threadId;
  }
}
