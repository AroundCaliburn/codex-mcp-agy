import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobRecord } from "./types.js";

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

  constructor(filePath: string = resolveStateFilePath()) {
    this.filePath = path.resolve(filePath);
  }

  getStateFilePath(): string {
    return this.filePath;
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;

    if (!fs.existsSync(this.filePath)) {
      this.jobs = [];
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      const list = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      let recovered = false;
      const now = new Date().toISOString();

      this.jobs = list.map((job) => {
        if (job.status === "running") {
          recovered = true;
          return {
            ...job,
            status: "interrupted" as const,
            finishedAt: job.finishedAt ?? now,
            error: job.error ?? "MCP server restarted while job was running",
          };
        }
        return job;
      });

      if (recovered) {
        this.save();
      }
    } catch (err) {
      console.error(`[codex-mcp-agy] Failed to load job store (${this.filePath}):`, err);
      this.jobs = [];
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
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }

  private prune(): void {
    if (this.jobs.length <= MAX_JOBS) return;
    // Keep all running jobs plus the newest finished jobs up to MAX_JOBS.
    const running = this.jobs.filter((j) => j.status === "running");
    const nonRunning = this.jobs
      .filter((j) => j.status !== "running")
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

  getRunningJobs(workingDirectory?: string): JobRecord[] {
    return this.listJobs({ workingDirectory }).filter((j) => j.status === "running");
  }

  getLatestFinishedJob(workingDirectory?: string): JobRecord | undefined {
    return this.listJobs({ workingDirectory }).find((j) => j.status !== "running");
  }

  getLatestThreadId(workingDirectory: string): string | undefined {
    const normDir = path.resolve(workingDirectory);
    const match = this.listJobs({ workingDirectory: normDir }).find(
      (j) => typeof j.threadId === "string" && j.threadId.length > 0,
    );
    return match?.threadId;
  }
}
