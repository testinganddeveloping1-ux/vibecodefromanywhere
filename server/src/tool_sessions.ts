import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ToolSessionTool = "codex" | "claude" | "opencode";

export type ToolSessionSummary = {
  tool: ToolSessionTool;
  id: string; // tool-native session id (UUID)
  cwd: string; // project/workspace path
  createdAt: number | null;
  updatedAt: number; // ms since epoch
  title: string | null;
  preview: string | null;
  messageCount: number | null;
  gitBranch: string | null;
};

export type ToolSessionMessage = {
  role: "user" | "assistant";
  ts: number;
  text: string;
  blocks?: ToolSessionMessageBlock[];
};

export type ToolSessionMessageBlock = {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text: string;
  name?: string;
  callId?: string;
};

function parseJsonLoose(raw: string): any | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // Some CLIs may print a prefix before the JSON (logs/progress). Try to salvage by
    // slicing from the first object/array start.
    const idxObj = t.indexOf("{");
    const idxArr = t.indexOf("[");
    const idx =
      idxObj >= 0 && idxArr >= 0 ? Math.min(idxObj, idxArr) : idxObj >= 0 ? idxObj : idxArr >= 0 ? idxArr : -1;
    if (idx < 0) return null;
    try {
      return JSON.parse(t.slice(idx));
    } catch {
      return null;
    }
  }
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isUnderAnyRoot(p: string, roots: string[]): boolean {
  if (roots.length === 0) return true;
  for (const r of roots) {
    const rel = path.relative(r, p);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
  }
  return false;
}

function readFirstLine(filePath: string, maxBytes = 128 * 1024): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    if (n <= 0) return null;
    const s = buf.subarray(0, n).toString("utf8");
    const idx = s.indexOf("\n");
    return idx >= 0 ? s.slice(0, idx) : s;
  } catch {
    return null;
  } finally {
    try {
      if (fd != null) fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function readTail(filePath: string, maxBytes = 256 * 1024): string {
  let fd: number | null = null;
  try {
    const st = fs.statSync(filePath);
    const size = Number(st.size ?? 0);
    const start = Math.max(0, size - maxBytes);
    const len = Math.max(0, size - start);
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    if (n <= 0) return "";
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    try {
      if (fd != null) fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function safeJsonParse(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function takeText(s: string | null | undefined, max = 260): string | null {
  const v = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  if (!v) return null;
  return v.length > max ? v.slice(0, Math.max(0, max - 3)) + "..." : v;
}

function parseTs(v: any): number {
  if (typeof v !== "string") return Date.now();
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : Date.now();
}

function cleanText(v: string): string {
  return v.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
}

function clampText(v: string, max = 12000): string {
  if (v.length <= max) return v;
  return `${v.slice(0, Math.max(0, max - 15))}\n\n...[truncated]`;
}

function isObj(v: any): v is Record<string, any> {
  return typeof v === "object" && v !== null;
}

function extractAnyText(v: any, depth = 0): string {
  if (depth > 4) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (!v) return "";
  if (Array.isArray(v)) {
    return v
      .map((it) => extractAnyText(it, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (!isObj(v)) return "";
  if (typeof v.text === "string") return v.text;
  if (typeof v.thinking === "string") return v.thinking;
  if (typeof v.output === "string") return v.output;
  if (typeof v.content === "string") return v.content;
  if (Array.isArray(v.content)) {
    return v.content
      .map((it: any) => extractAnyText(it, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function formatStructuredValue(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") {
    const raw = v.trim();
    if (!raw) return "";
    const parsed = safeJsonParse(raw);
    if (parsed && typeof parsed === "object") {
      try {
        return JSON.stringify(parsed, null, 2);
      } catch {
        return v;
      }
    }
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return "";
  }
}

function normalizeBlocks(blocks: ToolSessionMessageBlock[]): ToolSessionMessageBlock[] {
  const out: ToolSessionMessageBlock[] = [];
  for (const b of blocks) {
    const text = clampText(cleanText(String(b?.text ?? "")));
    if (!text) continue;
    out.push({
      type: b.type,
      text,
      name: typeof b.name === "string" && b.name.trim() ? b.name.trim() : undefined,
      callId: typeof b.callId === "string" && b.callId.trim() ? b.callId.trim() : undefined,
    });
  }
  return out;
}

function messageFromBlocks(
  role: "user" | "assistant",
  ts: number,
  blocks: ToolSessionMessageBlock[],
): ToolSessionMessage | null {
  const normalized = normalizeBlocks(blocks);
  if (normalized.length === 0) return null;
  const text = normalized.map((b) => b.text).join("\n\n");
  return { role, ts, text, blocks: normalized };
}

function formatToolCallText(name: string, input: any): string {
  const head = cleanText(name) ? `Tool: ${cleanText(name)}` : "Tool call";
  const body = cleanText(formatStructuredValue(input));
  return body ? `${head}\n${body}` : head;
}

function codexMessageText(content: any): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const it of content) {
    const text = cleanText(extractAnyText(it));
    if (text) parts.push(text);
  }
  return cleanText(parts.join(""));
}

function codexReasoningText(payload: any): string {
  const summary = Array.isArray(payload?.summary) ? payload.summary : [];
  const parts: string[] = [];
  for (const it of summary) {
    const text = cleanText(extractAnyText(it));
    if (text) parts.push(text);
  }
  return cleanText(parts.join("\n"));
}

function extractCodexPreviewFromTail(rawTail: string): { title: string | null; preview: string | null } {
  const lines = rawTail.split("\n").filter(Boolean);
  let lastAssistant: string | null = null;
  let lastUser: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = safeJsonParse(lines[i] ?? "");
    if (!obj) continue;

    // Preferred: full message records (response_item -> message -> role).
    if (obj.type === "response_item" && obj.payload?.type === "message") {
      const role = String(obj.payload?.role ?? "");
      if (role !== "assistant" && role !== "user") continue;
      const content = Array.isArray(obj.payload?.content) ? obj.payload.content : [];
      const parts: string[] = [];
      for (const it of content) {
        const t = typeof it?.text === "string" ? it.text : "";
        if (t) parts.push(t);
      }
      const joined = parts.join("").trim();
      if (!joined) continue;
      if (role === "assistant" && !lastAssistant) lastAssistant = joined;
      if (role === "user" && !lastUser) lastUser = joined;
    }

    // Fallback: "user_message" (shorter, but common and easy).
    if (obj.type === "event_msg" && obj.payload?.type === "user_message" && typeof obj.payload?.message === "string") {
      if (!lastUser) lastUser = obj.payload.message;
    }

    if (lastAssistant && lastUser) break;
  }

  const title = takeText(lastUser, 80);
  const preview = takeText(lastAssistant ?? lastUser, 240);
  return { title, preview };
}

function extractClaudeText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const it of content) {
    if (it && typeof it === "object") {
      if (it.type === "text" && typeof it.text === "string") parts.push(it.text);
      // Keep tool_use visible in previews even if there is no text.
      if (it.type === "tool_use" && typeof it.name === "string") {
        const cmd = typeof it.input?.command === "string" ? it.input.command : "";
        parts.push(cmd ? `[${it.name}] ${cmd}` : `[${it.name}]`);
      }
    }
  }
  return parts.join("\n").trim();
}

function extractClaudeAnyMessageFromLine(obj: any): { role: "user" | "assistant"; content: any; ts: number } | null {
  // Claude logs can contain either:
  // 1) Top-level messages:
  //    { type:"user"|"assistant", message:{ role, content }, timestamp, ... }
  // 2) Progress wrappers (tool streaming / subagents):
  //    { type:"progress", data:{ message:{ type:"user"|"assistant", timestamp, message:{ role, content } } }, timestamp, ... }
  //
  // We normalize both into { role, content, ts } so the preview and chat parsing stay robust.

  // Top-level message
  if (isObj(obj?.message)) {
    const role = String(obj.message?.role ?? obj.type ?? "");
    if (role === "user" || role === "assistant") {
      return { role, content: obj.message?.content, ts: parseTs(obj.timestamp) };
    }
  }

  // Progress message wrapper
  if (String(obj?.type ?? "") === "progress" && isObj(obj?.data) && isObj((obj as any).data?.message)) {
    const dm = (obj as any).data.message;
    const inner = isObj(dm?.message) ? dm.message : null;
    const role = String(inner?.role ?? dm?.type ?? "");
    if (role !== "user" && role !== "assistant") return null;
    // Prefer inner timestamp if present; fall back to outer.
    const ts = parseTs(dm?.timestamp ?? obj.timestamp);
    return { role, content: inner?.content, ts };
  }

  return null;
}

function extractClaudePreviewFromTail(rawTail: string): { title: string | null; preview: string | null } {
  const lines = rawTail.split("\n").filter(Boolean);
  let lastAssistant: string | null = null;
  let lastUser: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = safeJsonParse(lines[i] ?? "");
    if (!obj) continue;
    const rec = extractClaudeAnyMessageFromLine(obj);
    if (!rec) continue;
    const text = extractClaudeText(rec.content);
    if (!text) continue;
    if (rec.role === "assistant" && !lastAssistant) lastAssistant = text;
    if (rec.role === "user" && !lastUser) lastUser = text;
    if (lastAssistant && lastUser) break;
  }
  const title = takeText(lastUser, 80);
  const preview = takeText(lastAssistant ?? lastUser, 240);
  return { title, preview };
}

function isoToMs(v: any): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function walkFiles(dir: string, out: string[], opts?: { maxFiles?: number }) {
  if (opts?.maxFiles && out.length >= opts.maxFiles) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (opts?.maxFiles && out.length >= opts.maxFiles) return;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(p, out, opts);
      continue;
    }
    if (ent.isFile() && p.endsWith(".jsonl")) out.push(p);
  }
}

function readHead(filePath: string, maxBytes = 256 * 1024): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    if (n <= 0) return "";
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    try {
      if (fd != null) fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function extractClaudeHeadMeta(rawHead: string): { cwd: string | null; createdAt: number | null; title: string | null; gitBranch: string | null } {
  const lines = rawHead.split("\n").filter(Boolean);
  let cwd: string | null = null;
  let createdAt: number | null = null;
  let title: string | null = null;
  let gitBranch: string | null = null;

  for (let i = 0; i < Math.min(lines.length, 80); i++) {
    const obj = safeJsonParse(lines[i] ?? "");
    if (!obj) continue;

    if (!cwd && typeof obj?.cwd === "string" && obj.cwd.trim()) cwd = obj.cwd.trim();
    if (!gitBranch && typeof obj?.gitBranch === "string" && obj.gitBranch.trim()) gitBranch = obj.gitBranch.trim();
    if (!createdAt && typeof obj?.timestamp === "string") createdAt = isoToMs(obj.timestamp) ?? null;

    // Title: first user prompt we can see (string or content array).
    if (!title) {
      const rec = extractClaudeAnyMessageFromLine(obj);
      if (rec && rec.role === "user") {
        const text = extractClaudeText(rec.content);
        const t = takeText(text, 80);
        if (t) title = t;
      }
    }

    if (cwd && createdAt && title && gitBranch) break;
  }

  return { cwd: cwd ? path.resolve(expandHome(cwd)) : null, createdAt, title, gitBranch };
}

function parseClaudeHistoryIndex(): Map<string, { project: string; ts: number }> {
  const out = new Map<string, { project: string; ts: number }>();
  const historyPath = path.join(os.homedir(), ".claude", "history.jsonl");
  if (!fs.existsSync(historyPath)) return out;

  let raw = "";
  try {
    const st = fs.statSync(historyPath);
    const size = Number(st.size ?? 0);
    // Avoid accidentally slurping a gigantic file: cap at 12MB by reading the tail.
    if (size > 12 * 1024 * 1024) raw = readTail(historyPath, 12 * 1024 * 1024);
    else raw = fs.readFileSync(historyPath, "utf8");
  } catch {
    raw = "";
  }
  if (!raw) return out;

  const lines = raw.split("\n").filter(Boolean);
  for (const ln of lines) {
    const obj = safeJsonParse(ln);
    if (!obj) continue;
    const sid = typeof obj?.sessionId === "string" ? obj.sessionId.trim() : "";
    const project = typeof obj?.project === "string" ? obj.project.trim() : "";
    if (!sid || !project) continue;
    const ts = Number(obj?.timestamp ?? 0);
    const normProject = path.resolve(expandHome(project));
    const prev = out.get(sid);
    if (!prev || (Number.isFinite(ts) && ts >= prev.ts)) out.set(sid, { project: normProject, ts: Number.isFinite(ts) ? ts : 0 });
  }
  return out;
}

export class ToolSessionIndex {
  private roots: string[];
  private ttlMs: number;
  private lastScanAt = 0;
  private summaries: ToolSessionSummary[] = [];
  private fileByKey = new Map<string, string>(); // `${tool}:${id}` -> filePath

  constructor(opts: { roots: string[]; ttlMs?: number }) {
    this.roots = opts.roots.map((r) => path.resolve(expandHome(r)));
    this.ttlMs = typeof opts.ttlMs === "number" && Number.isFinite(opts.ttlMs) ? Math.max(250, opts.ttlMs) : 2500;
  }

  list(opts?: { refresh?: boolean }): ToolSessionSummary[] {
    this.ensureFresh(Boolean(opts?.refresh));
    return this.summaries.slice();
  }

  get(tool: ToolSessionTool, id: string, opts?: { refresh?: boolean }): ToolSessionSummary | null {
    this.ensureFresh(Boolean(opts?.refresh));
    const key = `${tool}:${id}`;
    const fp = this.fileByKey.get(key);
    if (!fp) return null;
    return this.summaries.find((s) => s.tool === tool && s.id === id) ?? null;
  }

  getMessages(tool: ToolSessionTool, id: string, opts?: { limit?: number; refresh?: boolean }): ToolSessionMessage[] | null {
    this.ensureFresh(Boolean(opts?.refresh));
    const key = `${tool}:${id}`;
    const fp = this.fileByKey.get(key);
    if (!fp) return null;
    // Chat logs can be long; allow larger limits so the UI can "load older" messages.
    // Keep a sane ceiling so we don't accidentally send huge payloads to phones.
    const limit = Math.min(5000, Math.max(20, Number(opts?.limit ?? 160)));

    if (tool === "codex") return parseCodexMessages(fp, limit);
    if (tool === "claude") return parseClaudeMessages(fp, limit);
    return null;
  }

  private ensureFresh(force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastScanAt < this.ttlMs) return;
    this.lastScanAt = now;
    this.rescan();
  }

  private rescan() {
    const next: ToolSessionSummary[] = [];
    const nextFiles = new Map<string, string>();

    // Codex sessions (jsonl logs)
    const codexBase = path.join(os.homedir(), ".codex", "sessions");
    if (fs.existsSync(codexBase)) {
      const files: string[] = [];
      walkFiles(codexBase, files, { maxFiles: 2000 });
      for (const fp of files) {
        const first = readFirstLine(fp);
        if (!first) continue;
        const obj = safeJsonParse(first);
        if (!obj || obj.type !== "session_meta" || !obj.payload || typeof obj.payload !== "object") continue;
        const id = typeof obj.payload.id === "string" ? obj.payload.id : "";
        const cwd = typeof obj.payload.cwd === "string" ? obj.payload.cwd : "";
        if (!id || !cwd) continue;
        const cwdAbs = path.resolve(expandHome(cwd));
        if (!isUnderAnyRoot(cwdAbs, this.roots)) continue;

        let updatedAt = 0;
        try {
          updatedAt = Math.floor(fs.statSync(fp).mtimeMs);
        } catch {
          updatedAt = Date.now();
        }

        const createdAt = isoToMs(obj.payload.timestamp) ?? isoToMs(obj.timestamp) ?? null;
        const tail = readTail(fp, 256 * 1024);
        const pv = extractCodexPreviewFromTail(tail);
        next.push({
          tool: "codex",
          id,
          cwd: cwdAbs,
          createdAt,
          updatedAt,
          title: pv.title,
          preview: pv.preview,
          messageCount: null,
          gitBranch: null,
        });
        nextFiles.set(`codex:${id}`, fp);
      }
    }

    // Claude history index (sessionId -> project path). This covers installations where
    // sessions-index.json is missing or incomplete for a project directory.
    const claudeHistory = parseClaudeHistoryIndex();

    // Claude sessions via per-project sessions-index.json (fast path)
    const claudeProjects = path.join(os.homedir(), ".claude", "projects");
    if (fs.existsSync(claudeProjects)) {
      let dirs: fs.Dirent[] = [];
      try {
        dirs = fs.readdirSync(claudeProjects, { withFileTypes: true });
      } catch {
        dirs = [];
      }
      const indexedClaude = new Set<string>();
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const idxPath = path.join(claudeProjects, d.name, "sessions-index.json");
        if (fs.existsSync(idxPath)) {
          let idx: any = null;
          try {
            idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
          } catch {
            idx = null;
          }
          const entries = Array.isArray(idx?.entries) ? idx.entries : [];
          for (const e of entries) {
            const id = typeof e?.sessionId === "string" ? e.sessionId : "";
            const fullPath = typeof e?.fullPath === "string" ? e.fullPath : "";
            const projectPath = typeof e?.projectPath === "string" ? e.projectPath : "";
            if (!id || !fullPath || !projectPath) continue;
            const cwdAbs = path.resolve(expandHome(projectPath));
            if (!isUnderAnyRoot(cwdAbs, this.roots)) continue;
            const updatedAt = Number.isFinite(Number(e?.fileMtime)) ? Number(e.fileMtime) : Date.now();
            const createdAt = isoToMs(e?.created) ?? null;
            const title = typeof e?.firstPrompt === "string" ? takeText(e.firstPrompt, 80) : null;
            const messageCount = Number.isFinite(Number(e?.messageCount)) ? Number(e.messageCount) : null;
            const gitBranch = typeof e?.gitBranch === "string" ? e.gitBranch : null;

            let preview: string | null = null;
            try {
              const tail = readTail(fullPath, 256 * 1024);
              preview = extractClaudePreviewFromTail(tail).preview;
            } catch {
              preview = null;
            }

            next.push({
              tool: "claude",
              id,
              cwd: cwdAbs,
              createdAt,
              updatedAt,
              title,
              preview,
              messageCount,
              gitBranch,
            });
            nextFiles.set(`claude:${id}`, fullPath);
            indexedClaude.add(id);
          }
        }

        // Fallback: some Claude installations omit sessions-index.json for a project.
        // Scan top-level .jsonl logs and infer project path via ~/.claude/history.jsonl or log metadata.
        let files: string[] = [];
        try {
          files = fs
            .readdirSync(path.join(claudeProjects, d.name), { withFileTypes: true })
            .filter((ent) => ent.isFile() && ent.name.endsWith(".jsonl"))
            .map((ent) => path.join(claudeProjects, d.name, ent.name));
        } catch {
          files = [];
        }

        // Avoid pathologically large scans: cap per-project.
        if (files.length > 800) files = files.slice(0, 800);

        for (const fp of files) {
          const base = path.basename(fp);
          const id = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : "";
          if (!id || indexedClaude.has(id)) continue;

          // Prefer history index (accurate), then parse log head for cwd.
          const fromHist = claudeHistory.get(id)?.project ?? null;
          // Even if history provides cwd, we still parse a small head slice for title/gitBranch.
          const head = readHead(fp, 160 * 1024);
          const meta = head ? extractClaudeHeadMeta(head) : { cwd: null, createdAt: null, title: null, gitBranch: null };
          const cwdAbs = fromHist ? path.resolve(expandHome(fromHist)) : meta.cwd;
          if (!cwdAbs || !isUnderAnyRoot(cwdAbs, this.roots)) continue;

          let updatedAt = 0;
          try {
            updatedAt = Math.floor(fs.statSync(fp).mtimeMs);
          } catch {
            updatedAt = Date.now();
          }

          let preview: string | null = null;
          try {
            const tail = readTail(fp, 256 * 1024);
            preview = extractClaudePreviewFromTail(tail).preview;
          } catch {
            preview = null;
          }

          next.push({
            tool: "claude",
            id,
            cwd: cwdAbs,
            createdAt: meta.createdAt,
            updatedAt,
            title: meta.title,
            preview,
            messageCount: null,
            gitBranch: meta.gitBranch,
          });
          nextFiles.set(`claude:${id}`, fp);
          indexedClaude.add(id);
        }
      }
    }

    // Sort by recent activity.
    next.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
    this.summaries = next;
    this.fileByKey = nextFiles;
  }
}

function parseCodexMessages(filePath: string, limit: number): ToolSessionMessage[] {
  // For responsiveness we parse the tail first (usually enough for chat history),
  // and only fall back to full-file if we can't extract anything.
  const tail = readTail(filePath, 512 * 1024);
  const parsed = parseCodexMessagesFromText(tail);
  // If the tail doesn't contain enough messages to satisfy the requested limit,
  // we must parse the full file so "load older" can show earlier messages.
  if (parsed.length >= limit) return parsed.slice(-limit);

  // Full parse (still reasonable for typical session logs).
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    raw = tail;
  }
  return parseCodexMessagesFromText(raw).slice(-limit);
}

function parseCodexMessagesFromText(raw: string): ToolSessionMessage[] {
  const out: ToolSessionMessage[] = [];
  const lines = raw.split("\n").filter(Boolean);
  for (const ln of lines) {
    const obj = safeJsonParse(ln);
    if (!obj) continue;
    if (obj.type !== "response_item" || !isObj(obj.payload)) continue;
    const payload = obj.payload;
    const ts = parseTs(obj.timestamp);
    const pType = String(payload.type ?? "");

    if (pType === "message") {
      const role = String(payload.role ?? "");
      if (role !== "user" && role !== "assistant") continue;
      const text = codexMessageText(payload.content);
      const msg = messageFromBlocks(role, ts, [{ type: "text", text }]);
      if (msg) out.push(msg);
      continue;
    }

    if (pType === "reasoning") {
      const text = codexReasoningText(payload);
      const msg = messageFromBlocks("assistant", ts, [{ type: "thinking", text }]);
      if (msg) out.push(msg);
      continue;
    }

    if (pType === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "";
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const text = formatToolCallText(name, payload.arguments);
      const msg = messageFromBlocks("assistant", ts, [{ type: "tool_use", text, name, callId }]);
      if (msg) out.push(msg);
      continue;
    }

    if (pType === "function_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const outputText = cleanText(extractAnyText(payload.output));
      const msg = messageFromBlocks("assistant", ts, [{ type: "tool_result", text: outputText, callId }]);
      if (msg) out.push(msg);
    }
  }
  return out;
}

function parseClaudeMessages(filePath: string, limit: number): ToolSessionMessage[] {
  const tail = readTail(filePath, 512 * 1024);
  const parsed = parseClaudeMessagesFromText(tail);
  if (parsed.length >= limit) return parsed.slice(-limit);

  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    raw = tail;
  }
  return parseClaudeMessagesFromText(raw).slice(-limit);
}

function parseClaudeMessagesFromText(raw: string): ToolSessionMessage[] {
  const out: ToolSessionMessage[] = [];
  const lines = raw.split("\n").filter(Boolean);
  for (const ln of lines) {
    const obj = safeJsonParse(ln);
    if (!obj) continue;
    const rec = extractClaudeAnyMessageFromLine(obj);
    if (!rec) continue;
    const role = rec.role;
    const ts = rec.ts;
    const content = Array.isArray(rec.content) ? rec.content : [];
    const blocks: ToolSessionMessageBlock[] = [];

    if (Array.isArray(rec.content)) {
      for (const it of content) {
        if (!isObj(it)) continue;
        const t = String(it.type ?? "");
        if (t === "text") {
          blocks.push({ type: "text", text: extractAnyText(it.text ?? it) });
          continue;
        }
        if (t === "thinking") {
          blocks.push({ type: "thinking", text: extractAnyText(it.thinking ?? it.text ?? it) });
          continue;
        }
        if (t === "tool_use") {
          const name = typeof it.name === "string" ? it.name : "";
          const callId = typeof it.id === "string" ? it.id : undefined;
          blocks.push({
            type: "tool_use",
            text: formatToolCallText(name, it.input),
            name,
            callId,
          });
          continue;
        }
        if (t === "tool_result") {
          const callId = typeof it.tool_use_id === "string" ? it.tool_use_id : undefined;
          const base = cleanText(extractAnyText(it.content ?? it));
          const text = it.is_error === true && base ? `[error]\n${base}` : base;
          blocks.push({ type: "tool_result", text, callId });
        }
      }
    }

    if (blocks.length === 0) {
      const fallback = extractClaudeText(rec.content);
      if (fallback) blocks.push({ type: "text", text: fallback });
    }
    const msg = messageFromBlocks(role, ts, blocks);
    if (msg) out.push(msg);
  }
  return out;
}

export function parseOpenCodeSessionList(raw: string): ToolSessionSummary[] {
  const parsed = parseJsonLoose(raw);
  if (!Array.isArray(parsed)) return [];

  const out: ToolSessionSummary[] = [];
  for (const it of parsed) {
    if (!isObj(it)) continue;
    const id = typeof it.id === "string" ? it.id.trim() : "";
    const dir = typeof it.directory === "string" ? it.directory.trim() : "";
    if (!id || !dir) continue;

    const cwdAbs = path.resolve(expandHome(dir));
    const createdAt = Number.isFinite(Number((it as any).created)) ? Number((it as any).created) : null;
    const updatedAt = Number.isFinite(Number((it as any).updated)) ? Number((it as any).updated) : createdAt ?? Date.now();
    const title = takeText(typeof (it as any).title === "string" ? (it as any).title : null, 90);

    out.push({
      tool: "opencode",
      id,
      cwd: cwdAbs,
      createdAt,
      updatedAt,
      title,
      preview: null,
      messageCount: null,
      gitBranch: null,
    });
  }

  out.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
  return out;
}

export function parseOpenCodeExport(
  raw: string,
  opts?: { limit?: number; idFallback?: string },
): { session: ToolSessionSummary | null; messages: ToolSessionMessage[] } {
  const limit = Math.min(5000, Math.max(20, Number(opts?.limit ?? 160)));
  const parsed = parseJsonLoose(raw);
  if (!isObj(parsed)) return { session: null, messages: [] };

  const info = isObj((parsed as any).info) ? (parsed as any).info : {};
  const sid = (typeof info.id === "string" ? info.id.trim() : "") || (opts?.idFallback ?? "");
  if (!sid) return { session: null, messages: [] };

  const dir = typeof info.directory === "string" ? info.directory.trim() : "";
  const cwdAbs = dir ? path.resolve(expandHome(dir)) : "";
  const time = isObj(info.time) ? info.time : {};
  const createdAt = Number.isFinite(Number((time as any).created)) ? Number((time as any).created) : null;
  const updatedAt = Number.isFinite(Number((time as any).updated)) ? Number((time as any).updated) : createdAt ?? Date.now();
  const title = takeText(typeof info.title === "string" ? info.title : null, 90);

  const msgs = Array.isArray((parsed as any).messages) ? (parsed as any).messages : [];
  const out: ToolSessionMessage[] = [];
  for (const m of msgs) {
    if (!isObj(m)) continue;
    const mi = isObj((m as any).info) ? (m as any).info : {};
    const role = String(mi.role ?? "");
    if (role !== "user" && role !== "assistant") continue;
    const ts = Number.isFinite(Number(mi?.time?.created)) ? Number(mi.time.created) : Date.now();

    const parts = Array.isArray((m as any).parts) ? (m as any).parts : [];
    const blocks: ToolSessionMessageBlock[] = [];

    for (const p of parts) {
      if (!isObj(p)) continue;
      const t = String((p as any).type ?? "");
      if (t === "text") {
        const text = cleanText(extractAnyText((p as any).text ?? p));
        if (text) blocks.push({ type: "text", text });
        continue;
      }
      if (t === "reasoning") {
        const text = cleanText(extractAnyText((p as any).text ?? p));
        if (text) blocks.push({ type: "thinking", text });
        continue;
      }
      if (t === "tool") {
        const name = typeof (p as any).tool === "string" ? String((p as any).tool) : "";
        const callId = typeof (p as any).callID === "string" ? String((p as any).callID) : undefined;
        const state = isObj((p as any).state) ? (p as any).state : {};
        const status = typeof (state as any).status === "string" ? String((state as any).status) : "";
        const input = (state as any).input;
        const output = (state as any).output;

        blocks.push({
          type: "tool_use",
          text: formatToolCallText(name, input),
          name,
          callId,
        });

        const base = cleanText(extractAnyText(output));
        const text = status && status !== "completed" ? (base ? `[${status}]\n${base}` : `[${status}]`) : base;
        if (text) blocks.push({ type: "tool_result", text, callId });
        continue;
      }
      // ignore step-start/step-finish and any unknown parts
    }

    const msg = messageFromBlocks(role as any, ts, blocks);
    if (msg) out.push(msg);
  }

  const lastAssistant = (() => {
    for (let i = out.length - 1; i >= 0; i--) if (out[i]!.role === "assistant") return out[i]!.text;
    return null;
  })();
  const lastUser = (() => {
    for (let i = out.length - 1; i >= 0; i--) if (out[i]!.role === "user") return out[i]!.text;
    return null;
  })();

  const session: ToolSessionSummary = {
    tool: "opencode",
    id: sid,
    cwd: cwdAbs || (dir ? dir : "(unknown)"),
    createdAt,
    updatedAt,
    title,
    preview: takeText(lastAssistant ?? lastUser, 240),
    messageCount: out.length,
    gitBranch: null,
  };

  return { session, messages: out.slice(-limit) };
}
