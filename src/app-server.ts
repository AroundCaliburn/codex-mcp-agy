import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { ensureRuntime, resolveCodexCommand, type RuntimeConnection } from "./runtime.js";
import { resolveStateFilePath } from "./store.js";

export { resolveCodexCommand } from "./runtime.js";

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

type Transport = "stdio" | "ws";

interface ClientOptions {
  stateDir?: string;
  transport?: Transport;
}

type Connection = ChildProcessWithoutNullStreams | WebSocket;

const REQUEST_TIMEOUT_MS = 30_000;

export class RpcTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`Codex app-server RPC timed out: ${method}`);
  }
}

export class AppServerClient {
  readonly executable: ReturnType<typeof resolveCodexCommand>;
  readonly transport: Transport;
  private runtime?: RuntimeConnection;
  private connection?: Connection;
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
    private readonly binary?: string,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
    private readonly options: ClientOptions = {},
  ) {
    this.executable = resolveCodexCommand(binary);
    const transport = options.transport ?? process.env.CODEX_APP_SERVER_TRANSPORT;
    this.transport = transport === "ws" || (transport !== "stdio" && !binary && typeof globalThis.WebSocket === "function")
      ? "ws"
      : "stdio";
  }

  getRuntimeStatus() {
    if (!this.runtime) return { transport: this.transport, connected: Boolean(this.connection) };
    const { url, pid, unitName, reused } = this.runtime;
    return { transport: this.transport, connected: Boolean(this.connection), url, pid, unitName, reused };
  }

  connect(): Promise<void> {
    if (this.closed) throw new Error("Codex app-server client is closed");
    if (this.stopping) throw new Error("Codex app-server connection is resetting");
    if (this.ready) return this.ready;

    const ready = this.open().then(async (connection) => {
      await this.call(connection, "initialize", {
        clientInfo: { name: "codex-mcp-agy", version: "0.2.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, 1);
      this.write({ method: "initialized" }, connection);
    }).catch(async (error: Error) => {
      if (this.ready === ready) {
        await this.reset();
        if (this.ready === ready) this.ready = undefined;
      }
      throw error;
    });
    this.ready = ready;
    return ready;
  }

  private async open(): Promise<Connection> {
    if (this.transport === "ws") {
      if (typeof globalThis.WebSocket !== "function") throw new Error("WebSocket transport requires Node.js 22.4 or later");
      this.runtime = await ensureRuntime(this.options.stateDir ?? path.dirname(resolveStateFilePath()), this.binary);
      if (this.closed) throw new Error("Codex app-server client is closed");
      const { url, token } = this.runtime;
      const NodeWebSocket = WebSocket as typeof WebSocket & { new (url: string, options: WebSocketInit): WebSocket };
      const socket = new NodeWebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      this.connection = socket;
      socket.addEventListener("message", (event) => this.receive(socket, String(event.data)));
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new RpcTimeoutError("WebSocket open")), this.requestTimeoutMs);
        const fail = (error: Error) => {
          clearTimeout(timeout);
          reject(error);
          this.disconnect(socket, error);
        };
        socket.addEventListener("open", () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
        socket.addEventListener("error", () => {
          fail(new Error("Codex app-server WebSocket connection failed"));
          socket.close();
        }, { once: true });
        socket.addEventListener("close", () => fail(new Error("Codex app-server WebSocket closed")), { once: true });
      });
      return socket;
    }

    const { command, args } = this.executable;
    const child = spawn(command, [...args, "app-server", "--listen", "stdio://"]);
    this.connection = child;
    child.stderr.pipe(process.stderr, { end: false });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(child, line));

    const disconnect = (error: Error) => {
      lines.close();
      this.disconnect(child, error);
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
    return child;
  }

  private receive(connection: Connection, data: string): void {
    if (this.connection !== connection || this.stopping || !data.trim()) return;
    try {
      const { id, method, params, result, error } = JSON.parse(data) as RpcMessage;
      if (typeof method === "string") {
        if (typeof id === "number" || typeof id === "string") {
          if (this.callbacks.request) this.callbacks.request(id, method, params);
          else this.reject(id, `Unsupported server request: ${method}`);
        } else {
          this.callbacks.notification?.(method, params);
        }
      } else if (typeof id === "number") {
        const call = this.pending.get(id);
        if (error) call?.reject(new Error(error.message));
        else call?.resolve(result);
      }
    } catch (error) {
      console.error("[codex-mcp-agy] Failed to handle app-server message:", error);
    }
  }

  private disconnect(connection: Connection, error: Error): void {
    if (this.connection !== connection) return;
    this.connection = undefined;
    this.ready = undefined;
    for (const call of this.pending.values()) call.reject(error);
    this.pending = new Map();
    this.callbacks.disconnect?.(error);
  }

  private write(message: RpcMessage, connection = this.connection): void {
    if (!connection || connection !== this.connection || this.stopping || this.closed) {
      throw new Error("Codex app-server is disconnected");
    }
    const data = JSON.stringify({ jsonrpc: "2.0", ...message });
    if ("stdin" in connection) {
      if (!connection.stdin.writable) throw new Error("Codex app-server is disconnected");
      connection.stdin.write(data + "\n");
    } else {
      if (connection.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is disconnected");
      connection.send(data);
    }
  }

  private async call(connection: Connection, method: string, params?: unknown, id = this.nextId++): Promise<unknown> {
    const pending = this.pending;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new RpcTimeoutError(method)), this.requestTimeoutMs);
        pending.set(id, { resolve, reject });
        this.write({ id, method, params }, connection);
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const ready = this.connect();
    await ready;
    const connection = this.connection;
    if (this.ready !== ready || !connection) throw new Error("Codex app-server is disconnected");
    return await this.call(connection, method, params) as T;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.connect();
    this.write({ method, params });
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  reject(id: RequestId, message: string, code = -32601): void {
    this.write({ id, error: { code, message } });
  }

  reset(): Promise<void> {
    if (this.stopping) return this.stopping;
    const connection = this.connection;
    if (!connection) return Promise.resolve();
    if (!("stdin" in connection)) {
      this.disconnect(connection, new Error("Codex app-server WebSocket closed"));
      connection.close();
      return Promise.resolve();
    }

    const child = connection;
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

  async close(): Promise<void> {
    this.closed = true;
    const ready = this.ready;
    await this.reset();
    await ready?.catch(() => {});
  }

  shutdown(): Promise<void> {
    return this.close();
  }
}
