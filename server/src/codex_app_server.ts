import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import WebSocket from "ws";

type JsonRpcId = number | string;
type JsonRpcResponse = { id: JsonRpcId; result?: unknown; error?: unknown };
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
  private ws: WebSocket | null = null;
  private url: string | null = null;

  private startPromise: Promise<void> | null = null;
  private stopping = false;
  private reconnectAttempt = 0;
  private reconnectTimer: any = null;

  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void; timer: any }
  >();

  constructor(opts: CodexAppServerOptions) {
    super();
    this.opts = opts;
  }

  isReady(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
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
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("codex_app_server_not_ready");

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
        ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method: string, params: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ method, params }));
    } catch {
      // ignore
    }
  }

  respond(id: JsonRpcId, result: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ id, result }));
    } catch {
      // ignore
    }
  }

  respondError(id: JsonRpcId, error: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ id, error }));
    } catch {
      // ignore
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    for (const rec of this.pending.values()) {
      try {
        clearTimeout(rec.timer);
      } catch {
        // ignore
      }
      try {
        rec.reject(new Error("codex_app_server_stopped"));
      } catch {
        // ignore
      }
    }
    this.pending.clear();

    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;

    try {
      this.child?.kill("SIGTERM");
    } catch {
      // ignore
    }
    this.child = null;
    this.url = null;
    this.startPromise = null;
    this.reconnectAttempt = 0;
  }

  private async startInternal(): Promise<void> {
    this.stopping = false;
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
    this.url = null;

    const args = [...(this.opts.codexArgs ?? []), "app-server", "--listen", "ws://127.0.0.1:0"];

    const inheritedEnv: Record<string, string> = {
      ...(process.env as any),
    };
    // Keep parity with PTY sessions: don't inherit thread pinning env unless user explicitly sets it.
    delete (inheritedEnv as any).CODEX_THREAD_ID;
    delete (inheritedEnv as any).CODEX_SESSION_ID;
    delete (inheritedEnv as any).CODEX_CI;

    const child = spawn(this.opts.codexCommand, args, {
      // Keep stdio piped so Node drains buffers and we can safely parse stderr.
      // Using "ignore" can result in `stdin/stdout` being null which complicates typing.
      stdio: ["pipe", "pipe", "pipe"],
      env: inheritedEnv,
    });
    this.child = child;

    // Drain stdout to avoid backpressure blocking the child if it writes there.
    try {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (_d: string) => {
        // ignore
      });
    } catch {
      // ignore
    }

    child.stderr.setEncoding("utf8");
    let stderrBuf = "";
    const urlPromise = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("codex_app_server_start_timeout")), 7000).unref?.();
      child.stderr.on("data", (d: string) => {
        stderrBuf += d;
        if (stderrBuf.length > 20_000) stderrBuf = stderrBuf.slice(-20_000);
        const m = stderrBuf.match(/listening on:\s*(ws:\/\/[^\s]+)/);
        if (m?.[1]) {
          try {
            clearTimeout(t);
          } catch {
            // ignore
          }
          resolve(m[1]);
        }
      });
      child.on("error", (e) => {
        try {
          clearTimeout(t);
        } catch {
          // ignore
        }
        reject(e);
      });
      child.on("exit", (code, sig) => {
        try {
          clearTimeout(t);
        } catch {
          // ignore
        }
        reject(new Error(`codex_app_server_exit:${code ?? "null"}:${sig ?? "null"}`));
      });
    });

    let url = "";
    try {
      url = await urlPromise;
    } catch (e: any) {
      log("codex app-server failed to start", { message: String(e?.message ?? e) });
      throw e;
    }

    this.url = url;
    log("codex app-server listening", { url });

    await this.connectWs(url);
    await this.initialize();
  }

  private async connectWs(url: string): Promise<void> {
    const log = this.opts.log ?? (() => {});
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;

    const ws = new WebSocket(url, {
      perMessageDeflate: false,
      handshakeTimeout: 6000,
    });
    this.ws = ws;

    ws.on("message", (data) => this.onWsMessage(data));

    ws.on("close", () => {
      if (this.stopping) return;
      log("codex app-server ws closed");
      this.scheduleReconnect();
    });

    ws.on("error", (e) => {
      if (this.stopping) return;
      log("codex app-server ws error", { message: String((e as any)?.message ?? e) });
      try {
        ws.close();
      } catch {
        // ignore
      }
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("codex_app_server_ws_timeout")), 6000).unref?.();
      ws.on("open", () => {
        try {
          clearTimeout(t);
        } catch {
          // ignore
        }
        resolve();
      });
      ws.on("error", (e) => {
        try {
          clearTimeout(t);
        } catch {
          // ignore
        }
        reject(e);
      });
    });
  }

  private async initialize(): Promise<void> {
    // App-server requires initialize. We opt into experimental API so we can handle
    // request_user_input and other structured UI events.
    const res: any = await this.call("initialize", {
      clientInfo: { name: "fromyourphone", title: "FromYourPhone", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    // LSP-style handshake: acknowledge initialize.
    try {
      this.notify("initialized", {});
    } catch {
      // ignore
    }
    try {
      this.emit("ready", res);
    } catch {
      // ignore
    }
  }

  private onWsMessage(data: WebSocket.RawData) {
    const raw = data.toString();
    if (!looksLikeJson(raw)) {
      // Defensive: ignore any log lines or non-JSON payloads.
      return;
    }
    let msg: any = null;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

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
