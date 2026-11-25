import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitSummary } from "./types.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { stdout, stderr, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: message, ok: false };
  }
}

export function normalizeRelativePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

export function findOutOfScopeFiles(changedFiles: string[], allowedPaths?: string[]): string[] {
  if (!allowedPaths || allowedPaths.length === 0) {
    return [];
  }
  const normalizedAllowed = allowedPaths
    .map(normalizeRelativePath)
    .filter((p) => p.length > 0);
  if (normalizedAllowed.length === 0) {
    return [];
  }

  return changedFiles.filter((file) => {
    const normFile = normalizeRelativePath(file);
    return !normalizedAllowed.some(
      (allowed) => normFile === allowed || normFile.startsWith(`${allowed}/`),
    );
  });
}

function parsePorcelainStatus(output: string): string[] {
  const files: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine || rawLine.length < 4) continue;
    let filePart = rawLine.slice(3).trim();
    const renameArrow = filePart.indexOf(" -> ");
    if (renameArrow !== -1) {
      filePart = filePart.slice(renameArrow + 4).trim();
    }
    if (filePart.startsWith('"') && filePart.endsWith('"')) {
      filePart = filePart.slice(1, -1);
    }
    if (filePart) {
      files.push(normalizeRelativePath(filePart));
    }
  }
  return Array.from(new Set(files));
}

export async function inspectGitWorkspace(
  workingDirectory: string,
  allowedPaths?: string[],
): Promise<GitSummary> {
  const inside = await runGit(workingDirectory, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return {
      isGitRepo: false,
      changedFiles: [],
      diffStat: "",
      outOfScopeFiles: [],
    };
  }

  const [statusRes, unstagedStat, stagedStat] = await Promise.all([
    runGit(workingDirectory, ["status", "--porcelain=v1"]),
    runGit(workingDirectory, ["diff", "--stat"]),
    runGit(workingDirectory, ["diff", "--cached", "--stat"]),
  ]);

  const changedFiles = statusRes.ok ? parsePorcelainStatus(statusRes.stdout) : [];
  const statParts: string[] = [];
  if (unstagedStat.ok && unstagedStat.stdout.trim()) {
    statParts.push(unstagedStat.stdout.trim());
  }
  if (stagedStat.ok && stagedStat.stdout.trim()) {
    statParts.push(`[staged]\n${stagedStat.stdout.trim()}`);
  }

  return {
    isGitRepo: true,
    changedFiles,
    diffStat: statParts.join("\n"),
    outOfScopeFiles: findOutOfScopeFiles(changedFiles, allowedPaths),
  };
}
