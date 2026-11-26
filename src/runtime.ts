import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

export function resolveCodexCommand(override = process.env.CODEX_PATH_OVERRIDE?.trim()) {
  if (override) return { binary: override, command: override, args: [] };

  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  for (const dir of (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
    const binary = path.resolve(dir, executable);
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      if (fs.statSync(binary).isFile()) return { binary, command: binary, args: [] };
    } catch {
      // Look in the next PATH directory.
    }
  }

  try {
    const require = createRequire(import.meta.url);
    let binary: string;
    try {
      binary = require.resolve("@openai/codex/bin/codex.js");
    } catch {
      binary = createRequire(import.meta.resolve("@openai/codex-sdk")).resolve("@openai/codex/bin/codex.js");
    }
    return { binary, command: process.execPath, args: [binary] };
  } catch {
    return { binary: executable, command: executable, args: [] };
  }
}

interface RuntimeState {
  url: string;
  tokenFile: string;
  pid: number;
  unitName?: string;
  binary: string;
  startedAt: string;
}

export type RuntimeConnection = Pick<RuntimeState, "url" | "pid" | "unitName"> & {
  token: string;
  reused: boolean;
};

const EPHEMERAL_URL = "ws://127.0.0.1:0";
const exec = promisify(execFile);
const starting = new Map<string, Promise<RuntimeConnection>>();

function readState(dir: string): RuntimeState | undefined {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8")) as RuntimeState;
    if (typeof state?.url === "string" && /^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(state?.url) &&
        state.tokenFile === path.join(dir, "runtime.token") &&
        Number.isSafeInteger(state.pid) && state.pid > 1 &&
        (state.unitName === undefined || /^codex-mcp-agy-[a-f0-9]{12}$/.test(state.unitName))) {
      return state;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function ready(url: string, timeout = 1000): Promise<boolean> {
  try {
    const res = await fetch(new URL("/readyz", url.replace(/^ws:/, "http:")), {
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    });
    await res.body?.cancel();
    return res.status === 200;
  } catch {
    return false;
  }
}

function isRuntimeProcess(pid: number, tokenFile: string, url = EPHEMERAL_URL): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== "linux") return true;
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    const listen = args[args.indexOf("--listen") + 1];
    return args.includes("app-server") && (listen === EPHEMERAL_URL || listen === url) &&
      args[args.indexOf("--ws-token-file") + 1] === tokenFile;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

async function unitMainPid(unitName: string): Promise<number | undefined> {
  const { stdout } = await exec("systemctl", ["--user", "show", unitName, "-p", "MainPID", "--value"], { timeout: 5000 })
    .catch((error) => {
      if (/not loaded|not (?:be )?found/i.test(error.stderr ?? "")) return { stdout: "" };
      throw error;
    });
  const pid = Number(stdout.trim());
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

async function savedRuntimePid({ pid, unitName, tokenFile, url }: RuntimeState): Promise<number | undefined> {
  if (isRuntimeProcess(pid, tokenFile, url)) return pid;
  const mainPid = unitName ? await unitMainPid(unitName) : undefined;
  return mainPid && isRuntimeProcess(mainPid, tokenFile, url) ? mainPid : undefined;
}

function signalRuntime(pid: number): void {
  try {
    process.kill(-pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    try {
      process.kill(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function stopUnit(unitName: string): Promise<void> {
  await exec("systemctl", ["--user", "stop", unitName], { timeout: 5000 }).catch((error) => {
    if (!/not loaded|not (?:be )?found/i.test(error.stderr ?? "")) throw error;
  });
}

async function stop(state: RuntimeState): Promise<void> {
  if (state.unitName) await stopUnit(state.unitName);
  else if (isRuntimeProcess(state.pid, state.tokenFile, state.url)) signalRuntime(state.pid);
}

async function waitUntilReady(logFd: number, offset: number, pid: number, tokenFile: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  const chunk = Buffer.alloc(8192);
  let tail = "";
  let url: string | undefined;
  while (Date.now() < deadline && isRuntimeProcess(pid, tokenFile)) {
    if (!url) {
      const size = fs.readSync(logFd, chunk, 0, chunk.length, offset);
      offset += size;
      tail += chunk.toString("utf8", 0, size);
      url = /listening on:\s+(ws:\/\/127\.0\.0\.1:[1-9]\d{0,4})(?=\s)/.exec(tail)?.[1];
      tail = tail.slice(-128);
      if (!url && size === chunk.length) continue;
    }
    if (url && await ready(url, Math.max(1, Math.min(1000, deadline - Date.now()))) &&
        isRuntimeProcess(pid, tokenFile)) return url;
    await delay(50);
  }
  throw new Error("Codex runtime did not become ready");
}

async function startRuntime(dir: string, binaryOverride?: string): Promise<RuntimeConnection> {
  const existing = readState(dir);
  if (existing) {
    let pid = await savedRuntimePid(existing);
    if (pid) {
      const token = fs.readFileSync(existing.tokenFile, "utf8").trim();
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid token for live Codex runtime");
      for (let attempt = 0; attempt < 3 && pid; attempt++) {
        const available = await ready(existing.url);
        if (!isRuntimeProcess(pid, existing.tokenFile, existing.url)) {
          pid = await savedRuntimePid(existing);
        } else if (available) {
          return { url: existing.url, token, pid, unitName: existing.unitName, reused: true };
        }
        if (attempt < 2 && pid) await delay(100);
      }
      if (pid) throw new Error(`Live Codex runtime (PID ${pid}) is not ready at ${existing.url}`);
    }
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const tokenFile = path.join(dir, "runtime.token");
  const logFile = path.join(dir, "runtime.log");
  const stateFile = path.join(dir, "runtime.json");
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  const { binary, command, args } = resolveCodexCommand(binaryOverride);
  const serverArgs = [...args, "app-server", "--listen", EPHEMERAL_URL, "--ws-auth", "capability-token", "--ws-token-file", tokenFile];
  const logFd = fs.openSync(logFile, "a+", 0o600);
  let url: string | undefined;
  let pid: number | undefined;
  let unitName: string | undefined;
  try {
    fs.rmSync(tokenFile, { force: true });
    fs.writeFileSync(tokenFile, token, { mode: 0o600, flag: "wx" });
    if (process.env.CODEX_RUNTIME_NO_SYSTEMD !== "1" && !process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY) {
      const unit = `codex-mcp-agy-${createHash("sha256").update(dir).update(randomBytes(8)).digest("hex").slice(0, 12)}`;
      const logOffset = fs.fstatSync(logFd).size;
      const env = ["PATH", "CODEX_HOME", "OPENAI_BASE_URL", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => `--setenv=${name}`);
      try {
        await exec("systemd-run", [
          "--user", `--unit=${unit}`, "--description=codex-mcp-agy runtime", "--collect",
          "--service-type=exec", "--expand-environment=no", "--same-dir", "--slice=app.slice",
          `--property=StandardOutput=append:${logFile}`,
          `--property=StandardError=append:${logFile}`, ...env, "--", command, ...serverArgs,
        ], { timeout: 5000 });
        unitName = unit;
        const mainPid = await unitMainPid(unit);
        if (!mainPid) throw new Error("Codex runtime has no MainPID");
        url = await waitUntilReady(logFd, logOffset, mainPid, tokenFile);
        pid = mainPid;
      } catch (error) {
        fs.writeSync(logFd, `systemd runtime startup: ${String(error)}\n`);
        if (unitName || (error as { killed?: boolean }).killed) {
          await stopUnit(unit);
        }
        unitName = undefined;
      }
    }
    if (!pid || !url) {
      const logOffset = fs.fstatSync(logFd).size;
      const child = spawn(command, serverArgs, { detached: true, stdio: ["ignore", logFd, logFd] });
      const spawned = new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.on("error", reject);
      });
      pid = child.pid;
      child.unref();
      await spawned;
      if (!pid) throw new Error("Codex runtime has no PID");
      url = await waitUntilReady(logFd, logOffset, pid, tokenFile);
    }
    const state: RuntimeState = { url, tokenFile, pid, unitName, binary, startedAt: new Date().toISOString() };
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tempFile, stateFile);
    return { url, token, pid, unitName, reused: false };
  } catch (error) {
    if (unitName) await stopUnit(unitName);
    else if (pid) signalRuntime(pid);
    fs.rmSync(tempFile, { force: true });
    fs.rmSync(tokenFile, { force: true });
    throw new Error(`Failed to start Codex runtime (see ${logFile}): ${String(error)}`);
  } finally {
    fs.closeSync(logFd);
  }
}

export async function ensureRuntime(stateDir: string, binaryOverride?: string): Promise<RuntimeConnection> {
  const dir = path.resolve(stateDir);
  const pending = starting.get(dir);
  if (pending) return { ...await pending, reused: true };
  const startup = startRuntime(dir, binaryOverride);
  starting.set(dir, startup);
  try {
    return await startup;
  } finally {
    starting.delete(dir);
  }
}

export async function stopRuntime(stateDir: string): Promise<void> {
  const dir = path.resolve(stateDir);
  await starting.get(dir)?.catch(() => {});
  const state = readState(dir);
  if (state) await stop(state);
  fs.rmSync(path.join(dir, "runtime.json"), { force: true });
  fs.rmSync(path.join(dir, "runtime.token"), { force: true });
}
