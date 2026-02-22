import React from "react";
import type { ToolSessionMessage, ToolSessionMessageBlock } from "../types";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolKind = "bash" | "read" | "edit" | "write" | "web" | "search" | "mcp" | "orch" | "other";
export type ViewMode = "focus" | "tools" | "all";
export type ToolState = "running" | "ok" | "warn" | "error";

export type OrchestrationAction =
  | "list" | "create" | "dispatch" | "send_task" | "status" | "progress"
  | "sync" | "sync_policy" | "automation_policy" | "cleanup" | "inbox_list"
  | "inbox_respond" | "inbox_dismiss" | "sessions_list" | "session_create"
  | "session_status" | "session_input" | "session_events" | "session_transcript"
  | "session_interrupt" | "session_stop" | "session_kill" | "session_restart"
  | "session_mode_patch" | "session_meta_patch" | "session_delete" | "tasks_list"
  | "task_status" | "task_open_target" | "task_mode_patch" | "task_member_mode_patch"
  | "task_archive" | "tool_sessions_list" | "tool_session_messages"
  | "codex_threads_list" | "codex_thread_read" | "unknown";

export type OrchestrationCommandMeta = {
  action: OrchestrationAction;
  method: string;
  endpoint: string;
  orchestrationId?: string;
  target?: string;
  optionId?: string;
  textPreview?: string;
  runNow?: boolean;
  force?: boolean;
  syncMode?: string;
  intervalMs?: number;
  minDeliveryGapMs?: number;
  deliverToOrchestrator?: boolean;
  questionMode?: string;
  steeringMode?: string;
  questionTimeoutMs?: number;
  reviewIntervalMs?: number;
  yoloMode?: boolean;
  stopSessions?: boolean;
  deleteSessions?: boolean;
  removeWorktrees?: boolean;
  removeRecord?: boolean;
  keepCoordinator?: boolean;
  sessionId?: string;
  taskId?: string;
  memberSessionId?: string;
  toolSessionTool?: string;
  toolSessionId?: string;
  threadId?: string;
};

export type TimelineItem =
  | { id: string; seq: number; ts: number; kind: "assistant" | "user"; text: string }
  | { id: string; seq: number; ts: number; kind: "thinking"; text: string; isLive?: boolean }
  | {
      id: string; seq: number; ts: number; kind: "tool_use";
      callId: string | null; name: string; toolKind: ToolKind;
      summary: string; command: string | null; inputText: string;
      fields: Array<{ key: string; value: string }>;
      orchMeta?: OrchestrationCommandMeta | null;
    }
  | {
      id: string; seq: number; ts: number; kind: "tool_result";
      callId: string | null; text: string; state: ToolState;
      preview: string; isEmpty: boolean;
    }
  | { id: string; seq: number; ts: number; kind: "system"; text: string };

export type ToolUseItem = Extract<TimelineItem, { kind: "tool_use" }>;
export type ToolResultItem = Extract<TimelineItem, { kind: "tool_result" }>;

// ─── Constants ───────────────────────────────────────────────────────────────

export const TYPING_STALE_MS = 60_000;
export const TYPING_STALE_SECONDS = Math.round(TYPING_STALE_MS / 1000);
export const HIDDEN_SYSTEM_EVENT = "__hidden_system_event__";

export const TOOL_ICON: Record<ToolKind | "result", string> = {
  bash: "❯", read: "□", edit: "✎", write: "✦", search: "⌕",
  web: "⊕", mcp: "◈", orch: "◎", other: "◇", result: "↳",
};

export const TOOL_LABEL: Record<ToolKind, string> = {
  bash: "Shell", read: "Read", edit: "Edit", write: "Write",
  search: "Search", web: "Web", mcp: "MCP", orch: "Control Bus", other: "Tool",
};

export const TOOL_COLOR: Record<ToolKind, string> = {
  bash: "#f59e0b", read: "#22c55e", edit: "#f97316", write: "#f97316",
  search: "#60a5fa", web: "#60a5fa", mcp: "#a78bfa", orch: "#10b981", other: "#94a3b8",
};

// ─── String helpers ───────────────────────────────────────────────────────────

export function clamp(text: string, max = 200): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function renderInlinePreview(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let idx = 0;
  let m: RegExpExecArray | null;
  let part = 0;
  while ((m = re.exec(text))) {
    const start = m.index;
    const token = m[0] ?? "";
    if (start > idx) out.push(text.slice(idx, start));
    if (token.startsWith("`")) {
      out.push(React.createElement("code", { key: `${keyBase}-c-${part}`, className: "wrapThinkPreviewCode" }, token.slice(1, -1)));
    } else if (token.startsWith("**")) {
      out.push(React.createElement("strong", { key: `${keyBase}-b-${part}`, className: "wrapThinkPreviewStrong" }, token.slice(2, -2)));
    } else {
      out.push(React.createElement("em", { key: `${keyBase}-i-${part}`, className: "wrapThinkPreviewEm" }, token.slice(1, -1)));
    }
    idx = start + token.length;
    part += 1;
  }
  if (idx < text.length) out.push(text.slice(idx));
  return out.length ? out : [text];
}

export function fmt(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function shortCallId(callId: string | null): string {
  const id = String(callId ?? "").trim();
  if (!id) return "";
  return id.length > 10 ? `${id.slice(0, 10)}…` : id;
}

// ─── Text sanitization ────────────────────────────────────────────────────────

export function stripAnsi(text: string): string {
  return String(text ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[PX^_][\s\S]*?\u001b\\/g, "")
    .replace(/\r/g, "");
}

export function isDecorativeLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 8) return false;
  if (/[A-Za-z0-9]/.test(t)) return false;
  return /^[\s\-=_~`•·.:\u2500-\u259F\u23af\u2010-\u2015\u2043|\\/]+$/u.test(t);
}

export function isSeparatorHeavyLine(line: string): boolean {
  const t = String(line ?? "").trim();
  if (t.length < 10) return false;
  const sepMatches = t.match(/[\-=_~`•·.:\u2500-\u259F\u23af\u2010-\u2015\u2043|\\/]/gu) ?? [];
  return sepMatches.length / Math.max(1, t.length) >= 0.82;
}

export function isTimestampOnlyLine(line: string): boolean {
  const t = String(line ?? "").trim();
  if (!t) return false;
  if (/^\d{1,2}:\d{2}(?::\d{2})?\s*(am|pm)?$/i.test(t)) return true;
  if (/^\d{1,2}:\d{2}\s*(am|pm)\s*[-–—]\s*\d{1,2}:\d{2}\s*(am|pm)$/i.test(t)) return true;
  return false;
}

export function compressDecorativeNoise(raw: string): string {
  const text = String(raw ?? "");
  const lines = text.split("\n");
  if (lines.length < 7) return text;
  const decorativeCount = lines.reduce((acc, line) => acc + (isDecorativeLine(line) ? 1 : 0), 0);
  if (decorativeCount < 4 && decorativeCount / Math.max(1, lines.length) < 0.4) return text;
  const kept = lines.filter((line) => !isDecorativeLine(line));
  return kept.join("\n").trim() || text;
}

export function sanitizeAssistantText(raw: string): string {
  const noAnsi = stripAnsi(raw).replace(/\u001b/g, "");
  const compact = compressDecorativeNoise(noAnsi);
  const lines = compact.split("\n");
  const filtered = lines.filter((line) => {
    if (isDecorativeLine(line)) return false;
    if (isSeparatorHeavyLine(line)) return false;
    if (isTimestampOnlyLine(line)) return false;
    return true;
  });
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function isDecorativeNoiseBlock(raw: string): boolean {
  const lines = stripAnsi(String(raw ?? ""))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  const decorativeLines = lines.filter(
    (l) => isDecorativeLine(l) || isSeparatorHeavyLine(l),
  ).length;
  const lowSignalLines = lines.filter((l) => isTimestampOnlyLine(l)).length;
  const informativeLines = lines.filter(
    (l) => !isDecorativeLine(l) && !isSeparatorHeavyLine(l) && !isTimestampOnlyLine(l),
  );
  if (informativeLines.length === 0 && decorativeLines + lowSignalLines > 0) return true;
  if (informativeLines.length <= 1 && decorativeLines >= Math.max(2, Math.ceil(lines.length * 0.55))) return true;
  return false;
}

export function normalizeResultText(raw: string): string {
  const cleaned = stripAnsi(raw);
  const lines = cleaned
    .replace(/\t/g, "  ")
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""));
  return lines.join("\n").trim();
}

export function previewResultText(raw: string, maxLines = 4, maxChars = 260): string {
  const text = String(raw ?? "").trim();
  if (!text) return "(no output)";
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    if (isDecorativeLine(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= maxLines) break;
  }
  if (out.length === 0) return "(no output)";
  const joined = out.join("\n").trim();
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars - 1)}…`;
}

export function countResultLines(raw: string): number {
  return String(raw ?? "")
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

// ─── Parse helpers ────────────────────────────────────────────────────────────

function decodeTagText(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractTag(raw: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(String(raw ?? ""));
  return m ? decodeTagText(m[1] ?? "") : "";
}

export function parseLocalCommandMarkup(raw: string):
  | { kind: "use"; command: string; name: string; fields: Array<{ key: string; value: string }>; inputText: string }
  | { kind: "result"; text: string; state: ToolState }
  | { kind: "system"; text: string }
  | null {
  const text = String(raw ?? "");
  if (!/<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/i.test(text)) {
    return null;
  }

  const caveat = extractTag(text, "local-command-caveat");
  if (caveat) return { kind: "system", text: "Local command caveat (hidden in focus)" };

  const stdout = extractTag(text, "local-command-stdout");
  if (stdout) {
    const normalized = normalizeResultText(stdout) || "(no output)";
    return { kind: "result", text: normalized, state: normalized === "(no output)" ? "ok" : resultState(normalized) };
  }

  const stderr = extractTag(text, "local-command-stderr");
  if (stderr) {
    const normalized = normalizeResultText(stderr) || "(no output)";
    const out = normalized === "(no output)" ? normalized : `[error]\n${normalized}`;
    return { kind: "result", text: out, state: "error" };
  }

  const commandName = extractTag(text, "command-name");
  const commandMessage = extractTag(text, "command-message");
  const commandArgs = extractTag(text, "command-args");
  if (commandName || commandMessage || /<command-name>/i.test(text)) {
    const command = [commandName || commandMessage, commandArgs].filter(Boolean).join(" ").trim();
    const fields: Array<{ key: string; value: string }> = [];
    if (commandMessage) fields.push({ key: "message", value: commandMessage });
    if (commandArgs) fields.push({ key: "args", value: commandArgs });
    return { kind: "use", command: command || "local command", name: "local_command", fields, inputText: text };
  }
  return null;
}

type ExploredCall = { verb: string; detail: string; rawLine: string };

export function parseExploredToolCalls(raw: string): { calls: ExploredCall[]; remainder: string } {
  const text = String(raw ?? "");
  const lines = text.split("\n");
  let hasExploredHeader = false;
  const calls: ExploredCall[] = [];
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { kept.push(line); continue; }
    if (/^(?:[-*•]\s*)?explored\b/i.test(trimmed)) { hasExploredHeader = true; continue; }
    if (isDecorativeLine(trimmed)) continue;

    const branchy = /[└├│╰╮┆]/.test(line);
    const m = /^(?:[└├│╰╮┆]+\s*)?(List|Read|Search|Open|Find|Run|Edit|Write|Create|Delete|Move|Patch|Diff|Test|Inspect)\s+(.+?)\s*$/i.exec(trimmed);
    if (m && (hasExploredHeader || branchy)) {
      calls.push({ verb: m[1] ?? "Run", detail: m[2] ?? "", rawLine: trimmed });
      continue;
    }
    kept.push(line);
  }

  return { calls, remainder: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

export function looksLikeToolLogText(raw: string): boolean {
  const text = stripAnsi(String(raw ?? ""));
  if (!text.trim()) return false;
  if (isDecorativeNoiseBlock(text)) return true;
  if (parseExploredToolCalls(text).calls.length > 0) return true;
  if (parseAssistantCommandSummary(text).calls.length > 0) return true;
  if (/(^|\n)\s*(?:[-*•]\s*)?explored\b/i.test(text)) return true;
  if (/(^|\n)\s*[└├│╰╮┆]+\s*(list|read|search|open|find|run|edit|write|create|delete|move|patch|diff|test|inspect)\b/i.test(text)) return true;
  if (/(^|\n)\s*(?:[-*•]\s*)?`[^`]{2,220}`\s*(?:->|→)\s*.+/i.test(text)) return true;
  return false;
}

type SummaryCommandCall = { command: string; result: string; rawLine: string };

export function parseAssistantCommandSummary(raw: string): { calls: SummaryCommandCall[]; remainder: string } {
  const text = String(raw ?? "");
  const lines = text.split("\n");
  const calls: SummaryCommandCall[] = [];
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { kept.push(line); continue; }
    const mCode = /^[-*]\s*`([^`]{1,220})`\s*(?:->|→)\s*(.{1,500})$/i.exec(trimmed);
    const mPlain = /^[-*]\s*([a-z][\w./-]*(?:\s+[^→]+?)?)\s*(?:->|→)\s*(.{1,500})$/i.exec(trimmed);
    const m = mCode || mPlain;
    if (!m) { kept.push(line); continue; }
    const command = String(m[1] ?? "").trim();
    const result = String(m[2] ?? "").trim();
    if (!command || !result || command.length < 2 || command.length > 220) { kept.push(line); continue; }
    calls.push({ command, result, rawLine: trimmed });
  }

  return { calls, remainder: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

type RanToolCall = { command: string; output: string; rawHead: string };

export function parseAssistantRanCalls(raw: string): { calls: RanToolCall[]; remainder: string } {
  const text = String(raw ?? "");
  const lines = text.split("\n");
  const kept: string[] = [];
  const calls: RanToolCall[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    const ranMatch = /^(?:[-*•]\s*)?Ran\s+(.+)$/i.exec(trimmed);
    const interactedMatch = /^(?:[↳>-]\s*)?Interacted with background terminal\s*[·-]\s*(.+)$/i.exec(trimmed);
    const command = (ranMatch?.[1] ?? interactedMatch?.[1] ?? "").trim();

    if (!command) { kept.push(line); i += 1; continue; }

    const outputLines: string[] = [];
    i += 1;
    while (i < lines.length) {
      const outLine = lines[i] ?? "";
      const outTrimmed = outLine.trim();
      if (!outTrimmed) { if (outputLines.length === 0) { i += 1; continue; } break; }
      if (/^(?:[-*•]\s*)?(?:Ran|Explored)\b/i.test(outTrimmed)) break;
      if (/^(?:[-*•]\s*)?(?:Done\.|Current state:|COMPLETED:|PENDING:|RISKS:|NEXT:)/i.test(outTrimmed)) break;
      if (/^─{6,}$/.test(outTrimmed) || isDecorativeLine(outTrimmed)) { i += 1; continue; }
      if (
        outLine.startsWith("  ") ||
        /^[└├│╰╮┆]/.test(outTrimmed) ||
        /^\(waited\)$/i.test(outTrimmed) ||
        /^Total output lines:/i.test(outTrimmed)
      ) {
        outputLines.push(outTrimmed);
        i += 1;
        continue;
      }
      break;
    }

    calls.push({ command, output: normalizeResultText(outputLines.join("\n")), rawHead: trimmed });
  }

  return { calls, remainder: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

// ─── JSON / curl helpers ──────────────────────────────────────────────────────

function parseJson(raw: string): any {
  try { return JSON.parse(String(raw ?? "").trim()); } catch { return null; }
}

function parseCurlBodyJson(cmd: string): any {
  const text = String(cmd ?? "");
  const m = text.match(/(?:^|\s)(?:-d|--data|--data-raw|--data-binary)\s+('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/i);
  if (!m?.[1]) return null;
  let raw = String(m[1]).trim();
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    raw = raw.slice(1, -1);
  }
  raw = raw.replace(/\\'/g, "'").replace(/\\"/g, '"');
  return parseJson(raw);
}

function pickStr(obj: any, keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function pickCmd(input: any): string {
  if (!input || typeof input !== "object") return "";
  const direct = pickStr(input, ["cmd", "command", "script", "shell_command"]);
  if (direct) return direct;
  for (const k of ["input", "args", "payload", "options"]) {
    const c = pickCmd(input[k]);
    if (c) return c;
  }
  return "";
}

// ─── Orchestration command parsing ───────────────────────────────────────────

export function parseOrchestrationCommandMeta(rawCommand: string): OrchestrationCommandMeta | null {
  const cmd = String(rawCommand ?? "").trim();
  if (!cmd) return null;
  if (!/\bcurl\b/i.test(cmd)) return null;
  if (!/(?:\/api\/orchestrations\/|\/api\/inbox\b|\/api\/sessions\b|\/api\/tasks\b|\/api\/tool-sessions\b|\/api\/codex-native\b)/i.test(cmd)) return null;

  const endpointMatch =
    cmd.match(/(\/api\/orchestrations(?:\/[^\s"'`]*)?)/i) ||
    cmd.match(/(\/api\/inbox[^\s"'`]*)/i) ||
    cmd.match(/(\/api\/sessions[^\s"'`]*)/i) ||
    cmd.match(/(\/api\/tasks[^\s"'`]*)/i) ||
    cmd.match(/(\/api\/tool-sessions[^\s"'`]*)/i) ||
    cmd.match(/(\/api\/codex-native[^\s"'`]*)/i);
  const endpoint = String(endpointMatch?.[1] ?? "").trim();
  if (!endpoint) return null;

  const methodMatch = cmd.match(/(?:^|\s)-X\s+([A-Z]+)/i);
  const impliedPost = /(?:^|\s)(?:-d|--data|--data-raw|--data-binary)\s+/i.test(cmd);
  const method = String(methodMatch?.[1] ?? (impliedPost ? "POST" : "GET")).toUpperCase();
  const bodyJson = parseCurlBodyJson(cmd) ?? {};
  const orchestrationId = cmd.match(/\/api\/orchestrations\/([^/\s"'`]+)/i)?.[1];
  const sessionId = cmd.match(/\/api\/sessions\/([^/\s"'`]+)/i)?.[1];
  const taskId = cmd.match(/\/api\/tasks\/([^/\s"'`]+)/i)?.[1];
  const memberSessionId = cmd.match(/\/api\/tasks\/[^/\s"'`]+\/members\/([^/\s"'`]+)\/mode/i)?.[1];
  const toolSessionTool = cmd.match(/\/api\/tool-sessions\/([^/\s"'`]+)\/[^/\s"'`]+\/messages/i)?.[1];
  const toolSessionId = cmd.match(/\/api\/tool-sessions\/[^/\s"'`]+\/([^/\s"'`]+)\/messages/i)?.[1];
  const threadId = cmd.match(/\/api\/codex-native\/threads\/([^/\s"'`]+)/i)?.[1];

  let action: OrchestrationAction = "unknown";
  if (/\/api\/orchestrations$/i.test(endpoint)) action = method === "POST" ? "create" : "list";
  else if (/\/api\/orchestrations\/[^/\s"'`]+\/dispatch\b/i.test(endpoint)) action = "dispatch";
  else if (/\/api\/orchestrations\/[^/\s"'`]+\/send-task\b/i.test(endpoint)) action = "send_task";
  else if (/\/api\/orchestrations\/[^/\s"'`]+\/progress\b/i.test(endpoint)) action = "progress";
  else if (/\/api\/orchestrations\/[^/\s"'`]+\/sync-policy\b/i.test(endpoint)) action = "sync_policy";
  else if (/\/api\/orchestrations\/[^/\s"'`]+\/automation-policy\b/i.test(endpoint)) action = "automation_policy";
  else if (/\/api\/orchestrations\/[^/\s"'`]+\/cleanup\b/i.test(endpoint)) action = "cleanup";
  else if (/\/api\/orchestrations\/[^/\s"'`]+\/sync\b/i.test(endpoint)) action = "sync";
  else if (/\/api\/orchestrations\/[^/\s"'`]+$/i.test(endpoint)) action = "status";
  else if (/\/api\/inbox\?/i.test(endpoint) || /\/api\/inbox$/i.test(endpoint)) action = "inbox_list";
  else if (/\/api\/inbox\/[^/\s"'`]+\/respond\b/i.test(endpoint)) action = "inbox_respond";
  else if (/\/api\/inbox\/[^/\s"'`]+\/dismiss\b/i.test(endpoint)) action = "inbox_dismiss";
  else if (/\/api\/sessions$/i.test(endpoint)) action = method === "POST" ? "session_create" : "sessions_list";
  else if (/\/api\/sessions\/[^/\s"'`]+\/input\b/i.test(endpoint)) action = "session_input";
  else if (/\/api\/sessions\/[^/\s"'`]+\/events\b/i.test(endpoint)) action = "session_events";
  else if (/\/api\/sessions\/[^/\s"'`]+\/transcript\b/i.test(endpoint)) action = "session_transcript";
  else if (/\/api\/sessions\/[^/\s"'`]+\/interrupt\b/i.test(endpoint)) action = "session_interrupt";
  else if (/\/api\/sessions\/[^/\s"'`]+\/stop\b/i.test(endpoint)) action = "session_stop";
  else if (/\/api\/sessions\/[^/\s"'`]+\/kill\b/i.test(endpoint)) action = "session_kill";
  else if (/\/api\/sessions\/[^/\s"'`]+\/restart\b/i.test(endpoint)) action = "session_restart";
  else if (/\/api\/sessions\/[^/\s"'`]+\/mode\b/i.test(endpoint) && method === "PATCH") action = "session_mode_patch";
  else if (/\/api\/sessions\/[^/\s"'`]+\/meta\b/i.test(endpoint) && method === "PATCH") action = "session_meta_patch";
  else if (/\/api\/sessions\/[^/\s"'`]+$/i.test(endpoint) && method === "DELETE") action = "session_delete";
  else if (/\/api\/sessions\/[^/\s"'`]+$/i.test(endpoint)) action = "session_status";
  else if (/\/api\/tasks$/i.test(endpoint)) action = "tasks_list";
  else if (/\/api\/tasks\/[^/\s"'`]+\/open-target\b/i.test(endpoint)) action = "task_open_target";
  else if (/\/api\/tasks\/[^/\s"'`]+\/archive\b/i.test(endpoint)) action = "task_archive";
  else if (/\/api\/tasks\/[^/\s"'`]+\/members\/[^/\s"'`]+\/mode\b/i.test(endpoint)) action = "task_member_mode_patch";
  else if (/\/api\/tasks\/[^/\s"'`]+\/mode\b/i.test(endpoint)) action = "task_mode_patch";
  else if (/\/api\/tasks\/[^/\s"'`]+$/i.test(endpoint)) action = "task_status";
  else if (/\/api\/tool-sessions\/[^/\s"'`]+\/[^/\s"'`]+\/messages\b/i.test(endpoint)) action = "tool_session_messages";
  else if (/\/api\/tool-sessions\b/i.test(endpoint)) action = "tool_sessions_list";
  else if (/\/api\/codex-native\/threads\/[^/\s"'`]+$/i.test(endpoint)) action = "codex_thread_read";
  else if (/\/api\/codex-native\/threads\b/i.test(endpoint)) action = "codex_threads_list";

  const target = typeof bodyJson?.target === "string" ? bodyJson.target : cmd.match(/"target"\s*:\s*"([^"]+)"/i)?.[1];
  const optionId = typeof bodyJson?.optionId === "string" ? bodyJson.optionId : cmd.match(/"optionId"\s*:\s*"([^"]+)"/i)?.[1];
  const textPreview =
    typeof bodyJson?.task === "string" ? bodyJson.task
    : typeof bodyJson?.text === "string" ? bodyJson.text
    : cmd.match(/"(?:task|text)"\s*:\s*"([^"]{1,240})"/i)?.[1];

  return {
    action, method, endpoint,
    ...(orchestrationId ? { orchestrationId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(memberSessionId ? { memberSessionId } : {}),
    ...(toolSessionTool ? { toolSessionTool } : {}),
    ...(toolSessionId ? { toolSessionId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(target ? { target } : {}),
    ...(optionId ? { optionId } : {}),
    ...(textPreview ? { textPreview } : {}),
    ...(typeof bodyJson?.runNow === "boolean" ? { runNow: bodyJson.runNow } : {}),
    ...(typeof bodyJson?.force === "boolean" ? { force: bodyJson.force } : {}),
    ...(typeof bodyJson?.mode === "string" ? { syncMode: bodyJson.mode } : {}),
    ...(Number.isFinite(Number(bodyJson?.intervalMs)) ? { intervalMs: Number(bodyJson.intervalMs) } : {}),
    ...(Number.isFinite(Number(bodyJson?.minDeliveryGapMs)) ? { minDeliveryGapMs: Number(bodyJson.minDeliveryGapMs) } : {}),
    ...(typeof bodyJson?.deliverToOrchestrator === "boolean" ? { deliverToOrchestrator: bodyJson.deliverToOrchestrator } : {}),
    ...(typeof bodyJson?.questionMode === "string" ? { questionMode: bodyJson.questionMode } : {}),
    ...(typeof bodyJson?.steeringMode === "string" ? { steeringMode: bodyJson.steeringMode } : {}),
    ...(Number.isFinite(Number(bodyJson?.questionTimeoutMs)) ? { questionTimeoutMs: Number(bodyJson.questionTimeoutMs) } : {}),
    ...(Number.isFinite(Number(bodyJson?.reviewIntervalMs)) ? { reviewIntervalMs: Number(bodyJson.reviewIntervalMs) } : {}),
    ...(typeof bodyJson?.yoloMode === "boolean" ? { yoloMode: bodyJson.yoloMode } : {}),
    ...(typeof bodyJson?.stopSessions === "boolean" ? { stopSessions: bodyJson.stopSessions } : {}),
    ...(typeof bodyJson?.deleteSessions === "boolean" ? { deleteSessions: bodyJson.deleteSessions } : {}),
    ...(typeof bodyJson?.removeWorktrees === "boolean" ? { removeWorktrees: bodyJson.removeWorktrees } : {}),
    ...(typeof bodyJson?.removeRecord === "boolean" ? { removeRecord: bodyJson.removeRecord } : {}),
    ...(typeof bodyJson?.keepCoordinator === "boolean" ? { keepCoordinator: bodyJson.keepCoordinator } : {}),
  };
}

export function orchestrationActionTitle(meta: OrchestrationCommandMeta): string {
  switch (meta.action) {
    case "list": return "List Orchestrations";
    case "create": return "Create Orchestration";
    case "dispatch": return meta.target ? `Dispatch Prompt -> ${meta.target}` : "Dispatch Prompt to Worker(s)";
    case "send_task": return meta.target ? `Send Task -> ${meta.target}` : "Send Task to Worker(s)";
    case "status": return "Read Orchestration Status";
    case "progress": return "Read Worker Progress Feed";
    case "sync": return "Run Orchestration Sync";
    case "sync_policy": return "Update Sync Policy";
    case "automation_policy": return "Update Automation Policy";
    case "cleanup": return "Run Orchestration Cleanup";
    case "inbox_list": return "List Pending Approvals";
    case "inbox_respond": return meta.optionId ? `Submit Approval (${meta.optionId})` : "Submit Approval Decision";
    case "inbox_dismiss": return "Dismiss Approval Item";
    case "sessions_list": return "List Runtime Sessions";
    case "session_create": return "Create Runtime Session";
    case "session_status": return "Read Session Status";
    case "session_input": return "Send Session Input";
    case "session_events": return "Read Session Events";
    case "session_transcript": return "Read Session Transcript";
    case "session_interrupt": return "Interrupt Session";
    case "session_stop": return "Stop Session";
    case "session_kill": return "Kill Session";
    case "session_restart": return "Restart Session";
    case "session_mode_patch": return "Update Session Mode";
    case "session_meta_patch": return "Update Session Metadata";
    case "session_delete": return "Delete Session";
    case "tasks_list": return "List Task Cards";
    case "task_status": return "Read Task Status";
    case "task_open_target": return "Open Task Target";
    case "task_mode_patch": return "Update Task Mode";
    case "task_member_mode_patch": return "Update Task Member Mode";
    case "task_archive": return "Archive Task";
    case "tool_sessions_list": return "List Tool Sessions";
    case "tool_session_messages": return "Read Tool Session Messages";
    case "codex_threads_list": return "List Codex Native Threads";
    case "codex_thread_read": return "Read Codex Native Thread";
    default: return "Call Control Bus API";
  }
}

// ─── Tool kind inference ──────────────────────────────────────────────────────

export function inferShellCommandKind(rawCommand: string): ToolKind | null {
  const command = String(rawCommand ?? "").trim().replace(/^\$\s*/, "");
  if (!command) return null;
  const lower = command.toLowerCase();

  const orchMeta = parseOrchestrationCommandMeta(command);
  if (orchMeta) return "orch";

  if (/\bgit\s+(status|show|diff|log|branch|ls-files|grep|rev-parse|remote|tag|stash\s+list)\b/.test(lower)) return "read";
  if (/\bgit\s+(add|rm|mv|commit|rebase|merge|cherry-pick|reset|restore|checkout|switch|clean)\b/.test(lower)) return "edit";
  if (/(^|[^\\])(>>?|<<?)\s*\S/.test(lower) || /\|\s*tee\b/.test(lower)) return "write";
  if (/\b(apply_patch|sed\s+-i|perl\s+-pi)\b/.test(lower)) return "edit";

  const first = lower.split(/\s+/)[0] ?? "";
  if (["ls", "cat", "head", "tail", "more", "less", "rg", "grep", "find", "fd", "tree", "pwd", "stat", "wc", "cut", "sort", "uniq", "awk", "sed", "readlink", "basename", "dirname", "realpath"].includes(first)) return "read";
  if (["touch", "mkdir", "rmdir", "rm", "mv", "cp", "ln", "chmod", "chown", "truncate"].includes(first)) return "write";
  if (/^(npm|pnpm|yarn|bun)\s+(install|add|remove|rm|update|upgrade|up|uninstall)\b/.test(lower)) return "write";

  return null;
}

export function inferKind(name = "", text = "", command: string | null = null): ToolKind {
  const all = `${name} ${text}`.toLowerCase();
  const commandKind = inferShellCommandKind(command ?? text);
  if (commandKind) return commandKind;
  if (/\bmcp\b|jsonrpc/.test(all)) return "mcp";
  if (/browser|https?|fetch|navigate|click/.test(all)) return "web";
  if (/\bsearch\b|\bquery\b/.test(all)) return "search";

  const shellHint = /(^|[^a-z])bash([^a-z]|$)|shell|exec_command/.test(all);
  if (shellHint) {
    const shellKind = inferShellCommandKind(command || text);
    if (shellKind) return shellKind;
    return "bash";
  }

  if (/\bread\b|cat\b|ls\b|glob\b|grep\b|\bfind\b/.test(all)) return "read";
  if (/\bwrite\b|\bcreate\b|\bappend\b/.test(all)) return "write";
  if (/\bedit\b|apply_patch|replace/.test(all)) return "edit";
  return "other";
}

export function parseToolBlock(rawName: string, rawText: string) {
  const full = String(rawText ?? "").trim();
  const lines = full.split("\n");
  const fromHeader = /^tool:\s*(.+)$/i.exec(String(lines[0] ?? "").trim())?.[1]?.trim() ?? "";
  const name = String(rawName || fromHeader || "").trim();
  const payloadText = fromHeader ? lines.slice(1).join("\n").trim() : full;
  const payload = parseJson(payloadText);
  const command = pickCmd(payload);
  const orchMeta = command ? parseOrchestrationCommandMeta(command) : null;

  let summary = "";
  if (command) summary = orchMeta ? orchestrationActionTitle(orchMeta) : `$ ${command}`;
  else if (payload && typeof payload === "object") {
    const q = pickStr(payload, ["q", "query", "search", "pattern"]);
    const p = pickStr(payload, ["path", "file", "file_path", "workdir", "cwd", "url"]);
    summary = q || p || clamp(payloadText, 120);
  } else {
    summary = clamp(full, 120);
  }

  const fields: Array<{ key: string; value: string }> = [];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const k of ["path", "file_path", "workdir", "cwd", "url", "pattern", "q", "query"]) {
      const v = payload[k];
      if (!v) continue;
      fields.push({ key: k, value: clamp(typeof v === "string" ? v : JSON.stringify(v), 100) });
      if (fields.length >= 3) break;
    }
  }

  return { name, summary: summary || "Tool call", command: command || null, inputText: full, fields, orchMeta };
}

export function resultState(text: string): ToolState {
  const lines = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const hasError = lines.some(
    (line) =>
      /^(\[error\]|error[:\s]|fatal[:\s]|exception[:\s]|traceback\b|stderr[:\s]?|err!\b)/i.test(line) ||
      /\b(command not found|no such file or directory|permission denied|access denied|operation not permitted|connection refused|timed out|failed\s+to|failure|cannot\s+\w+)\b/i.test(line) ||
      /\b(eacces|enoent|eperm|econnrefused|etimedout)\b/i.test(line),
  );
  if (hasError) return "error";

  const hasWarn = lines.some(
    (line) =>
      /^(warn(?:ing)?[:\s]|deprecated[:\s])/i.test(line) ||
      /\b(timeout|retry|partial)\b/i.test(line),
  );
  if (hasWarn) return "warn";

  return "ok";
}

export function summarizeInternalSystemText(text: string): string | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const lines = raw.split("\n");
  const lineCount = lines.length;

  if (/(?:^|\n)\s*(?:[>•\-]\s*)?ORCHESTRATION SYNC\s*\(/i.test(raw)) return HIDDEN_SYSTEM_EVENT;
  if (/Treat this as read-only status context\.\s*Do not interrupt workers unless asked\./i.test(raw)) return HIDDEN_SYSTEM_EVENT;
  if (/^AUTOMATION QUESTION BATCH/i.test(raw)) return "Automation question batch dispatched";
  if (/^PERIODIC ORCHESTRATOR REVIEW/i.test(raw)) return "Periodic orchestrator review dispatched";

  const looksLikeBootstrap =
    /(SYSTEM PROMPT \(apply strictly\)|COORDINATOR DIRECTIVE|WORKER REGISTRY|DOCUMENT STRATEGY \(MANDATORY\)|UNIVERSAL AGENT PRINCIPLES)/i.test(raw) &&
    lineCount >= 10;
  if (looksLikeBootstrap) return "Orchestrator bootstrap/system prompt loaded";

  const looksLikeControlBus =
    /(CONTROL BUS|\/api\/orchestrations\/|FYP_API_BASE_URL|Known worker targets:)/i.test(raw) && lineCount >= 6;
  if (looksLikeControlBus) return "Orchestrator control bus instructions loaded";

  if (/^(orchestration\.|step-start|step-finish)/i.test(raw)) return clamp(raw, 70);
  return null;
}

// ─── Timeline builder ─────────────────────────────────────────────────────────

export function buildTimeline(messages: ToolSessionMessage[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  let seq = 0;

  for (const m of messages) {
    const blocks: ToolSessionMessageBlock[] =
      Array.isArray(m.blocks) && m.blocks.length > 0
        ? m.blocks
        : [{ type: "text", text: m.text }];

    for (const b of blocks) {
      const ts = Number(m.ts || Date.now());
      const id = `${ts}-${seq}`;
      const text = String(b.text ?? "").trim();

      if (b.type === "text") {
        if (!text) { seq++; continue; }
        const localMarkup = parseLocalCommandMarkup(text);
        if (localMarkup) {
          if (localMarkup.kind === "system") {
            out.push({ id: `${id}-sys-local`, seq, ts, kind: "system", text: localMarkup.text });
            seq++; continue;
          }
          if (localMarkup.kind === "use") {
            out.push({
              id: `${id}-local-use`, seq, ts, kind: "tool_use", callId: null,
              name: localMarkup.name,
              toolKind: inferKind(localMarkup.name, localMarkup.command, localMarkup.command),
              summary: `$ ${localMarkup.command}`, command: localMarkup.command,
              inputText: localMarkup.inputText, fields: localMarkup.fields,
              orchMeta: parseOrchestrationCommandMeta(localMarkup.command),
            });
            seq++; continue;
          }
          if (localMarkup.kind === "result") {
            out.push({
              id: `${id}-local-res`, seq, ts, kind: "tool_result", callId: null,
              text: localMarkup.text, state: localMarkup.state,
              preview: previewResultText(localMarkup.text), isEmpty: localMarkup.text === "(no output)",
            });
            seq++; continue;
          }
        }

        const systemSummary = summarizeInternalSystemText(text);
        if (systemSummary) {
          if (systemSummary === HIDDEN_SYSTEM_EVENT) { seq++; continue; }
          out.push({ id: `${id}-sys`, seq, ts, kind: "system", text: systemSummary });
          seq++; continue;
        }

        const role = m.role === "assistant" ? "assistant" : "user";
        if (role === "assistant") {
          const explored = parseExploredToolCalls(text);
          let assistantText = explored.remainder;

          if (explored.calls.length > 0) {
            for (let ci = 0; ci < explored.calls.length; ci++) {
              const call = explored.calls[ci]!;
              const callId = `explored-${ts}-${seq}-${ci}`;
              const command = `${call.verb.toLowerCase()} ${call.detail}`.trim();
              const orchMeta = parseOrchestrationCommandMeta(command);
              const name = `codex.explored.${call.verb.toLowerCase()}`;
              out.push({
                id: `${id}-explore-use-${ci}`, seq, ts, kind: "tool_use", callId,
                name, toolKind: inferKind(name, command, command), summary: `$ ${command}`,
                command, inputText: call.rawLine, fields: [{ key: "action", value: call.rawLine }], orchMeta,
              });
              seq++;
              out.push({
                id: `${id}-explore-res-${ci}`, seq, ts, kind: "tool_result", callId,
                text: "[completed]", state: "ok", preview: "completed", isEmpty: false,
              });
              seq++;
            }
          }

          const summaryCalls = parseAssistantCommandSummary(assistantText);
          assistantText = summaryCalls.remainder;
          if (summaryCalls.calls.length > 0) {
            for (let ci = 0; ci < summaryCalls.calls.length; ci++) {
              const call = summaryCalls.calls[ci]!;
              const callId = `summary-${ts}-${seq}-${ci}`;
              const command = call.command;
              const orchMeta = parseOrchestrationCommandMeta(command);
              const name = "assistant.summary.command";
              out.push({
                id: `${id}-summary-use-${ci}`, seq, ts, kind: "tool_use", callId, name,
                toolKind: inferKind(name, command, command),
                summary: orchMeta ? orchestrationActionTitle(orchMeta) : `$ ${command}`,
                command, inputText: call.rawLine, fields: [{ key: "summary", value: call.rawLine }], orchMeta,
              });
              seq++;
              const resultTextRaw = normalizeResultText(call.result);
              const resultText = !resultTextRaw || isDecorativeNoiseBlock(resultTextRaw) ? "(no output)" : resultTextRaw;
              out.push({
                id: `${id}-summary-res-${ci}`, seq, ts, kind: "tool_result", callId,
                text: resultText, state: resultState(resultText), preview: previewResultText(resultText),
                isEmpty: resultText === "(no output)",
              });
              seq++;
            }
          }

          const ranCalls = parseAssistantRanCalls(assistantText);
          assistantText = ranCalls.remainder;
          if (ranCalls.calls.length > 0) {
            for (let ci = 0; ci < ranCalls.calls.length; ci++) {
              const call = ranCalls.calls[ci]!;
              const callId = `ran-${ts}-${seq}-${ci}`;
              const command = call.command;
              const orchMeta = parseOrchestrationCommandMeta(command);
              const name = "assistant.ran.command";
              const toolKind = inferKind(name, command, command);
              out.push({
                id: `${id}-ran-use-${ci}`, seq, ts, kind: "tool_use", callId, name, toolKind,
                summary: orchMeta ? orchestrationActionTitle(orchMeta) : `$ ${command}`,
                command, inputText: call.rawHead, fields: [{ key: "command", value: command }], orchMeta,
              });
              seq++;
              const output = call.output.trim();
              const resultText = output && !isDecorativeNoiseBlock(output) ? output : "(no output)";
              out.push({
                id: `${id}-ran-res-${ci}`, seq, ts, kind: "tool_result", callId,
                text: resultText, state: resultState(resultText), preview: previewResultText(resultText),
                isEmpty: resultText === "(no output)",
              });
              seq++;
            }
          }

          const cleanText = sanitizeAssistantText(assistantText);
          if (!cleanText.trim() || isDecorativeNoiseBlock(cleanText)) continue;
          out.push({ id: `${id}-txt`, seq, ts, kind: role, text: cleanText });
          seq++;
          continue;
        }

        const cleanText = sanitizeAssistantText(text);
        if (!cleanText.trim() || isDecorativeNoiseBlock(cleanText)) { seq++; continue; }
        out.push({ id: `${id}-txt`, seq, ts, kind: role, text: cleanText });
        seq++;
        continue;
      }

      if (b.type === "thinking") {
        if (!text) { seq++; continue; }
        const cleanThinking = sanitizeAssistantText(text);
        if (!cleanThinking || isDecorativeNoiseBlock(cleanThinking)) { seq++; continue; }
        out.push({ id: `${id}-think`, seq, ts, kind: "thinking", text: cleanThinking });
        seq++;
        continue;
      }

      if (b.type === "tool_use") {
        const p = parseToolBlock(String(b.name ?? ""), String(b.text ?? ""));
        out.push({
          id: `${id}-use`, seq, ts, kind: "tool_use",
          callId: b.callId ? String(b.callId) : null,
          name: p.name, toolKind: inferKind(p.name, p.inputText, p.command),
          summary: p.summary, command: p.command, inputText: p.inputText,
          fields: p.fields, orchMeta: p.orchMeta,
        });
        seq++;
        continue;
      }

      if (b.type === "tool_result") {
        const normalized = normalizeResultText(text);
        const isEmpty = !normalized || isDecorativeNoiseBlock(normalized);
        const output = isEmpty ? "(no output)" : normalized;
        out.push({
          id: `${id}-res`, seq, ts, kind: "tool_result",
          callId: b.callId ? String(b.callId) : null,
          text: output, state: isEmpty ? "ok" : resultState(output),
          preview: previewResultText(output), isEmpty,
        });
        seq++;
      }
    }
  }

  return out.sort((a, b) => (a.ts === b.ts ? a.seq - b.seq : a.ts - b.ts));
}
