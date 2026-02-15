import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

type JsonRpcId = number | string;
type JsonRpcNotification = { method: string; params?: unknown };
type JsonRpcServerRequest = { id: JsonRpcId; method: string; params?: unknown };

export type CodexAppServerNotification = { method: string; params: unknown };
export type CodexAppServerRequest = { id: JsonRpcId; method: string; params: unknown };

export type CodexAppServerOptions = {
  codexCommand: string;
  codexArgs: string[];
  log?: (msg: string, data?: any) => void;
};

function backoffMs(attempt: number): number {
  const a = Math.min(9, Math.max(0, Math.floor(attempt)));
  const base = 250 * Math.pow(1.7, a);
  const jitter = Math.random() * 140;
  return Math.min(6000, Math.floor(base + jitter));
}

function looksLikeJson(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

export class CodexAppServer extends EventEmitter {
  private readonly opts: CodexAppServerOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;

  private startPromise: Promise<void> | null = null;
  private stopping = false;
  private reconnectAttempt = 0;
  private reconnectTimer: any = null;

  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void; timer: any }
  >();

  private stdoutBuf = "";

  constructor(opts: CodexAppServerOptions) {
    super();
    this.opts = opts;
  }

  isReady(): boolean {
    return Boolean(this.child && this.ready);
  }

  async ensureStarted(): Promise<void> {
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } catch (e) {
      this.startPromise = null;
      throw e;
    }
  }

  async call<T = any>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted();
    return await this.callInternal<T>(method, params);
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: JsonRpcId, error: unknown): void {
    this.send({ id, error });
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    this.rejectAllPending(new Error("codex_app_server_stopped"));

    const child = this.child;
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.reconnectAttempt = 0;
    this.stdoutBuf = "";

    try {
      child?.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  private rejectAllPending(err: any) {
    for (const rec of this.pending.values()) {
      try {
        clearTimeout(rec.timer);
      } catch {
        // ignore
      }
      try {
        rec.reject(err);
      } catch {
        // ignore
      }
    }
    this.pending.clear();
  }

  private send(payload: any): void {
    const child = this.child;
    if (!child || !child.stdin || (child.stdin as any).destroyed) return;
    try {
      child.stdin.write(JSON.stringify(payload) + "\n");
    } catch {
      // ignore
    }
  }

  private async callInternal<T = any>(method: string, params: unknown): Promise<T> {
    const child = this.child;
    if (!child || !child.stdin || (child.stdin as any).destroyed) throw new Error("codex_app_server_not_ready");

    const id = this.nextId++;
    const payload = { id, method, params } as any;
    const timeoutMs = 60_000;

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex_app_server_timeout:${method}`));
      }, timeoutMs).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify(payload) + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  private async startInternal(): Promise<void> {
    this.stopping = false;
    this.ready = false;
    this.stdoutBuf = "";
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    const log = this.opts.log ?? (() => {});

    // (Re)spawn the app-server process.
    try {
      this.child?.kill("SIGTERM");
    } catch {
      // ignore
    }
    this.child = null;

    // Stdio is the supported transport for production. (WebSocket is experimental/unsupported.)
    const args = [...(this.opts.codexArgs ?? []), "app-server"];

    const inheritedEnv: Record<string, string> = {
      ...(process.env as any),
    };
    // Keep parity with PTY sessions: don't inherit thread pinning env unless user explicitly sets it.
    delete (inheritedEnv as any).CODEX_THREAD_ID;
    delete (inheritedEnv as any).CODEX_SESSION_ID;
    delete (inheritedEnv as any).CODEX_CI;

    const child = spawn(this.opts.codexCommand, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: inheritedEnv,
    });
    this.child = child;

    try {
      child.stdout.setEncoding("utf8");
    } catch {
      // ignore
    }
    try {
      child.stderr.setEncoding("utf8");
    } catch {
      // ignore
    }

    child.stdout.on("data", (d: string) => this.onStdoutData(d));
    child.stderr.on("data", (d: string) => {
      const s = String(d ?? "").trim();
      if (!s) return;
      log("codex app-server stderr", { line: s.slice(0, 520) });
    });

    const handleDisconnect = (reason: string) => {
      if (this.stopping) return;
      log("codex app-server disconnected", { reason });
      this.ready = false;
      this.rejectAllPending(new Error(`codex_app_server_disconnected:${reason}`));
      this.scheduleReconnect();
    };

    child.on("error", (e) => handleDisconnect(String((e as any)?.message ?? e)));
    child.on("exit", (code, sig) => handleDisconnect(`exit:${code ?? "null"}:${sig ?? "null"}`));

    // Initialize handshake:
    // - initialize request
    // - initialized notification
    const res: any = await this.callInternal("initialize", {
      clientInfo: { name: "fromyourphone", title: "FromYourPhone", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.ready = true;
    this.reconnectAttempt = 0;

    try {
      this.emit("ready", res);
    } catch {
      // ignore
    }
  }

  private onStdoutData(d: string) {
    const chunk = String(d ?? "");
    if (!chunk) return;
    this.stdoutBuf += chunk;
    if (this.stdoutBuf.length > 8_000_000) this.stdoutBuf = this.stdoutBuf.slice(-4_000_000);

    // JSONL: one message per line
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const nl = this.stdoutBuf.indexOf("\n");
      if (nl < 0) break;
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      const raw = line.trim();
      if (!raw) continue;
      if (!looksLikeJson(raw)) continue;
      let msg: any = null;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      this.onRpcMessage(msg);
    }
  }

  private onRpcMessage(msg: any) {
    // JSON-RPC response
    if (msg && Object.prototype.hasOwnProperty.call(msg, "id") && !Object.prototype.hasOwnProperty.call(msg, "method")) {
      const id = msg.id;
      if (typeof id === "number") {
        const rec = this.pending.get(id);
        if (rec) {
          this.pending.delete(id);
          try {
            clearTimeout(rec.timer);
          } catch {
            // ignore
          }
          if (Object.prototype.hasOwnProperty.call(msg, "error") && msg.error) rec.reject(msg.error);
          else rec.resolve(msg.result);
        }
      }
      return;
    }

    // JSON-RPC server request (expects a response)
    if (msg && Object.prototype.hasOwnProperty.call(msg, "method") && Object.prototype.hasOwnProperty.call(msg, "id")) {
      const req = msg as JsonRpcServerRequest;
      const out: CodexAppServerRequest = {
        id: req.id,
        method: String(req.method ?? ""),
        params: req.params ?? null,
      };
      try {
        this.emit("request", out);
      } catch {
        // ignore
      }
      return;
    }

    // JSON-RPC notification
    if (msg && Object.prototype.hasOwnProperty.call(msg, "method")) {
      const n = msg as JsonRpcNotification;
      const out: CodexAppServerNotification = { method: String(n.method ?? ""), params: n.params ?? null };
      try {
        this.emit("notification", out);
      } catch {
        // ignore
      }
      return;
    }
  }

  private scheduleReconnect() {
    if (this.stopping) return;
    if (this.reconnectTimer) return;
    const delay = backoffMs(this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping) return;
      // Reset so ensureStarted() restarts cleanly.
      this.startPromise = null;
      void this.ensureStarted().catch(() => {
        // If restart fails, we'll keep retrying via this path.
        this.scheduleReconnect();
      });
    }, delay);
  }
}

