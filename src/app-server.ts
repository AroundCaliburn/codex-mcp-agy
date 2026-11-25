import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";

type RequestId = string | number;

interface RpcMessage {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message: string };
}

interface Callbacks {
  notification?: (method: string, params: unknown) => void;
  request?: (id: RequestId, method: string, params: unknown) => void;
  disconnect?: (error: Error) => void;
}

const REQUEST_TIMEOUT_MS = 30_000;

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

export class RpcTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`Codex app-server RPC timed out: ${method}`);
  }
}

export class AppServerClient {
  readonly executable: ReturnType<typeof resolveCodexCommand>;
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private stopping?: Promise<void>;
  private closed = false;
  private nextId = 2;
  private pending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();

  constructor(
    private readonly callbacks: Callbacks = {},
    binary?: string,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    this.executable = resolveCodexCommand(binary);
  }

  private start(): Promise<void> {
    if (this.closed) throw new Error("Codex app-server client is closed");
    if (this.stopping) throw new Error("Codex app-server connection is resetting");
    if (this.ready) return this.ready;

    const { command, args } = this.executable;
    const child = spawn(command, [...args, "app-server", "--listen", "stdio://"]);
    this.child = child;
    this.pending = new Map();
    child.stderr.pipe(process.stderr, { end: false });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (this.child !== child || this.stopping || !line.trim()) return;
      try {
        const message = JSON.parse(line) as RpcMessage;
        const { id, method, params } = message;
        if (typeof method === "string") {
          if (typeof id === "number" || typeof id === "string") {
            if (this.callbacks.request) this.callbacks.request(id, method, params);
            else this.reject(id, `Unsupported server request: ${method}`);
          } else {
            this.callbacks.notification?.(method, params);
          }
        } else if (typeof id === "number") {
          const call = this.pending.get(id);
          if (message.error) call?.reject(new Error(message.error.message));
          else call?.resolve(message.result);
        }
      } catch (err) {
        console.error("[codex-mcp-agy] Failed to handle app-server message:", err);
      }
    });

    const disconnect = (error: Error) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = undefined;
      lines.close();
      for (const call of this.pending.values()) call.reject(error);
      this.callbacks.disconnect?.(error);
    };
    child.on("error", disconnect);
    child.stdin.on("error", (error) => {
      if (this.stopping) return;
      disconnect(error);
      child.kill();
    });
    child.once("close", (code, signal) => {
      disconnect(new Error(`Codex app-server exited (${signal ?? code})`));
    });

    this.ready = this.call(child, "initialize", {
      clientInfo: { name: "codex-mcp-agy", version: "0.2.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, 1).then(() => this.write(child, { method: "initialized" })).catch((err: Error) => {
      disconnect(err);
      child.kill();
      throw err;
    });
    return this.ready;
  }

  private write(child: ChildProcessWithoutNullStreams | undefined, message: RpcMessage): void {
    if (!child || child !== this.child || this.stopping || !child.stdin.writable) {
      throw new Error("Codex app-server is disconnected");
    }
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  private async call(child: ChildProcessWithoutNullStreams, method: string, params?: unknown, id = this.nextId++): Promise<unknown> {
    if (child !== this.child) throw new Error("Codex app-server is disconnected");
    const pending = this.pending;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new RpcTimeoutError(method)), this.requestTimeoutMs);
        pending.set(id, { resolve, reject });
        this.write(child, { id, method, params });
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const ready = this.start();
    const child = this.child!;
    await ready;
    return await this.call(child, method, params) as T;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const ready = this.start();
    const child = this.child;
    await ready;
    this.write(child, { method, params });
  }

  respond(id: RequestId, result: unknown): void {
    this.write(this.child, { id, result });
  }

  reject(id: RequestId, message: string, code = -32601): void {
    this.write(this.child, { id, error: { code, message } });
  }

  reset(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.stopping = new Promise<void>((resolve) => {
      const terminate = setTimeout(() => child.kill("SIGTERM"), 1000);
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.prependOnceListener("close", () => {
        this.stopping = undefined;
        clearTimeout(terminate);
        clearTimeout(kill);
        resolve();
      });
      child.stdin.end();
    });
    return this.stopping;
  }

  shutdown(): Promise<void> {
    this.closed = true;
    return this.reset();
  }
}
