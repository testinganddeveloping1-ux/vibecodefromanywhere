import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./lib/api";
import { lsGet, lsSet } from "./lib/storage";
import { BottomNav } from "./components/BottomNav";
import { HeaderBar } from "./components/HeaderBar";
import { WrapperChatView } from "./components/WrapperChatView";
import { OrchestrationCommandPanel } from "./components/OrchestrationCommandPanel";
import { ConnectingScreen, UnlockScreen } from "./components/LoginScreens";
import type { Doctor, InboxItem, SessionRow, TaskCard, ToolId, ToolSessionMessage, ToolSessionMessageBlock, ToolSessionSummary } from "./types";
import { TerminalView } from "./components/TerminalView";
import { PickerModal } from "./modals/PickerModal";

// ── Preset system ────────────────────────────────────────────────────────────
type PresetAgent = {
  role: "orchestrator" | "worker";
  name: string;
  tool: ToolId;
  profileId: string;
  label: string;
  taskPrompt?: string; // {objective} placeholder supported
};

type PresetDef = {
  id: string;
  name: string;
  desc: string;
  detail: string;
  agents: PresetAgent[];
  kind: "session" | "orchestration";
};

type ProfileOption = { id: string; label: string };

type CustomWorkerGroup = {
  id: string;
  tool: ToolId;
  profileId: string;
  model: string;
  count: number;
  role: string;
  taskTemplate: string;
};

type CustomTeamAutomationMode = "manual" | "guided" | "autopilot";

type DirectoryPickerTarget = "createProjectPath" | "soloCwd";

const PRESETS: PresetDef[] = [
  {
    id: "solo",
    name: "Solo",
    desc: "1 agent",
    detail: "Single mirrored terminal session. You pick Codex, Claude Code, or OpenCode and control it directly.",
    kind: "session",
    agents: [
      { role: "worker", tool: "codex", profileId: "codex.default", name: "Terminal Agent", label: "Direct terminal control" },
    ],
  },
  {
    id: "debug",
    name: "Debug Team",
    desc: "3 agents",
    detail: "Codex orchestrator plus two Codex workers for debugging, tests, and targeted fixes.",
    kind: "orchestration",
    agents: [
      { role: "orchestrator", tool: "codex", profileId: "codex.default", name: "Orchestrator", label: "Owns plan and dispatch" },
      { role: "worker", tool: "codex", profileId: "codex.full_auto", name: "Worker A", label: "Finds and fixes backend issues", taskPrompt: "Debug backend behavior and implement focused fixes for: {objective}" },
      { role: "worker", tool: "codex", profileId: "codex.default", name: "Worker B", label: "Runs tests and validates", taskPrompt: "Run tests, verify changes, and harden edge cases for: {objective}" },
    ],
  },
  {
    id: "custom-team",
    name: "Custom Team",
    desc: "1+ agents",
    detail: "Configure one orchestrator plus one or more worker groups with explicit counts, roles, and model/profile overrides.",
    kind: "orchestration",
    agents: [
      { role: "orchestrator", tool: "codex", profileId: "codex.default", name: "Orchestrator", label: "Coordinates plan, dispatch, and review" },
      { role: "worker", tool: "codex", profileId: "codex.default", name: "Workers", label: "Customizable worker groups and counts" },
    ],
  },
];

type ModelOption = { value: string; label: string };
const COMMON_MODELS: Record<ToolId, ModelOption[]> = {
  codex: [
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex (default)" },
    { value: "gpt-5.3-codex-high", label: "GPT-5.3 Codex High" },
    { value: "gpt-5.3-codex-xhigh", label: "GPT-5.3 Codex XHigh" },
    { value: "gpt-5.3-spark", label: "GPT-5.3 Spark" },
    { value: "gpt-5.3-spark-high", label: "GPT-5.3 Spark High" },
    { value: "gpt-5.3-spark-xhigh", label: "GPT-5.3 Spark XHigh" },
  ],
  claude: [
    { value: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 Thinking" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-opus-4-5-thinking", label: "Claude Opus 4.5 Thinking" },
    { value: "claude-sonnet-4-5-thinking", label: "Claude Sonnet 4.5 Thinking" },
  ],
  opencode: [
    { value: "opencode/kimi-k2.5-free", label: "Kimi K2.5 (Free)" },
    { value: "opencode/minimax-m2.5-free", label: "Minimax M2.5 (Free)" },
  ],
};

const FALLBACK_PROFILES: Record<ToolId, ProfileOption[]> = {
  codex: [
    { id: "codex.default", label: "codex.default" },
    { id: "codex.full_auto", label: "codex.full_auto" },
    { id: "codex.review", label: "codex.review" },
  ],
  claude: [
    { id: "claude.default", label: "claude.default" },
    { id: "claude.full_auto", label: "claude.full_auto" },
  ],
  opencode: [
    { id: "opencode.default", label: "opencode.default" },
  ],
};

const CUSTOM_TEAM_MAX_WORKERS = 8;
const CUSTOM_TEAM_MAX_GROUP_COUNT = 6;
const PATH_PRIVACY_MODE_KEY = "fyp.ui.pathPrivacyMode";
const CLAUDE_SHARE_TRUST_KEY = "fyp.ui.claudeAutoTrustShareMode";
type PathPrivacyMode = "full" | "share";

type NativeThreadResp = { ok?: boolean; thread?: any };
type PendingEcho = { id: string; sessionId: string; ts: number; text: string };
type OrchestrationProgressWorker = {
  workerIndex: number;
  name: string;
  sessionId: string;
  running: boolean;
  attention: number;
  branch: string | null;
  worktreePath: string | null;
  projectPath: string | null;
  taskPrompt: string;
  preview?: string | null;
  previewSource?: "none" | "progress" | "live";
  previewTs?: number | null;
  lastEvent?: { id?: number | null; kind?: string | null; ts?: number | null } | null;
  activity?: {
    state?: "live" | "needs_input" | "waiting_or_done" | "idle";
    stale?: boolean;
    staleAfterMs?: number;
    lastActivityAt?: number | null;
    idleForMs?: number | null;
  };
  progress: {
    found: boolean;
    relPath: string | null;
    updatedAt: number | null;
    checklistDone: number;
    checklistTotal: number;
    preview: string | null;
    excerpt: string | null;
  };
};
type OrchestrationProgressItem = {
  orchestrationId: string;
  generatedAt: number;
  startup?: {
    dispatchMode?: "orchestrator-first" | "worker-first";
    state?: "auto-released" | "waiting-first-dispatch" | "running";
    deferredInitialDispatch?: string[];
    dispatchedSessionIds?: string[];
    pendingSessionIds?: string[];
    pendingWorkerNames?: string[];
  };
  workers: OrchestrationProgressWorker[];
};

function extractAnyText(v: any, depth = 0): string {
  if (depth > 5) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (!v) return "";
  if (Array.isArray(v)) {
    return v
      .map((it) => extractAnyText(it, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof v !== "object") return "";
  if (typeof v.text === "string") return v.text;
  if (typeof v.delta === "string") return v.delta;
  if (typeof v.output === "string") return v.output;
  if (typeof v.message === "string") return v.message;
  if (Array.isArray(v.content)) return extractAnyText(v.content, depth + 1);
  return "";
}

function parseMs(v: any, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function fmtIdleAge(ms: number | null | undefined): string {
  const n = Number(ms ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 60_000) return `${Math.max(1, Math.floor(n / 1000))}s`;
  if (n < 60 * 60 * 1000) return `${Math.floor(n / 60_000)}m`;
  return `${Math.floor(n / (60 * 60 * 1000))}h`;
}

function detectHomePrefixFromPath(raw: string): string | null {
  const p = String(raw || "").trim();
  if (!p) return null;
  const unix = p.match(/^\/home\/[^/]+/i) || p.match(/^\/Users\/[^/]+/);
  if (unix?.[0]) return unix[0];
  const win = p.match(/^[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+/);
  if (win?.[0]) return win[0].replace(/\\/g, "/");
  return null;
}

function detectUserHomePrefix(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const found = detectHomePrefixFromPath(String(candidate || ""));
    if (found) return found.replace(/\\/g, "/");
  }
  return null;
}

function formatPathForUi(rawPath: string | null | undefined, mode: PathPrivacyMode, homePrefix: string | null): string {
  const raw = String(rawPath || "").trim();
  if (!raw) return "";
  if (mode !== "share") return raw;

  const normalized = raw.replace(/\\/g, "/");
  const prefix = (homePrefix || detectHomePrefixFromPath(normalized) || "").replace(/\\/g, "/");
  if (!prefix) return normalized;
  if (normalized === prefix) return "~";
  if (normalized.startsWith(`${prefix}/`)) return `~${normalized.slice(prefix.length)}`;
  return normalized;
}

function parseProgressPreviewMeta(raw: string): {
  cleanText: string;
  generatedAt: string | null;
  orchestrationId: string | null;
} {
  const text = String(raw ?? "").trim();
  if (!text) return { cleanText: "", generatedAt: null, orchestrationId: null };

  const generatedPattern = /\bGenerated:\s*`?([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]*Z?)`?/i;
  const generatedAt =
    text.match(generatedPattern)?.[1]?.trim() ?? null;
  const orchestrationId = text.match(/\bOrchestration ID:\s*`?([^`·]+)`?/i)?.[1]?.trim() ?? null;

  let clean = text
    .replace(/\s*·?\s*Generated:\s*`?[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]*Z?`?/gi, "")
    .replace(/\s*·?\s*Orchestration ID:\s*`?[^`·]+`?/gi, "")
    .replace(/\s*·\s*·\s*/g, " · ")
    .replace(/^·\s*|\s*·$/g, "")
    .trim();

  if (!clean) clean = "Metadata hidden";
  return { cleanText: clean, generatedAt, orchestrationId };
}

function toolCallText(name: string, input: any): string {
  let body = "";
  if (typeof input === "string") body = input;
  else if (input != null) {
    try {
      body = JSON.stringify(input, null, 2);
    } catch {
      body = "";
    }
  }
  return body ? `Tool: ${name}\n${body}` : `Tool: ${name}`;
}

function isRecord(v: any): v is Record<string, any> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function modelOptionsForTool(tool: ToolId): ModelOption[] {
  return COMMON_MODELS[tool] ?? [];
}

function profileOptionsForTool(tool: ToolId, profiles: ProfileOption[]): ProfileOption[] {
  const opts = profiles.filter((p) => p.id.startsWith(`${tool}.`));
  if (opts.length > 0) return opts;
  return FALLBACK_PROFILES[tool] ?? [{ id: `${tool}.default`, label: `${tool}.default` }];
}

function normalizeProfileIdForTool(tool: ToolId, profileId: string, profiles: ProfileOption[]): string {
  const id = String(profileId || "").trim();
  const allowed = profileOptionsForTool(tool, profiles);
  if (id && allowed.some((p) => p.id === id)) return id;
  return allowed[0]?.id || `${tool}.default`;
}

function materializeTaskPrompt(templateRaw: string, objectiveRaw: string): string {
  const template = String(templateRaw || "").trim();
  const objective = String(objectiveRaw || "").trim();
  if (!template) return objective;
  if (!objective) return template;

  if (/\{objective\}/i.test(template)) {
    return template.replace(/\{objective\}/gi, objective);
  }
  const templateNorm = template.toLowerCase();
  const objectiveNorm = objective.toLowerCase();
  if (
    templateNorm.includes(objectiveNorm.slice(0, 140)) ||
    /\bobjective\b/i.test(template) ||
    /\bgoal\b/i.test(template)
  ) {
    return template;
  }
  return `${template}\n\nObjective: ${objective}`;
}

function summarizeOrchestrationForInbox(progress: OrchestrationProgressItem | null | undefined): null | { line1: string; line2: string } {
  if (!progress || !Array.isArray(progress.workers) || progress.workers.length === 0) return null;
  const workers = progress.workers;
  const live = workers.filter((w) => Boolean(w.running)).length;
  const attention = workers.reduce((n, w) => n + Math.max(0, Number(w.attention ?? 0)), 0);
  const done = workers.reduce((n, w) => n + Math.max(0, Number(w.progress?.checklistDone ?? 0)), 0);
  const total = workers.reduce((n, w) => n + Math.max(0, Number(w.progress?.checklistTotal ?? 0)), 0);
  const line1Parts = [`${live}/${workers.length} live`];
  if (total > 0) line1Parts.push(`checklist ${done}/${total}`);
  if (attention > 0) line1Parts.push(`${attention} attention`);

  let latest: OrchestrationProgressWorker | null = null;
  let latestTs = 0;
  for (const w of workers) {
    const ts = Math.max(
      Number(w.progress?.updatedAt ?? 0) || 0,
      Number(w.previewTs ?? 0) || 0,
      Number(w.lastEvent?.ts ?? 0) || 0,
    );
    if (ts >= latestTs) {
      latestTs = ts;
      latest = w;
    }
  }

  if (!latest) return { line1: line1Parts.join(" · "), line2: "No worker summary yet." };
  const rawPreview = String(latest.preview ?? latest.progress?.preview ?? "").trim();
  const clean = rawPreview ? parseProgressPreviewMeta(rawPreview).cleanText : "";
  const line2 = clean ? `${latest.name}: ${clean}` : `${latest.name}: no summary yet`;
  return { line1: line1Parts.join(" · "), line2 };
}

function makeCustomWorkerGroup(seed?: Partial<CustomWorkerGroup>): CustomWorkerGroup {
  const tool = (seed?.tool ?? "codex") as ToolId;
  return {
    id: seed?.id || `wg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tool,
    profileId: String(seed?.profileId || `${tool}.default`),
    model: String(seed?.model || ""),
    count: Math.max(1, Math.min(CUSTOM_TEAM_MAX_GROUP_COUNT, Number(seed?.count ?? 1) || 1)),
    role: String(seed?.role || "debug"),
    taskTemplate: String(seed?.taskTemplate || "Implement and verify {objective}"),
  };
}

function modelOverridesForTool(tool: ToolId, modelRaw: string): Record<string, any> {
  const model = String(modelRaw ?? "").trim();
  if (!model) return {};
  if (tool === "codex") return { codex: { model } };
  if (tool === "claude") return { claude: { model } };
  if (tool === "opencode") return { opencode: { model } };
  return {};
}

function mergeToolOverrides(base: any, patch: any): Record<string, any> {
  const out: Record<string, any> = isRecord(base) ? { ...base } : {};
  const p: Record<string, any> = isRecord(patch) ? patch : {};
  for (const key of ["codex", "claude", "opencode"]) {
    const cur = isRecord(out[key]) ? out[key] : {};
    const add = isRecord(p[key]) ? p[key] : {};
    const merged = { ...cur, ...add };
    if (Object.keys(merged).length > 0) out[key] = merged;
  }
  return out;
}

function extractNativeCallId(item: any): string | undefined {
  const candidates = [
    item?.callId,
    item?.call_id,
    item?.id,
    item?.tool_use_id,
    item?.toolUseId,
    item?.requestId,
    item?.request_id,
    item?.payload?.callId,
    item?.payload?.call_id,
    item?.payload?.id,
    item?.payload?.tool_use_id,
    item?.item?.callId,
    item?.item?.call_id,
    item?.item?.id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

function extractNativeToolName(type: string, item: any): string {
  const candidates = [
    item?.name,
    item?.tool,
    item?.toolName,
    item?.payload?.name,
    item?.payload?.tool,
    item?.item?.name,
    item?.item?.tool,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  if (type.endsWith("_call")) return type.slice(0, -5);
  if (type.endsWith("_output")) return type.slice(0, -7);
  return type || "tool";
}

function extractNativeToolInput(item: any): any {
  const candidates = [
    item?.input,
    item?.arguments,
    item?.args,
    item?.params,
    item?.payload?.input,
    item?.payload?.arguments,
    item?.payload?.args,
    item?.payload?.params,
    item?.item?.input,
    item?.item?.arguments,
  ];
  for (const c of candidates) {
    if (c != null) return c;
  }
  if (typeof item?.command === "string") return { command: item.command };
  if (typeof item?.payload?.command === "string") return { command: item.payload.command };
  return item;
}

function extractNativeToolOutput(item: any): string {
  return extractAnyText(
    item?.output ??
    item?.result ??
    item?.content ??
    item?.text ??
    item?.payload?.output ??
    item?.payload?.result ??
    item?.payload?.content ??
    item?.item?.output ??
    item?.item?.result ??
    item?.item?.content ??
    "",
  );
}

function normalizeNativeItem(rawItem: any): Array<{ type: string; item: any }> {
  if (!isRecord(rawItem)) return [];
  const out: Array<{ type: string; item: any }> = [];
  const queue: any[] = [rawItem];

  while (queue.length > 0) {
    const cur = queue.shift();
    if (!isRecord(cur)) continue;
    const type = String(cur.type ?? "").trim().toLowerCase();
    if (type === "response_item" && isRecord(cur.payload)) {
      queue.unshift(cur.payload);
      continue;
    }
    if (type === "item.completed" && isRecord(cur.item)) {
      queue.unshift(cur.item);
      continue;
    }
    if (type === "item.started" && isRecord(cur.item)) {
      queue.unshift(cur.item);
      continue;
    }
    if (isRecord(cur.payload) && typeof cur.payload.type === "string") {
      queue.unshift(cur.payload);
      continue;
    }
    if (isRecord(cur.item) && typeof cur.item.type === "string") {
      queue.unshift(cur.item);
      continue;
    }
    if (Array.isArray(cur.items)) {
      for (const nested of cur.items) queue.push(nested);
    }
    out.push({ type, item: cur });
  }

  return out;
}

function parseCodexNativeThreadMessages(thread: any): ToolSessionMessage[] {
  const out: Array<ToolSessionMessage & { _seq: number }> = [];
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  let seq = 0;

  const push = (msg: ToolSessionMessage) => {
    out.push({ ...msg, _seq: seq++ });
  };

  for (let tIdx = 0; tIdx < turns.length; tIdx++) {
    const turn = turns[tIdx] ?? {};
    const baseTs = parseMs(turn?.startedAt ?? turn?.createdAt ?? turn?.timestamp, Date.now() + tIdx);
    const userInput = extractAnyText(turn?.input ?? turn?.userInput ?? turn?.prompt ?? "");
    if (userInput.trim()) {
      push({
        role: "user",
        ts: baseTs,
        text: userInput.trim(),
        blocks: [{ type: "text", text: userInput.trim() }],
      });
    }

    const items = Array.isArray(turn?.items)
      ? turn.items
      : Array.isArray(turn?.output?.items)
        ? turn.output.items
        : [];
    for (let i = 0; i < items.length; i++) {
      const raw = items[i] ?? {};
      const ts = parseMs(raw?.updatedAt ?? raw?.createdAt ?? raw?.timestamp, baseTs + i + 1);
      const normalized = normalizeNativeItem(raw);
      for (const rec of normalized) {
        const type = String(rec.type || "").trim().toLowerCase();
        const item = rec.item;
        const callId = extractNativeCallId(item);

        const pushBlock = (block: ToolSessionMessageBlock, role: "assistant" | "user" = "assistant") => {
          if (!String(block.text ?? "").trim()) return;
          push({
            role,
            ts,
            text: String(block.text),
            blocks: [block],
          });
        };

        if (type === "reasoning" || type === "plan" || type === "thinking") {
          pushBlock({ type: "thinking", text: extractAnyText(item?.text ?? item?.summary ?? item) });
          continue;
        }
        if (type === "message") {
          const roleRaw = String(item?.role ?? "assistant").toLowerCase();
          const role: "assistant" | "user" = roleRaw === "user" ? "user" : "assistant";
          pushBlock({ type: "text", text: extractAnyText(item?.text ?? item?.content ?? item?.message ?? item) }, role);
          continue;
        }
        if (type === "agent_message" || type === "assistant_message") {
          pushBlock({ type: "text", text: extractAnyText(item?.text ?? item?.content ?? item?.message ?? item) });
          continue;
        }
        if (
          type === "command_execution" ||
          type === "file_change" ||
          type === "function_call" ||
          type === "custom_tool_call" ||
          type.endsWith("_call")
        ) {
          const name = extractNativeToolName(type, item);
          const input = extractNativeToolInput(item);
          pushBlock({ type: "tool_use", text: toolCallText(name, input), name, callId });
          const output = extractNativeToolOutput(item);
          if (output.trim()) pushBlock({ type: "tool_result", text: output, callId });
          continue;
        }
        if (type === "function_call_output" || type === "custom_tool_call_output" || type.endsWith("_output") || type === "tool_result") {
          pushBlock({ type: "tool_result", text: extractNativeToolOutput(item), callId });
          continue;
        }

        const fallback = extractAnyText(item?.text ?? item?.content ?? item?.message ?? "");
        if (fallback.trim()) pushBlock({ type: "text", text: fallback });
      }
    }
  }

  out.sort((a, b) => {
    const dt = Number(a.ts ?? 0) - Number(b.ts ?? 0);
    if (dt !== 0) return dt;
    return Number(a._seq ?? 0) - Number(b._seq ?? 0);
  });
  return out.map(({ _seq: _ignored, ...msg }) => msg);
}

export function App() {
  const [authed, setAuthed] = useState<"unknown" | "yes" | "no">("unknown");
  const [token, setToken] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [pairMsg, setPairMsg] = useState<string | null>(null);
  const [unlockMsg, setUnlockMsg] = useState<string | null>(null);

  const [tab, setTab] = useState<"inbox" | "workspace" | "run" | "new" | "settings">("inbox");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [features, setFeatures] = useState<{ terminalModeEnabled?: boolean }>({});
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);

  const [toolSession, setToolSession] = useState<ToolSessionSummary | null>(null);
  const [toolMessages, setToolMessages] = useState<ToolSessionMessage[]>([]);
  const [toolMessagesSourceKey, setToolMessagesSourceKey] = useState("");
  const [nativeThreadMessages, setNativeThreadMessages] = useState<ToolSessionMessage[]>([]);
  const [nativeMessagesSourceKey, setNativeMessagesSourceKey] = useState("");
  const [nativeLiveBlock, setNativeLiveBlock] = useState<ToolSessionMessageBlock | null>(null);
  const [pendingEchoes, setPendingEchoes] = useState<PendingEcho[]>([]);
  const [composerText, setComposerText] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [runLaunchMsg, setRunLaunchMsg] = useState<string | null>(null);
  const [globalWsState, setGlobalWsState] = useState<"closed" | "connecting" | "open">("closed");
  const activeSessionWsRef = useRef<WebSocket | null>(null);
  const activeToolSessionKeyRef = useRef("");
  const activeNativeThreadKeyRef = useRef("");
  const refreshDebounceTimerRef = useRef<any>(null);
  const orchestrationProgressPullAtRef = useRef<Record<string, number>>({});

  const [createObjective, setCreateObjective] = useState("");
  const [createProjectPath, setCreateProjectPath] = useState("");
  const [soloTool, setSoloTool] = useState<ToolId>("claude");
  const [soloProfile, setSoloProfile] = useState("claude.default");
  const [soloModel, setSoloModel] = useState("");
  const [manualAgentModels, setManualAgentModels] = useState<Record<number, string>>({});
  const [autoOrchestratorModel, setAutoOrchestratorModel] = useState("");
  const [autoWorkerModels, setAutoWorkerModels] = useState<Record<number, string>>({});
  const [soloCwd, setSoloCwd] = useState("");
  const [createBusy, setCreateBusy] = useState<null | "orchestration" | "session" | "analyzing">(null);
  const [createMsg, setCreateMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [taskActionMsg, setTaskActionMsg] = useState<string | null>(null);
  const [removeBusyKey, setRemoveBusyKey] = useState<string | null>(null);
  const [progressMetaOpen, setProgressMetaOpen] = useState<Record<string, boolean>>({});
  const [orchestrationProgressByTask, setOrchestrationProgressByTask] = useState<Record<string, OrchestrationProgressItem>>({});
  const [showOrchestrationCommands, setShowOrchestrationCommands] = useState(false);
  const [newMode, setNewMode] = useState<"smart" | "manual">("smart");
  const [selectedPreset, setSelectedPreset] = useState<string>("solo");
  const selectedPresetDef = useMemo(() => PRESETS.find(p => p.id === selectedPreset) ?? PRESETS[0]!, [selectedPreset]);
  const [configProfiles, setConfigProfiles] = useState<ProfileOption[]>([]);
  const [customOrchestratorTool, setCustomOrchestratorTool] = useState<ToolId>("codex");
  const [customOrchestratorProfile, setCustomOrchestratorProfile] = useState("codex.default");
  const [customOrchestratorModel, setCustomOrchestratorModel] = useState("");
  const [customTeamAutomationMode, setCustomTeamAutomationMode] = useState<CustomTeamAutomationMode>("guided");
  const [customTeamQuestionTimeoutMs, setCustomTeamQuestionTimeoutMs] = useState<number>(120_000);
  const [customTeamReviewIntervalMs, setCustomTeamReviewIntervalMs] = useState<number>(60_000);
  const [customTeamYoloMode, setCustomTeamYoloMode] = useState(false);
  const [customWorkerGroups, setCustomWorkerGroups] = useState<CustomWorkerGroup[]>([
    makeCustomWorkerGroup({
      tool: "codex",
      profileId: "codex.default",
      count: 2,
      role: "debug",
      taskTemplate: "Debug backend behavior and implement focused fixes for: {objective}",
    }),
  ]);
  const [budget, setBudget] = useState<"low" | "balanced" | "high">("balanced");
  const [recommendation, setRecommendation] = useState<any | null>(null);
  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  const [dirPickerTarget, setDirPickerTarget] = useState<DirectoryPickerTarget | null>(null);
  const [dirPickerPath, setDirPickerPath] = useState("");
  const [dirPickerParent, setDirPickerParent] = useState<string | null>(null);
  const [dirPickerEntries, setDirPickerEntries] = useState<Array<{ name: string; path: string; kind: "dir" | "file" }>>([]);
  const [dirPickerShowHidden, setDirPickerShowHidden] = useState(false);
  const [dirPickerBusy, setDirPickerBusy] = useState(false);
  const [dirPickerMsg, setDirPickerMsg] = useState<string | null>(null);
  const [pathPrivacyMode, setPathPrivacyMode] = useState<PathPrivacyMode>(() => {
    const saved = lsGet(PATH_PRIVACY_MODE_KEY);
    return saved === "share" ? "share" : "full";
  });
  const [claudeAutoTrustShareMode, setClaudeAutoTrustShareMode] = useState<boolean>(() => {
    const saved = lsGet(CLAUDE_SHARE_TRUST_KEY);
    if (saved == null) return true;
    return saved !== "0";
  });

  const defaultWorkspacePath = useMemo(
    () => doctor?.process?.cwd || doctor?.workspaceRoots?.[0] || "",
    [doctor],
  );
  const userHomePrefix = useMemo(
    () =>
      detectUserHomePrefix([
        doctor?.process?.cwd,
        ...(doctor?.workspaceRoots ?? []),
        ...sessions.map((s) => s.cwd || ""),
      ]),
    [doctor, sessions],
  );
  const formatDisplayPath = useCallback(
    (pathRaw: string | null | undefined) => formatPathForUi(pathRaw, pathPrivacyMode, userHomePrefix),
    [pathPrivacyMode, userHomePrefix],
  );
  const formatDisplayPathTail = useCallback(
    (pathRaw: string | null | undefined, segments = 2) => {
      const shown = formatDisplayPath(pathRaw);
      if (!shown) return "";
      if (shown === "~") return shown;
      const normalized = shown.replace(/\\/g, "/");
      const parts = normalized.split("/").filter(Boolean);
      if (parts.length === 0) return shown;
      const tail = parts.slice(-Math.max(1, segments)).join("/");
      if (normalized.startsWith("~/")) return `~/${tail}`;
      return tail;
    },
    [formatDisplayPath],
  );

  useEffect(() => {
    lsSet(PATH_PRIVACY_MODE_KEY, pathPrivacyMode);
  }, [pathPrivacyMode]);
  useEffect(() => {
    lsSet(CLAUDE_SHARE_TRUST_KEY, claudeAutoTrustShareMode ? "1" : "0");
  }, [claudeAutoTrustShareMode]);

  const claudeSupportsDangerousSkip = Boolean((doctor?.tools as any)?.claude?.supports?.dangerouslySkipPermissions);
  const shareModeAutoTrustClaude = pathPrivacyMode === "share" && claudeAutoTrustShareMode && claudeSupportsDangerousSkip;
  const shareModeClaudeOverridesForTool = useCallback(
    (tool: ToolId) => {
      if (!shareModeAutoTrustClaude || tool !== "claude") return {};
      return { claude: { dangerouslySkipPermissions: true } };
    },
    [shareModeAutoTrustClaude],
  );
  const withShareModeClaudeTrust = useCallback(
    (tool: ToolId, baseOverrides: any) => mergeToolOverrides(baseOverrides, shareModeClaudeOverridesForTool(tool)),
    [shareModeClaudeOverridesForTool],
  );

  const customTeamAutomationPayload = useMemo(() => {
    const mode = customTeamAutomationMode;
    const steeringMode =
      mode === "autopilot"
        ? "active_steering"
        : mode === "guided"
          ? "passive_review"
          : "off";
    return {
      questionMode: mode === "manual" ? "off" : "orchestrator",
      steeringMode,
      questionTimeoutMs: Math.max(30_000, Math.floor(customTeamQuestionTimeoutMs || 120_000)),
      reviewIntervalMs: Math.max(30_000, Math.floor(customTeamReviewIntervalMs || 60_000)),
      yoloMode: customTeamYoloMode,
    } as const;
  }, [customTeamAutomationMode, customTeamQuestionTimeoutMs, customTeamReviewIntervalMs, customTeamYoloMode]);

  // Boot: detect token/pair from URL
  useEffect(() => {
    const u = new URL(window.location.href);
    const bootQuery = (((window as any).__FYP_BOOT_QUERY ?? {}) as { token?: string; pair?: string }) || {};
    const t = u.searchParams.get("token") || (typeof bootQuery.token === "string" ? bootQuery.token : "");
    const pair = u.searchParams.get("pair") || (typeof bootQuery.pair === "string" ? bootQuery.pair : "");
    if ((window as any).__FYP_BOOT_QUERY) (window as any).__FYP_BOOT_QUERY = { token: "", pair: "" };
    if (t) { u.searchParams.delete("token"); window.history.replaceState({}, "", u.toString()); }
    if (pair) {
      u.searchParams.delete("pair");
      window.history.replaceState({}, "", u.toString());
      (async () => {
        try {
          await api("/api/auth/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pair }) });
          window.location.reload();
        } catch {
          setAuthed("no");
          setPairMsg("Pair link expired or invalid.");
        }
      })();
      return;
    }
    (async () => {
      try {
        const d = await api<Doctor>("/api/doctor", t ? { headers: { "x-fyp-token": t } } : undefined);
        setDoctor(d);
        setAuthed("yes");
      } catch (e: any) {
        setAuthed("no");
        if (typeof e?.message === "string" && e.message !== "unauthorized") {
          setUnlockMsg(`Connection failed: ${e.message}`);
        }
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (authed !== "yes") return;
    try {
      const [f, s, t, i] = await Promise.all([
        api<{ terminalModeEnabled?: boolean }>("/api/features").catch(() => ({})),
        api<SessionRow[]>("/api/sessions?includeInternal=0").catch(() => []),
        api<{ ok: true; items: TaskCard[] }>("/api/tasks?includeInternal=0").catch(() => ({ items: [] as TaskCard[] })),
        api<{ ok: true; items: InboxItem[] }>("/api/inbox").catch(() => ({ items: [] as InboxItem[] })),
      ]);
      const nextSessions = Array.isArray(s) ? s.filter(isRecord) as SessionRow[] : [];
      const nextTasks = Array.isArray(t?.items)
        ? t.items
          .filter(isRecord)
          .map((task: any) => ({
            ...task,
            members: Array.isArray(task?.members) ? task.members.filter(isRecord) : [],
          })) as TaskCard[]
        : [];
      const nextInbox = Array.isArray(i?.items) ? i.items.filter(isRecord) as InboxItem[] : [];
      setFeatures((f as any)?.features && typeof (f as any).features === "object" ? (f as any).features : (f as any));
      setSessions(nextSessions);
      setTasks(nextTasks);
      setInbox(nextInbox);
    } catch (e: any) { console.error(e); }
  }, [authed]);

  useEffect(() => {
    if (authed !== "yes") return;
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api<{ ok: boolean; profiles?: Array<{ id?: string; title?: string; tool?: string }> }>("/api/config");
        if (cancelled) return;
        const profs = Array.isArray(cfg?.profiles)
          ? cfg.profiles
            .map((p) => {
              const id = String(p?.id ?? "").trim();
              if (!id) return null;
              const label = String(p?.title ?? "").trim() || id;
              return { id, label };
            })
            .filter(Boolean) as ProfileOption[]
          : [];
        setConfigProfiles(profs);
      } catch {
        // fallback profiles are used automatically
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authed]);

  const queueRefresh = useCallback((delayMs = 350) => {
    if (refreshDebounceTimerRef.current) return;
    refreshDebounceTimerRef.current = setTimeout(() => {
      refreshDebounceTimerRef.current = null;
      void refresh();
    }, Math.max(80, Math.floor(delayMs)));
  }, [refresh]);

  useEffect(() => {
    return () => {
      try {
        if (refreshDebounceTimerRef.current) clearTimeout(refreshDebounceTimerRef.current);
      } catch {
        // ignore
      }
      refreshDebounceTimerRef.current = null;
    };
  }, []);

  const refreshToolSession = useCallback(async (toolName: string, id: string) => {
    try {
      if (!id || !toolName || toolName === "(unknown)") return;
      const requestKey = `${String(activeSessionId ?? "")}:${toolName}:${id}`;
      if (!requestKey || activeToolSessionKeyRef.current !== requestKey) return;
      const summary = await api<ToolSessionSummary>(`/api/tool-sessions/${toolName}/${id}`);
      const messagesObj = await api<{ messages: ToolSessionMessage[] }>(`/api/tool-sessions/${toolName}/${id}/messages`);
      if (activeToolSessionKeyRef.current !== requestKey) return;
      setToolSession(summary);
      setToolMessages(Array.isArray(messagesObj.messages) ? messagesObj.messages : []);
      setToolMessagesSourceKey(requestKey);
    } catch (e: any) { console.error("Failed to load tool messages", e); }
  }, [activeSessionId]);

  const refreshNativeThread = useCallback(async (threadId: string) => {
    if (!threadId) return;
    try {
      const requestKey = `${String(activeSessionId ?? "")}:${threadId}`;
      if (!requestKey || activeNativeThreadKeyRef.current !== requestKey) return;
      const resp = await api<NativeThreadResp>(`/api/codex-native/threads/${encodeURIComponent(threadId)}`);
      const next = parseCodexNativeThreadMessages(resp?.thread ?? null);
      if (activeNativeThreadKeyRef.current !== requestKey) return;
      setNativeThreadMessages(next);
      setNativeMessagesSourceKey(requestKey);
    } catch (e: any) {
      console.error("Failed to load codex native thread", e);
    }
  }, [activeSessionId]);

  // Global polling (8s baseline; websocket events trigger debounced refreshes sooner)
  useEffect(() => {
    void refresh();
    if (authed === "yes") {
      const t = setInterval(() => void refresh(), 8000);
      return () => clearInterval(t);
    }
  }, [refresh, authed]);

  // Resolve active session def
  const activeSessionDef = useMemo((): SessionRow | null => {
    const activeTask = tasks.find((t) => t.id === activeTaskId);
    return sessions.find((s) => s.id === activeSessionId)
      || activeTask?.members?.find(m => m.sessionId === activeSessionId)?.session
      || null;
  }, [activeSessionId, sessions, tasks, activeTaskId]);

  const isCodexNative = useMemo(
    () =>
      Boolean(
        activeSessionDef?.tool === "codex" &&
        activeSessionDef?.transport === "codex-app-server" &&
        activeSessionDef?.toolSessionId,
      ),
    [activeSessionDef?.tool, activeSessionDef?.transport, activeSessionDef?.toolSessionId],
  );

  // Raw/terminal view is now strictly a mode decision.
  // Missing toolSession IDs should not force users out of wrapper mode.
  const showRawTerminal = useMemo(() => {
    if (!activeSessionDef) return true;
    if (activeSessionDef.taskMode === "terminal") return true;
    return false;
  }, [activeSessionDef]);

  const canWrap = useMemo(
    () => Boolean(isCodexNative || activeSessionDef?.toolSessionId),
    [isCodexNative, activeSessionDef?.toolSessionId],
  );

  const activeToolSessionKey = useMemo(() => {
    if (!activeSessionId || showRawTerminal || isCodexNative) return "";
    const tool = String(activeSessionDef?.tool ?? "").trim();
    const toolSessionId = String(activeSessionDef?.toolSessionId ?? "").trim();
    if (!tool || !toolSessionId) return "";
    return `${activeSessionId}:${tool}:${toolSessionId}`;
  }, [activeSessionId, showRawTerminal, isCodexNative, activeSessionDef?.tool, activeSessionDef?.toolSessionId]);

  const activeNativeThreadKey = useMemo(() => {
    if (!activeSessionId || showRawTerminal || !isCodexNative) return "";
    const threadId = String(activeSessionDef?.toolSessionId ?? "").trim();
    if (!threadId) return "";
    return `${activeSessionId}:${threadId}`;
  }, [activeSessionId, showRawTerminal, isCodexNative, activeSessionDef?.toolSessionId]);

  useEffect(() => {
    activeToolSessionKeyRef.current = activeToolSessionKey;
    setToolSession(null);
    setToolMessages([]);
    setToolMessagesSourceKey("");
  }, [activeToolSessionKey]);

  useEffect(() => {
    activeNativeThreadKeyRef.current = activeNativeThreadKey;
    setNativeThreadMessages([]);
    setNativeMessagesSourceKey("");
    setNativeLiveBlock(null);
  }, [activeNativeThreadKey]);

  // Load persisted tool messages for non-native wrapper sessions.
  useEffect(() => {
    if (!activeSessionId || authed !== "yes" || showRawTerminal) {
      setToolSession(null);
      setToolMessages([]);
      setToolMessagesSourceKey("");
      if (!showRawTerminal) setRunMsg(null);
      return;
    }
    if (isCodexNative) {
      setToolMessages([]);
      setToolMessagesSourceKey("");
      const sid = String(activeSessionDef?.toolSessionId ?? "");
      setToolSession(
        sid
          ? {
            tool: "codex",
            id: sid,
            cwd: String(activeSessionDef?.cwd ?? ""),
            createdAt: null,
            updatedAt: Date.now(),
            title: activeSessionDef?.profileId ?? "codex.native",
            preview: null,
            messageCount: null,
            gitBranch: null,
          }
          : null,
      );
      return;
    }
    if (activeSessionDef?.tool && activeSessionDef.toolSessionId) {
      void refreshToolSession(activeSessionDef.tool, activeSessionDef.toolSessionId);
    }
  }, [activeSessionId, activeSessionDef?.toolSessionId, showRawTerminal, refreshToolSession, authed, isCodexNative, activeSessionDef?.tool, activeSessionDef?.cwd, activeSessionDef?.profileId]);

  // Poll persisted tool messages for non-native wrapper sessions.
  useEffect(() => {
    if (!activeSessionId || authed !== "yes" || showRawTerminal) return;
    if (isCodexNative) return;
    if (!activeSessionDef?.tool || !activeSessionDef.toolSessionId) return;
    const tool = activeSessionDef.tool;
    const toolId = activeSessionDef.toolSessionId;
    const interval = setInterval(
      () => void refreshToolSession(tool, toolId),
      activeSessionDef?.running ? 3800 : 6500,
    );
    return () => clearInterval(interval);
  }, [activeSessionId, activeSessionDef?.tool, activeSessionDef?.toolSessionId, activeSessionDef?.running, showRawTerminal, authed, refreshToolSession, isCodexNative]);

  // Poll Codex native thread snapshots while in wrapper mode.
  useEffect(() => {
    if (!activeSessionId || authed !== "yes" || showRawTerminal || !isCodexNative) {
      setNativeThreadMessages([]);
      setNativeMessagesSourceKey("");
      setNativeLiveBlock(null);
      return;
    }
    const threadId = String(activeSessionDef?.toolSessionId ?? "");
    if (!threadId) return;
    void refreshNativeThread(threadId);
    const interval = setInterval(() => void refreshNativeThread(threadId), activeSessionDef?.running ? 1800 : 3600);
    return () => clearInterval(interval);
  }, [activeSessionId, authed, showRawTerminal, isCodexNative, activeSessionDef?.toolSessionId, refreshNativeThread, activeSessionDef?.running]);

  useEffect(() => {
    if (!defaultWorkspacePath) return;
    setCreateProjectPath(p => p || defaultWorkspacePath);
    setSoloCwd(p => p || defaultWorkspacePath);
  }, [defaultWorkspacePath]);

  useEffect(() => {
    setSoloProfile(prev => prev.startsWith(`${soloTool}.`) ? prev : `${soloTool}.default`);
  }, [soloTool]);

  useEffect(() => {
    setCustomOrchestratorProfile((prev) =>
      normalizeProfileIdForTool(customOrchestratorTool, prev, configProfiles),
    );
  }, [customOrchestratorTool, configProfiles]);

  useEffect(() => {
    setSoloModel("");
  }, [soloTool]);

  useEffect(() => {
    setManualAgentModels({});
  }, [selectedPreset]);

  useEffect(() => {
    setCustomWorkerGroups((prev) =>
      prev.map((g) => ({
        ...g,
        profileId: normalizeProfileIdForTool(g.tool, g.profileId, configProfiles),
      })),
    );
  }, [configProfiles]);

  useEffect(() => {
    setAutoOrchestratorModel("");
    setAutoWorkerModels({});
  }, [recommendation]);

  // Keep global app state fresh with websocket events.
  useEffect(() => {
    if (authed !== "yes") {
      setGlobalWsState("closed");
      return;
    }
    let closed = false;
    let retryTimer: any = null;
    let ws: WebSocket | null = null;

    const connect = () => {
      if (closed) return;
      setGlobalWsState("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      ws = new WebSocket(`${protocol}//${host}/ws/global`);
      ws.onopen = () => setGlobalWsState("open");
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data ?? "{}"));
          if (msg?.type === "sessions.changed" || msg?.type === "tasks.changed" || msg?.type === "inbox.changed" || msg?.type === "workspaces.changed") {
            queueRefresh(320);
          }
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        setGlobalWsState("closed");
        if (closed) return;
        retryTimer = setTimeout(connect, 1200);
      };
      ws.onerror = () => {
        // onclose will handle retries
      };
    };

    connect();
    return () => {
      closed = true;
      try {
        if (retryTimer) clearTimeout(retryTimer);
      } catch {
        // ignore
      }
      try {
        ws?.close();
      } catch {
        // ignore
      }
      setGlobalWsState("closed");
    };
  }, [authed, queueRefresh]);

  // Session websocket: live codex-native deltas + immediate wrapper refresh triggers.
  useEffect(() => {
    const sid = String(activeSessionId ?? "");
    if (!sid || authed !== "yes" || showRawTerminal) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const ws = new WebSocket(`${protocol}//${host}/ws/sessions/${sid}`);
    activeSessionWsRef.current = ws;

    ws.onmessage = (ev) => {
      let msg: any = null;
      try {
        msg = JSON.parse(String(ev.data ?? "{}"));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "event") {
        const kind = String(msg?.event?.kind ?? "");
        if (kind === "input" && activeSessionDef?.tool && activeSessionDef.toolSessionId && !isCodexNative) {
          void refreshToolSession(activeSessionDef.tool, activeSessionDef.toolSessionId);
        }
      }

      if (!isCodexNative) return;

      if (msg.type === "codex.native.delta") {
        const kind = String(msg.kind ?? "");
        const delta = typeof msg.delta === "string" ? msg.delta : "";
        if (!delta) return;
        if (kind === "reasoning") {
          setNativeLiveBlock((prev) => ({
            type: "thinking",
            text: `${prev?.type === "thinking" ? prev.text : ""}${delta}`,
          }));
        } else {
          setNativeLiveBlock((prev) => ({
            type: "text",
            text: `${prev?.type === "text" ? prev.text : ""}${delta}`,
          }));
        }
        return;
      }

      if (msg.type === "codex.native.turn") {
        if (String(msg.event ?? "") === "completed") setNativeLiveBlock(null);
        const threadId = String(activeSessionDef?.toolSessionId ?? "");
        if (threadId) void refreshNativeThread(threadId);
        return;
      }

      if (msg.type === "codex.native.notification") {
        const method = String(msg?.method ?? "");
        if (method === "item/started" || method === "item/completed") {
          const threadId = String(activeSessionDef?.toolSessionId ?? "");
          if (threadId) void refreshNativeThread(threadId);
        }
      }
    };

    return () => {
      if (activeSessionWsRef.current === ws) activeSessionWsRef.current = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
      setNativeLiveBlock(null);
    };
  }, [activeSessionId, authed, showRawTerminal, isCodexNative, activeSessionDef?.tool, activeSessionDef?.toolSessionId, refreshToolSession, refreshNativeThread]);

  // Drop stale optimistic echoes and clear composer status when session changes.
  useEffect(() => {
    setRunMsg(null);
    const sid = String(activeSessionId ?? "");
    if (!sid) return;
    setPendingEchoes((prev) => prev.filter((e) => e.sessionId !== sid || Date.now() - e.ts < 45_000));
  }, [activeSessionId]);

  useEffect(() => {
    const t = setInterval(() => {
      setPendingEchoes((prev) => prev.filter((e) => Date.now() - e.ts < 45_000));
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const activeEchoMessages = useMemo<ToolSessionMessage[]>(() => {
    const sid = String(activeSessionId ?? "");
    if (!sid) return [];
    return pendingEchoes
      .filter((e) => e.sessionId === sid)
      .map((e) => ({
        role: "user",
        ts: e.ts,
        text: e.text,
        blocks: [{ type: "text", text: e.text }],
      }));
  }, [pendingEchoes, activeSessionId]);

  const visibleToolMessages = useMemo<ToolSessionMessage[]>(() => {
    if (!activeToolSessionKey) return [];
    if (toolMessagesSourceKey !== activeToolSessionKey) return [];
    return toolMessages;
  }, [activeToolSessionKey, toolMessagesSourceKey, toolMessages]);

  const visibleNativeThreadMessages = useMemo<ToolSessionMessage[]>(() => {
    if (!activeNativeThreadKey) return [];
    if (nativeMessagesSourceKey !== activeNativeThreadKey) return [];
    return nativeThreadMessages;
  }, [activeNativeThreadKey, nativeMessagesSourceKey, nativeThreadMessages]);

  const displayToolMessages = useMemo<ToolSessionMessage[]>(() => {
    const base =
      isCodexNative && visibleNativeThreadMessages.length > 0 ? visibleNativeThreadMessages : visibleToolMessages;
    const merged = [...base, ...activeEchoMessages];
    if (nativeLiveBlock && isCodexNative) {
      merged.push({
        role: "assistant",
        ts: Date.now(),
        text: nativeLiveBlock.text,
        blocks: [nativeLiveBlock],
      });
    }
    merged.sort((a, b) => {
      const dt = Number(a.ts ?? 0) - Number(b.ts ?? 0);
      if (dt !== 0) return dt;
      if (a.role !== b.role) return a.role === "user" ? -1 : 1;
      return 0;
    });
    return merged;
  }, [isCodexNative, visibleNativeThreadMessages, visibleToolMessages, activeEchoMessages, nativeLiveBlock]);

  // Reconcile optimistic echoes once persisted user messages arrive.
  // Important: only compare against persisted history, not against optimistic echoes
  // themselves, otherwise the echo is dropped immediately after send.
  useEffect(() => {
    if (!activeSessionId) return;
    const persisted =
      isCodexNative && visibleNativeThreadMessages.length > 0 ? visibleNativeThreadMessages : visibleToolMessages;
    const userTexts = new Set(
      persisted
        .filter((m) => m.role === "user")
        .map((m) => String(m.text ?? "").trim())
        .filter(Boolean),
    );
    setPendingEchoes((prev) => {
      let changed = false;
      const next: PendingEcho[] = [];
      for (const e of prev) {
        const dup = e.sessionId === activeSessionId && userTexts.has(String(e.text ?? "").trim());
        if (dup) {
          changed = true;
          continue;
        }
        next.push(e);
      }
      return changed ? next : prev;
    });
  }, [activeSessionId, isCodexNative, visibleNativeThreadMessages, visibleToolMessages]);

  const sendToActiveSession = useCallback(async () => {
    const sid = String(activeSessionId ?? "");
    if (!sid || sendBusy) return;
    const text = composerText.trim();
    if (!text) return;
    const sendText = /[\r\n]$/.test(text) ? text : `${text}\r`;
    const echoText = text;
    const echo: PendingEcho = {
      id: `${sid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: sid,
      ts: Date.now(),
      text: echoText,
    };
    setComposerText("");
    setRunMsg(null);
    setPendingEchoes((prev) => [...prev.slice(-120), echo]);
    setSendBusy(true);
    try {
      await api(`/api/sessions/${encodeURIComponent(sid)}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: sendText }),
      });
      if (isCodexNative) {
        const threadId = String(activeSessionDef?.toolSessionId ?? "");
        if (threadId) void refreshNativeThread(threadId);
      } else if (activeSessionDef?.tool && activeSessionDef.toolSessionId) {
        void refreshToolSession(activeSessionDef.tool, activeSessionDef.toolSessionId);
      }
    } catch (e: any) {
      setRunMsg(typeof e?.message === "string" ? e.message : "Failed to send message.");
    } finally {
      setSendBusy(false);
    }
  }, [activeSessionId, sendBusy, composerText, isCodexNative, activeSessionDef?.toolSessionId, activeSessionDef?.tool, refreshNativeThread, refreshToolSession]);

  const switchMode = useCallback((mode: "wrap" | "terminal") => {
    if (!activeSessionId) return;
    api(`/api/sessions/${activeSessionId}/mode`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then(async () => {
      await refresh();
      if (mode !== "wrap") return;
      const threadId = String(activeSessionDef?.toolSessionId ?? "");
      if (isCodexNative && threadId) {
        void refreshNativeThread(threadId);
        return;
      }
      const tool = String(activeSessionDef?.tool ?? "");
      if (tool && threadId) void refreshToolSession(tool, threadId);
    }).catch(console.error);
  }, [activeSessionId, refresh, activeSessionDef?.toolSessionId, activeSessionDef?.tool, isCodexNative, refreshNativeThread, refreshToolSession]);

  const openSession = useCallback((sessionId: string, taskId?: string | null) => {
    setActiveSessionId(sessionId);
    setActiveTaskId(taskId ?? null);
    setTab("run");
  }, []);

  const orchestrationIdFromTaskId = useCallback((taskId: string | null | undefined): string | null => {
    const id = String(taskId ?? "").trim();
    if (!id) return null;
    if (id.startsWith("orch:")) return id.slice(5);
    return null;
  }, []);

  const refreshOrchestrationProgress = useCallback(async (taskId: string) => {
    const orchestrationId = orchestrationIdFromTaskId(taskId);
    if (!orchestrationId) return;
    try {
      const resp = await api<{ ok: true; item: OrchestrationProgressItem }>(
        `/api/orchestrations/${encodeURIComponent(orchestrationId)}/progress`,
      );
      if (isRecord(resp?.item)) {
        const workers = Array.isArray((resp.item as any).workers)
          ? (resp.item as any).workers.filter(isRecord) as OrchestrationProgressWorker[]
          : [];
        setOrchestrationProgressByTask((prev) => ({
          ...prev,
          [taskId]: {
            ...(resp.item as any),
            workers,
          },
        }));
      }
    } catch {
      // ignore; task may have been removed
    }
  }, [orchestrationIdFromTaskId]);

  useEffect(() => {
    if (!activeTaskId) return;
    const task = tasks.find((t) => t.id === activeTaskId);
    if (!task || task.kind !== "orchestrator") return;
    void refreshOrchestrationProgress(activeTaskId);
    const t = setInterval(() => void refreshOrchestrationProgress(activeTaskId), 5000);
    return () => clearInterval(t);
  }, [activeTaskId, tasks, refreshOrchestrationProgress]);

  useEffect(() => {
    const targetTaskIds = new Set<string>();
    for (const item of inbox) {
      const taskId = String(item?.taskId ?? "").trim();
      if (item.status !== "open" || !taskId.startsWith("orch:")) continue;
      targetTaskIds.add(taskId);
    }
    if (activeTaskId && activeTaskId.startsWith("orch:")) targetTaskIds.add(activeTaskId);
    if (!targetTaskIds.size) return;

    const now = Date.now();
    for (const taskId of targetTaskIds) {
      const last = Number(orchestrationProgressPullAtRef.current[taskId] ?? 0) || 0;
      if (now - last < 3500) continue;
      orchestrationProgressPullAtRef.current[taskId] = now;
      void refreshOrchestrationProgress(taskId);
    }
  }, [inbox, activeTaskId, refreshOrchestrationProgress]);

  const dismissInboxItem = useCallback(async (id: number) => {
    const key = `inbox:${id}`;
    if (removeBusyKey) return;
    setRemoveBusyKey(key);
    try {
      await api(`/api/inbox/${encodeURIComponent(String(id))}/dismiss`, { method: "POST" });
      await refresh();
    } catch (e: any) {
      setTaskActionMsg(typeof e?.message === "string" ? e.message : "Dismiss failed.");
      setTimeout(() => setTaskActionMsg(null), 3000);
    } finally {
      setRemoveBusyKey(null);
    }
  }, [refresh, removeBusyKey]);

  const removeSession = useCallback(async (sessionId: string) => {
    const sid = String(sessionId ?? "").trim();
    if (!sid || removeBusyKey) return;
    setRemoveBusyKey(`session:${sid}`);
    setTaskActionMsg(null);
    try {
      await api(`/api/sessions/${encodeURIComponent(sid)}?force=1`, { method: "DELETE" });
      if (activeSessionId === sid) setActiveSessionId(null);
      await refresh();
      setTaskActionMsg("Session removed.");
      setTimeout(() => setTaskActionMsg(null), 2500);
    } catch (e: any) {
      setTaskActionMsg(typeof e?.message === "string" ? e.message : "Failed to remove session.");
      setTimeout(() => setTaskActionMsg(null), 3000);
    } finally {
      setRemoveBusyKey(null);
    }
  }, [activeSessionId, refresh, removeBusyKey]);

  const removeTask = useCallback(async (task: TaskCard | null | undefined) => {
    if (!task || removeBusyKey) return;
    const key = `task:${task.id}`;
    setRemoveBusyKey(key);
    setTaskActionMsg(null);
    try {
      const orchestrationId = orchestrationIdFromTaskId(task.id);
      if (task.kind === "orchestrator" && orchestrationId) {
        await api(`/api/orchestrations/${encodeURIComponent(orchestrationId)}/cleanup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stopSessions: true,
            deleteSessions: true,
            removeWorktrees: false,
            removeRecord: true,
            keepCoordinator: false,
          }),
        });
      } else {
        await api(`/api/tasks/${encodeURIComponent(task.id)}/archive`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stopMembers: true, hardCleanup: true }),
        });
      }
      setOrchestrationProgressByTask((prev) => {
        const next = { ...prev };
        delete next[task.id];
        return next;
      });
      if (activeTaskId === task.id) setActiveTaskId(null);
      if (task.primarySessionId && activeSessionId === task.primarySessionId) setActiveSessionId(null);
      await refresh();
      setTaskActionMsg("Task removed.");
      setTimeout(() => setTaskActionMsg(null), 2600);
    } catch (e: any) {
      setTaskActionMsg(typeof e?.message === "string" ? e.message : "Failed to remove task.");
      setTimeout(() => setTaskActionMsg(null), 3200);
    } finally {
      setRemoveBusyKey(null);
    }
  }, [activeSessionId, activeTaskId, orchestrationIdFromTaskId, refresh, removeBusyKey]);

  const quickLaunchTerminal = useCallback(async (tool: ToolId) => {
    setRunLaunchMsg(null);
    try {
      const created = await api<{ id: string; taskId?: string | null }>("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool,
          profileId: `${tool}.default`,
          cwd: defaultWorkspacePath || undefined,
          savePreset: true,
          overrides: withShareModeClaudeTrust(tool, {}),
        }),
      });
      if (features.terminalModeEnabled) {
        await api(`/api/sessions/${encodeURIComponent(created.id)}/mode`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "terminal" }),
        }).catch(() => undefined);
      }
      await refresh();
      openSession(created.id, created.taskId);
    } catch (e: any) {
      setRunLaunchMsg(typeof e?.message === "string" ? e.message : `Failed to launch ${tool}.`);
    }
  }, [defaultWorkspacePath, features.terminalModeEnabled, refresh, openSession, withShareModeClaudeTrust]);

  const applyPickedDirectory = useCallback((pickedPath: string) => {
    const cleaned = String(pickedPath ?? "").trim();
    if (!cleaned) return;
    if (dirPickerTarget === "soloCwd") setSoloCwd(cleaned);
    else setCreateProjectPath(cleaned);
    setDirPickerOpen(false);
    setDirPickerMsg(null);
  }, [dirPickerTarget]);

  const loadDirectoryPicker = useCallback(async (rawPath: string, opts?: { showHidden?: boolean }) => {
    const startPath =
      String(rawPath ?? "").trim() ||
      defaultWorkspacePath ||
      doctor?.workspaceRoots?.[0] ||
      "/";
    const showHidden =
      typeof opts?.showHidden === "boolean" ? opts.showHidden : dirPickerShowHidden;
    setDirPickerBusy(true);
    setDirPickerMsg(null);
    try {
      const resp = await api<{
        dir?: string;
        parent?: string | null;
        entries?: Array<{ name?: string; path?: string; kind?: string }>;
      }>(`/api/fs/list?path=${encodeURIComponent(startPath)}&showHidden=${showHidden ? "1" : "0"}`);
      const items = Array.isArray(resp?.entries)
        ? resp.entries
          .map((it) => {
            const name = String(it?.name ?? "").trim();
            const pathVal = String(it?.path ?? "").trim();
            const kind = String(it?.kind ?? "") === "dir" ? "dir" : "file";
            if (!name || !pathVal) return null;
            return { name, path: pathVal, kind };
          })
          .filter(Boolean) as Array<{ name: string; path: string; kind: "dir" | "file" }>
        : [];
      setDirPickerPath(String(resp?.dir ?? startPath));
      setDirPickerParent(typeof resp?.parent === "string" && resp.parent.trim() ? String(resp.parent) : null);
      setDirPickerEntries(items);
    } catch (e: any) {
      setDirPickerMsg(typeof e?.message === "string" ? e.message : "Could not open this folder.");
    } finally {
      setDirPickerBusy(false);
    }
  }, [defaultWorkspacePath, doctor?.workspaceRoots, dirPickerShowHidden]);

  const openDirectoryPicker = useCallback((target: DirectoryPickerTarget) => {
    const current = target === "soloCwd" ? soloCwd.trim() : createProjectPath.trim();
    const initialPath = current || defaultWorkspacePath || doctor?.workspaceRoots?.[0] || "/";
    setDirPickerTarget(target);
    setDirPickerOpen(true);
    setDirPickerPath(initialPath);
    setDirPickerParent(null);
    setDirPickerEntries([]);
    setDirPickerMsg(null);
    void loadDirectoryPicker(initialPath, { showHidden: dirPickerShowHidden });
  }, [soloCwd, createProjectPath, defaultWorkspacePath, doctor?.workspaceRoots, loadDirectoryPicker, dirPickerShowHidden]);

  const toggleDirectoryHidden = useCallback((next: boolean) => {
    setDirPickerShowHidden(next);
    void loadDirectoryPicker(dirPickerPath || defaultWorkspacePath || "/", { showHidden: next });
  }, [dirPickerPath, defaultWorkspacePath, loadDirectoryPicker]);

  const createDirectoryInPicker = useCallback(async (name: string, parentPath: string) => {
    const folderName = String(name ?? "").trim();
    if (!folderName) {
      setDirPickerMsg("Enter a folder name.");
      return;
    }
    setDirPickerBusy(true);
    setDirPickerMsg(null);
    try {
      const resp = await api<{ path?: string; created?: boolean }>("/api/fs/mkdir", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: parentPath, name: folderName }),
      });
      const nextPath = String(resp?.path ?? "").trim();
      if (nextPath) {
        setDirPickerMsg(resp?.created === false ? "Folder already exists." : "Folder created.");
        await loadDirectoryPicker(nextPath, { showHidden: dirPickerShowHidden });
      } else {
        setDirPickerMsg("Folder ready.");
        await loadDirectoryPicker(parentPath, { showHidden: dirPickerShowHidden });
      }
    } catch (e: any) {
      setDirPickerMsg(typeof e?.message === "string" ? e.message : "Failed to create folder.");
    } finally {
      setDirPickerBusy(false);
    }
  }, [dirPickerShowHidden, loadDirectoryPicker]);


  const analyzeGoal = useCallback(async () => {
    const objective = createObjective.trim();
    const projectPath = createProjectPath.trim() || defaultWorkspacePath;
    if (!objective) { setCreateMsg({ text: "Describe what you want to accomplish.", ok: false }); return; }
    setCreateBusy("analyzing");
    setCreateMsg(null);
    setRecommendation(null);
    try {
      const result = await api<{ ok: boolean; recommendation: any }>("/api/harness/creator/recommend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objective,
          projectPath: projectPath || undefined,
          prefs: { budget, priority: "balanced", maxWorkers: 4, allowWorkspaceScan: true },
        }),
      });
      if (result?.recommendation) setRecommendation(result.recommendation);
      else setCreateMsg({ text: "Couldn't generate a recommendation. Try again.", ok: false });
    } catch (e: any) {
      setCreateMsg({ text: typeof e?.message === "string" ? e.message : "Analysis failed.", ok: false });
    } finally { setCreateBusy(null); }
  }, [createObjective, createProjectPath, defaultWorkspacePath, budget]);

  const launchFromRecommendation = useCallback(async () => {
    if (!recommendation || createBusy) return;
    const objective = createObjective.trim();
    const projectPath = (createProjectPath.trim() || defaultWorkspacePath);
    if (!projectPath) { setCreateMsg({ text: "Project path is required.", ok: false }); return; }
    setCreateBusy("orchestration");
    setCreateMsg(null);
    try {
      const built = await api<{ ok: boolean; orchestrationSpec?: any }>("/api/harness/creator/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective, projectPath, prefs: { budget, priority: "balanced", maxWorkers: 4, allowWorkspaceScan: true } }),
      });
      if (!built?.orchestrationSpec) throw new Error("No spec returned.");
      const orchestrationSpec = structuredClone(built.orchestrationSpec ?? {});
      if (isRecord(orchestrationSpec?.orchestrator)) {
        const orchTool = String((orchestrationSpec.orchestrator as any).tool ?? "").trim() as ToolId;
        const withModel = mergeToolOverrides((orchestrationSpec.orchestrator as any).overrides, modelOverridesForTool(orchTool, autoOrchestratorModel));
        const finalOverrides = withShareModeClaudeTrust(orchTool, withModel);
        if (Object.keys(finalOverrides).length > 0) (orchestrationSpec.orchestrator as any).overrides = finalOverrides;
      }
      const workers = Array.isArray(orchestrationSpec?.workers) ? orchestrationSpec.workers : [];
      orchestrationSpec.workers = workers.map((w: any, idx: number) => {
        const tool = String(w?.tool ?? "").trim() as ToolId;
        const merged = withShareModeClaudeTrust(tool, mergeToolOverrides(w?.overrides, modelOverridesForTool(tool, autoWorkerModels[idx] ?? "")));
        if (Object.keys(merged).length === 0) return w;
        return {
          ...w,
          overrides: merged,
        };
      });
      const managedAutomation = {
        questionMode: "orchestrator",
        steeringMode: "passive_review",
        questionTimeoutMs: 120_000,
        reviewIntervalMs: 300_000,
        yoloMode: false,
      } as const;
      const existingAutomation = isRecord((orchestrationSpec as any)?.automation)
        ? ((orchestrationSpec as any).automation as Record<string, any>)
        : {};
      (orchestrationSpec as any).automation = {
        ...managedAutomation,
        ...existingAutomation,
      };
      const created = await api<{ id: string; taskId?: string | null }>("/api/orchestrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(orchestrationSpec),
      });
      if (created?.taskId) {
        // Auto/orchestrator flows are wrapper-first by design.
        await api(`/api/tasks/${encodeURIComponent(created.taskId)}/mode`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "wrap" }),
        }).catch(() => undefined);
      }
      await refresh();
      setTab("workspace");
      if (created?.taskId) setActiveTaskId(created.taskId);
      setActiveSessionId(null);
      setRecommendation(null);
      setCreateMsg({ text: `Launched — ${recommendation.workers?.length ?? "?"} agents starting.`, ok: true });
    } catch (e: any) {
      setCreateMsg({ text: typeof e?.message === "string" ? e.message : "Launch failed.", ok: false });
    } finally { setCreateBusy(null); }
  }, [recommendation, createBusy, createObjective, createProjectPath, defaultWorkspacePath, budget, refresh, autoOrchestratorModel, autoWorkerModels, withShareModeClaudeTrust]);

  const createFromPreset = useCallback(async (preset: PresetDef) => {
    if (createBusy) return;
    const cwd = soloCwd.trim() || defaultWorkspacePath;

    if (preset.kind === "session") {
      const tool = soloTool; // override with user's tool selection for solo
      const profileId = soloProfile || `${tool}.default`;
      const modelOverrides = modelOverridesForTool(tool, soloModel);
      setCreateBusy("session");
      setCreateMsg(null);
      try {
        const created = await api<{ id: string; taskId?: string | null }>("/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tool,
            profileId,
            cwd: cwd || undefined,
            savePreset: true,
            overrides: withShareModeClaudeTrust(tool, modelOverrides),
          }),
        });
        if (features.terminalModeEnabled) {
          await api(`/api/sessions/${encodeURIComponent(created.id)}/mode`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: "terminal" }),
          }).catch(() => undefined);
        }
        await refresh();
        openSession(created.id, created.taskId);
      } catch (e: any) {
        setCreateMsg({ text: typeof e?.message === "string" ? e.message : "Failed to start session.", ok: false });
      } finally { setCreateBusy(null); }
      return;
    }

    if (preset.id === "custom-team") {
      const objective = createObjective.trim();
      const projectPath = createProjectPath.trim() || cwd;
      if (!objective) { setCreateMsg({ text: "Enter an objective above.", ok: false }); return; }
      if (!projectPath) { setCreateMsg({ text: "Enter the project path.", ok: false }); return; }

      const groups = customWorkerGroups
        .map((g) => ({
          ...g,
          role: String(g.role || "").trim(),
          taskTemplate: String(g.taskTemplate || "").trim() || "Help accomplish: {objective}",
          count: Math.max(1, Math.min(CUSTOM_TEAM_MAX_GROUP_COUNT, Math.floor(Number(g.count || 1)))),
          profileId: normalizeProfileIdForTool(g.tool, g.profileId, configProfiles),
        }))
        .filter((g) => g.count > 0);

      const totalWorkers = groups.reduce((n, g) => n + g.count, 0);
      if (totalWorkers < 1) { setCreateMsg({ text: "Add at least one worker.", ok: false }); return; }
      if (totalWorkers > CUSTOM_TEAM_MAX_WORKERS) {
        setCreateMsg({ text: `Custom team exceeds worker cap (${CUSTOM_TEAM_MAX_WORKERS}). Reduce worker counts.`, ok: false });
        return;
      }

      setCreateBusy("orchestration");
      setCreateMsg(null);
      try {
        const orchProfile = normalizeProfileIdForTool(customOrchestratorTool, customOrchestratorProfile, configProfiles);
        const workersPayload: Array<Record<string, any>> = [];
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi]!;
          const baseName = g.role || `worker-${gi + 1}`;
          const taskPromptBase = materializeTaskPrompt(g.taskTemplate, objective);
          for (let wi = 0; wi < g.count; wi++) {
            const name = g.count > 1 ? `${baseName} ${wi + 1}` : baseName;
            workersPayload.push({
              name,
              role: g.role || "worker",
              tool: g.tool,
              profileId: g.profileId,
              taskPrompt: taskPromptBase,
              overrides: withShareModeClaudeTrust(g.tool, modelOverridesForTool(g.tool, g.model)),
            });
          }
        }

        const created = await api<{ id: string; taskId?: string | null }>("/api/orchestrations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `Custom Team: ${objective.slice(0, 60)}`,
            projectPath,
            dispatchMode: "orchestrator-first",
            autoDispatchInitialPrompts: true,
            automation: customTeamAutomationPayload,
            orchestrator: {
              tool: customOrchestratorTool,
              profileId: orchProfile,
              prompt: objective,
              overrides: withShareModeClaudeTrust(customOrchestratorTool, modelOverridesForTool(customOrchestratorTool, customOrchestratorModel)),
            },
            workers: workersPayload,
            harness: { useDefaultPrompts: true },
          }),
        });
        if (created?.id) {
          const syncMode = customTeamAutomationMode === "manual" ? "manual" : "interval";
          await api(`/api/orchestrations/${encodeURIComponent(created.id)}/sync-policy`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mode: syncMode,
              intervalMs: Math.max(30_000, customTeamAutomationPayload.reviewIntervalMs),
              deliverToOrchestrator: true,
              minDeliveryGapMs: Math.max(30_000, Math.floor(customTeamAutomationPayload.reviewIntervalMs / 2)),
            }),
          }).catch(() => undefined);
          await api(`/api/orchestrations/${encodeURIComponent(created.id)}/automation-policy`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...customTeamAutomationPayload,
              runNow: customTeamAutomationMode !== "manual",
              force: customTeamAutomationMode === "autopilot",
            }),
          }).catch(() => undefined);
        }
        if (features.terminalModeEnabled && created?.taskId) {
          await api(`/api/tasks/${encodeURIComponent(created.taskId)}/mode`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: "terminal" }),
          }).catch(() => undefined);
        }
        await refresh();
        setTab("workspace");
        if (created?.taskId) setActiveTaskId(created.taskId);
        setActiveSessionId(null);
        setCreateMsg({ text: `Custom Team started — ${workersPayload.length + 1} agents launched.`, ok: true });
      } catch (e: any) {
        setCreateMsg({ text: typeof e?.message === "string" ? e.message : "Failed to start custom team.", ok: false });
      } finally {
        setCreateBusy(null);
      }
      return;
    }

    // Orchestration preset
    const objective = createObjective.trim();
    const projectPath = createProjectPath.trim() || cwd;
    if (!objective) { setCreateMsg({ text: "Enter an objective above.", ok: false }); return; }
    if (!projectPath) { setCreateMsg({ text: "Enter the project path.", ok: false }); return; }

    setCreateBusy("orchestration");
    setCreateMsg(null);

    const orchPair = preset.agents.map((agent, idx) => ({ agent, idx })).find((x) => x.agent.role === "orchestrator");
    const workerPairs = preset.agents
      .map((agent, idx) => ({ agent, idx }))
      .filter((x) => x.agent.role === "worker");
    if (!orchPair) {
      setCreateMsg({ text: "Preset is missing an orchestrator.", ok: false });
      setCreateBusy(null);
      return;
    }
    const orchAgent = orchPair.agent;
    const orchModelOverride = modelOverridesForTool(orchAgent.tool, manualAgentModels[orchPair.idx] ?? "");

    try {
      const created = await api<{ id: string; taskId?: string | null }>("/api/orchestrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `${preset.name}: ${objective.slice(0, 60)}`,
          projectPath,
          automation: {
            questionMode: "orchestrator",
            steeringMode: "passive_review",
            questionTimeoutMs: 120_000,
            reviewIntervalMs: 300_000,
            yoloMode: false,
          },
          orchestrator: {
            tool: orchAgent.tool,
            profileId: orchAgent.profileId,
            prompt: objective,
            overrides: withShareModeClaudeTrust(orchAgent.tool, orchModelOverride),
          },
          workers: workerPairs.map(({ agent: w, idx }) => ({
            name: w.name,
            tool: w.tool,
            profileId: w.profileId,
            taskPrompt: materializeTaskPrompt(w.taskPrompt || "Help accomplish: {objective}", objective),
            overrides: withShareModeClaudeTrust(w.tool, modelOverridesForTool(w.tool, manualAgentModels[idx] ?? "")),
          })),
          harness: { useDefaultPrompts: true },
        }),
      });
      if (features.terminalModeEnabled && created?.taskId) {
        // Manual groups behave as true mirrored terminals by default.
        await api(`/api/tasks/${encodeURIComponent(created.taskId)}/mode`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "terminal" }),
        }).catch(() => undefined);
      }
      await refresh();
      setTab("workspace");
      if (created?.taskId) setActiveTaskId(created.taskId);
      setActiveSessionId(null);
      setCreateMsg({ text: `${preset.name} started — ${preset.agents.length} agents launched.`, ok: true });
    } catch (e: any) {
      setCreateMsg({ text: typeof e?.message === "string" ? e.message : "Failed to start.", ok: false });
    } finally { setCreateBusy(null); }
  }, [createBusy, createObjective, createProjectPath, soloTool, soloProfile, soloModel, soloCwd, defaultWorkspacePath, refresh, openSession, features.terminalModeEnabled, manualAgentModels, customWorkerGroups, customOrchestratorTool, customOrchestratorProfile, customOrchestratorModel, customTeamAutomationMode, customTeamAutomationPayload, configProfiles, withShareModeClaudeTrust]);

  const customTeamWorkerTotal = useMemo(
    () =>
      customWorkerGroups.reduce((n, g) => {
        const c = Math.max(1, Math.min(CUSTOM_TEAM_MAX_GROUP_COUNT, Math.floor(Number(g.count || 1))));
        return n + c;
      }, 0),
    [customWorkerGroups],
  );
  const customTeamOverLimit = customTeamWorkerTotal > CUSTOM_TEAM_MAX_WORKERS;

  const activeTask = tasks.find(t => t.id === activeTaskId);
  const activeOrchestrationTaskId = useMemo(() => {
    const fromTask = String(activeTask?.id ?? "").trim();
    if (fromTask.startsWith("orch:")) return fromTask;
    const fromSession = String(activeSessionDef?.taskId ?? "").trim();
    if (fromSession.startsWith("orch:")) return fromSession;
    return null;
  }, [activeTask?.id, activeSessionDef?.taskId]);
  const activeOrchestrationId = orchestrationIdFromTaskId(activeOrchestrationTaskId);
  const activeOrchestrationProgress = useMemo(() => {
    if (activeOrchestrationTaskId && orchestrationProgressByTask[activeOrchestrationTaskId]) {
      return orchestrationProgressByTask[activeOrchestrationTaskId];
    }
    const target = String(activeOrchestrationId ?? "").trim();
    if (!target) return null;
    for (const [taskId, item] of Object.entries(orchestrationProgressByTask)) {
      if (taskId === `orch:${target}`) return item;
      if (String(item?.orchestrationId ?? "") === target) return item;
    }
    return null;
  }, [activeOrchestrationId, activeOrchestrationTaskId, orchestrationProgressByTask]);
  const activeOrchestrationWorkers = useMemo(
    () =>
      (Array.isArray(activeOrchestrationProgress?.workers) ? activeOrchestrationProgress?.workers : []).map((w) => ({
        name: String(w?.name ?? "").trim(),
        sessionId: String(w?.sessionId ?? "").trim(),
        running: Boolean(w?.running),
        attention: Number(w?.attention ?? 0),
      })),
    [activeOrchestrationProgress?.workers],
  );
  const activeSessionRunning = activeSessionDef?.running ?? false;
  const inboxCount = inbox.filter(i => i.status === "open").length;

  useEffect(() => {
    if (!activeSessionId || !activeOrchestrationId || showRawTerminal) {
      setShowOrchestrationCommands(false);
    }
  }, [activeSessionId, activeOrchestrationId, showRawTerminal]);

  const onOrchestrationCommandExecuted = useCallback(async () => {
    queueRefresh(120);
    if (activeOrchestrationTaskId) {
      await refreshOrchestrationProgress(activeOrchestrationTaskId);
    }
    if (showRawTerminal) return;
    if (isCodexNative && activeSessionDef?.toolSessionId) {
      void refreshNativeThread(activeSessionDef.toolSessionId);
      return;
    }
    if (activeSessionDef?.tool && activeSessionDef.toolSessionId) {
      void refreshToolSession(activeSessionDef.tool, activeSessionDef.toolSessionId);
    }
  }, [
    queueRefresh,
    activeOrchestrationTaskId,
    refreshOrchestrationProgress,
    showRawTerminal,
    isCodexNative,
    activeSessionDef?.toolSessionId,
    activeSessionDef?.tool,
    refreshNativeThread,
    refreshToolSession,
  ]);

  const renderOrchestrationProgressCard = (task: TaskCard | null | undefined) => {
    if (!task || task.kind !== "orchestrator") return null;
    const progress = orchestrationProgressByTask[task.id];
    if (!progress) {
      return (
        <div className="card">
          <div className="cardHead"><div className="cardTitle">Worker Progress</div></div>
          <div className="cardBody">
            <div className="emptyCardRow">Waiting for worker progress files…</div>
          </div>
        </div>
      );
    }
    return (
      <div className="card">
        <div className="cardHead">
          <div>
            <div className="cardTitle">Worker Progress</div>
            <div className="cardSub mono">{fmtTime(progress.generatedAt)}</div>
          </div>
        </div>
        <div className="cardBody">
          {(() => {
            const startup = isRecord((progress as any).startup) ? ((progress as any).startup as NonNullable<OrchestrationProgressItem["startup"]>) : null;
            if (!startup) return null;
            const state = String(startup.state ?? "running");
            const dispatchMode = String(startup.dispatchMode ?? "worker-first");
            const pendingWorkers = Array.isArray(startup.pendingWorkerNames)
              ? startup.pendingWorkerNames.filter((v) => typeof v === "string" && v.trim())
              : [];
            const pendingCount = Array.isArray(startup.pendingSessionIds) ? startup.pendingSessionIds.length : 0;
            const startupChipClass =
              state === "waiting-first-dispatch"
                ? "orchStartupChipWarn"
                : state === "auto-released"
                  ? "orchStartupChipAuto"
                  : "orchStartupChipOk";
            const startupChipLabel =
              state === "waiting-first-dispatch"
                ? "Waiting for first dispatch"
                : state === "auto-released"
                  ? "Auto-released"
                  : "Workers released";
            const startupLine =
              state === "waiting-first-dispatch"
                ? `${pendingCount} worker${pendingCount === 1 ? "" : "s"} still gated.`
                : dispatchMode === "worker-first"
                  ? "Worker-first mode starts workers automatically."
                  : "Orchestrator-first release is complete.";
            return (
              <div
                className={`orchStartupStrip ${state === "waiting-first-dispatch"
                    ? "orchStartupStripWarn"
                    : state === "auto-released"
                      ? "orchStartupStripAuto"
                      : "orchStartupStripOk"
                  }`}
              >
                <div className="orchStartupTop">
                  <span className={`orchStartupChip mono ${startupChipClass}`}>{startupChipLabel}</span>
                  <span className="orchStartupText">{startupLine}</span>
                </div>
                {state === "waiting-first-dispatch" && pendingWorkers.length > 0 ? (
                  <div className="orchStartupPending mono">Pending: {pendingWorkers.join(", ")}</div>
                ) : null}
              </div>
            );
          })()}
          {(Array.isArray(progress.workers) ? progress.workers : []).map((w) => {
            const total = Number(w.progress?.checklistTotal ?? 0);
            const done = Number(w.progress?.checklistDone ?? 0);
            const ratio = total > 0 ? `${done}/${total}` : "—";
            const rawPreview = String(w.preview ?? w.progress?.preview ?? "");
            const meta = parseProgressPreviewMeta(rawPreview);
            const showMeta = Boolean(progressMetaOpen[w.sessionId]);
            const hasHiddenMeta = Boolean(meta.generatedAt || meta.orchestrationId);
            const activityState = String(w.activity?.state ?? (w.running ? "live" : "idle"));
            const idleAge = fmtIdleAge(Number(w.activity?.idleForMs ?? 0) || null);
            const awaitingOrchestrator =
              Boolean(w.running) &&
              (activityState === "needs_input" || activityState === "waiting_or_done");
            const statusLabel =
              activityState === "needs_input"
                ? "needs input"
                : activityState === "waiting_or_done"
                  ? "waiting/done"
                  : w.running
                    ? "live"
                    : "idle";
            const statusClass =
              activityState === "needs_input"
                ? "dotWarn"
                : activityState === "waiting_or_done"
                  ? "dotWait"
                  : w.running
                    ? "dotOn"
                    : "dotOff";
            return (
              <div key={w.sessionId} className="progressRow">
                <div className="progressRowHead">
                  <div className="progressRowTitle">{w.name}</div>
                  <div className="progressRowMeta">
                    <span className={`dot ${statusClass}`}>{statusLabel}</span>
                    <span className="chip mono">{ratio}</span>
                    {awaitingOrchestrator ? (
                      <span className="progressAwaitBadge mono">Awaiting orchestrator</span>
                    ) : null}
                  </div>
                </div>
                <div className="progressRowSub mono">
                  {w.progress?.found ? (w.progress.relPath || "task.md") : "No task.md yet"}
                  {w.branch ? ` · ${w.branch}` : ""}
                  {idleAge ? ` · idle ${idleAge}` : ""}
                </div>
                {rawPreview ? <div className="progressRowPreview">{meta.cleanText}</div> : null}
                {hasHiddenMeta ? (
                  <>
                    <button
                      className="progressMetaToggle mono"
                      onClick={() =>
                        setProgressMetaOpen((prev) => ({ ...prev, [w.sessionId]: !Boolean(prev[w.sessionId]) }))
                      }
                    >
                      {showMeta ? "Hide meta" : "Show meta"}
                    </button>
                    {showMeta ? (
                      <div className="progressMetaBody mono">
                        {meta.generatedAt ? `Generated: ${meta.generatedAt}` : ""}
                        {meta.generatedAt && meta.orchestrationId ? " · " : ""}
                        {meta.orchestrationId ? `Orchestration ID: ${meta.orchestrationId}` : ""}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── SESSION VIEW (overlays all tabs when session is active) ──
  const renderSessionView = () => {
    if (!activeSessionId) return null;
    const hasToolSess = !!activeSessionDef?.toolSessionId;

    return (
      <div className="sessionView">
        {/* Minimal session bar: back + mode toggle only */}
        <div className="sessionBar">
          <button
            className="sessionBackBtn"
            onClick={() => { setActiveSessionId(null); }}
            aria-label="Back"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>

          <div className="sessionBarMeta">
            {activeSessionDef?.cwd && (
              <span className="sessionCwd">{formatDisplayPathTail(activeSessionDef.cwd, 2)}</span>
            )}
          </div>

          {/* Mode toggle — always show if terminal mode feature enabled, or when toolSessionId exists */}
          {(features.terminalModeEnabled || canWrap) && (
            <div className="sessionModeToggle">
              <button
                className={`sessionModeBtn ${!showRawTerminal ? "sessionModeBtnOn" : ""}`}
                onClick={() => switchMode("wrap")}
                disabled={!canWrap}
                title={!canWrap ? "Chat available once session links to a tool session" : "Chat view"}
              >
                Chat
              </button>
              <button
                className={`sessionModeBtn ${showRawTerminal ? "sessionModeBtnOn" : ""}`}
                onClick={() => switchMode("terminal")}
              >
                Raw
              </button>
            </div>
          )}
          {!showRawTerminal && activeOrchestrationId ? (
            <button
              className={`sessionCommandBtn ${showOrchestrationCommands ? "sessionCommandBtnOn" : ""}`}
              onClick={() => setShowOrchestrationCommands((v) => !v)}
              aria-expanded={showOrchestrationCommands}
            >
              Commands
            </button>
          ) : null}
        </div>

        {/* Content */}
        {showRawTerminal ? (
          <div className="sessionTermWrap">
            {!hasToolSess && activeSessionDef?.taskMode !== "terminal" && (
              <div className="sessionConnecting">
                <div className="sessionConnectingDots"><span /><span /><span /></div>
                <span>Connecting to session…</span>
              </div>
            )}
            <TerminalView session={activeSessionDef || null} />
          </div>
        ) : (
          <div className="sessionChatWrap">
            {activeOrchestrationId ? (
              <OrchestrationCommandPanel
                orchestrationId={activeOrchestrationId}
                open={showOrchestrationCommands}
                onToggle={() => setShowOrchestrationCommands((v) => !v)}
                workers={activeOrchestrationWorkers}
                onExecuted={onOrchestrationCommandExecuted}
              />
            ) : null}
            <WrapperChatView
              session={toolSession}
              messages={displayToolMessages}
              loading={false}
              msg={runMsg}
              running={activeSessionRunning}
              formatPath={formatDisplayPath}
              onRefresh={() => {
                if (isCodexNative && activeSessionDef?.toolSessionId) {
                  void refreshNativeThread(activeSessionDef.toolSessionId);
                  return;
                }
                if (activeSessionDef?.tool && activeSessionDef.toolSessionId) {
                  void refreshToolSession(activeSessionDef.tool, activeSessionDef.toolSessionId);
                }
              }}
              onHistory={() => { }}
            />
          </div>
        )}

        {!showRawTerminal && (
          <div className="compose" style={{ padding: "0 10px 8px" }}>
            <textarea
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              placeholder="Message this session..."
              disabled={sendBusy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendToActiveSession();
                }
              }}
            />
            <button className="composeSend" onClick={() => void sendToActiveSession()} disabled={sendBusy || !composerText.trim()} aria-label="Send">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 2 11 13" />
                <path d="m22 2-7 20-4-9-9-4z" />
              </svg>
            </button>
          </div>
        )}
      </div>
    );
  };

  // ── AUTH SCREENS ──
  if (authed === "unknown") return <ConnectingScreen />;
  if (authed === "no") {
    return (
      <UnlockScreen
        token={token} setToken={setToken}
        pairCode={pairCode} setPairCode={setPairCode}
        pairMsg={pairMsg} unlockMsg={unlockMsg}
        onUnlock={() => {
          setPairMsg(null); setUnlockMsg(null);
          const tok = token.trim();
          if (!tok) { setUnlockMsg("Paste the token from the host terminal."); return; }
          const u = new URL(window.location.href);
          u.searchParams.set("token", tok);
          window.location.href = u.toString();
        }}
        onRetry={() => window.location.reload()}
        onPair={async () => {
          setPairMsg(null); setUnlockMsg(null);
          try {
            await api("/api/auth/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairCode }) });
            window.location.reload();
          } catch (e: any) { setPairMsg(typeof e?.message === "string" ? e.message : "Pair failed."); }
        }}
      />
    );
  }

  // ── MAIN APP ──
  return (
    <div className="app">
      <div className="shell">
        <HeaderBar
          online={true}
          globalWsState={globalWsState}
          activeSession={activeSessionId ? activeSessionDef : null}
          activeSessionRunning={activeSessionRunning}
          onOpenSettings={() => { setActiveSessionId(null); setTab("settings"); }}
        />

        <div className="stage">
          {/* Session view overlays when a session is selected */}
          {activeSessionId ? renderSessionView() : (
            <>
              {/* ── INBOX TAB ── */}
              {tab === "inbox" && (
                <div className="view">
                  {taskActionMsg ? <div className="syncNote">{taskActionMsg}</div> : null}
                  {/* Active task from task detail drill-down */}
                  {activeTaskId && (
                    <div className="taskDetailPanel">
                      <button className="backLink" onClick={() => setActiveTaskId(null)}>
                        ← All tasks
                      </button>
                      <div className="card">
                        <div className="cardHead">
                          <div>
                            <div className="cardTitle">{activeTask?.title || "Task"}</div>
                            <div className="cardSub">{activeTask?.kind} · {activeTask?.status}</div>
                          </div>
                          <div className="cardHeadActions">
                            {activeTask?.runningCount ? <span className="chip chipOn">{activeTask.runningCount} live</span> : null}
                            {activeTask ? (
                              <button
                                className="btn danger btnCompact"
                                onClick={() => void removeTask(activeTask)}
                                disabled={removeBusyKey === `task:${activeTask.id}`}
                              >
                                {removeBusyKey === `task:${activeTask.id}` ? "Removing…" : "Remove"}
                              </button>
                            ) : null}
                          </div>
                        </div>
                        <div className="cardBody">
                          {activeTask?.members?.map(m => (
                            <div key={m.id} className="rowActionWrap">
                              <button className="sessionRow rowActionMain" onClick={() => openSession(m.sessionId, m.taskId)}>
                                <div className="sessionRowLeft">
                                  <div className="sessionRowName">{m.title || m.session?.tool || "Session"}</div>
                                  <div className="sessionRowMeta">{m.mode} mode{m.session?.cwd ? ` · ${formatDisplayPathTail(m.session.cwd, 1)}` : ""}</div>
                                </div>
                                <div className="sessionRowRight">
                                  <span className={`dot ${m.running ? "dotOn" : "dotOff"}`}>{m.running ? "live" : m.role}</span>
                                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                                </div>
                              </button>
                              <button
                                className="rowActionBtn rowActionDanger"
                                onClick={() => void removeSession(m.sessionId)}
                                disabled={removeBusyKey === `session:${m.sessionId}`}
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                      {activeTask?.kind === "orchestrator" && (
                        <div className="card">
                          <div className="cardHead"><div className="cardTitle">Controls</div></div>
                          <div className="cardBody">
                            {syncMsg && <div className="syncNote">{syncMsg}</div>}
                            <div className="btnRow">
                              <button className="btn" onClick={() => {
                                setSyncMsg(null);
                                if (!activeOrchestrationId) {
                                  setSyncMsg("Invalid orchestration id.");
                                  setTimeout(() => setSyncMsg(null), 3000);
                                  return;
                                }
                                api(`/api/orchestrations/${encodeURIComponent(activeOrchestrationId)}/sync`, { method: "POST" })
                                  .then(() => setSyncMsg("Synced."))
                                  .catch(() => setSyncMsg("Sync failed."))
                                  .finally(() => setTimeout(() => setSyncMsg(null), 3000));
                              }}>Sync Workers</button>
                              <button className="btn" onClick={() => {
                                setSyncMsg("Steering dispatched.");
                                if (!activeOrchestrationId) {
                                  setSyncMsg("Invalid orchestration id.");
                                  setTimeout(() => setSyncMsg(null), 3000);
                                  return;
                                }
                                api(`/api/orchestrations/${encodeURIComponent(activeOrchestrationId)}/automation-policy`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ runNow: true }) })
                                  .catch(console.error)
                                  .finally(() => setTimeout(() => setSyncMsg(null), 3000));
                              }}>Steer</button>
                            </div>
                          </div>
                        </div>
                      )}
                      {renderOrchestrationProgressCard(activeTask)}
                    </div>
                  )}

                  {/* Inbox items needing response */}
                  {!activeTaskId && inbox.filter(i => i.status === "open").length > 0 && (
                    <div className="card">
                      <div className="cardHead">
                        <div><div className="cardTitle">Needs Attention</div></div>
                        <span className="chip chipRed">{inboxCount}</span>
                      </div>
                      <div className="cardBody">
                        {inbox.filter(i => i.status === "open").map(item => (
                          <div key={item.id} className="rowActionWrap">
                            <button
                              className="inboxRow rowActionMain"
                              onClick={() => openSession(item.sessionId, item.taskId)}
                              onDoubleClick={() => openSession(item.sessionId, item.taskId)}
                            >
                              <div className="inboxRowIcon">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                                </svg>
                              </div>
                              <div className="inboxRowContent">
                                <div className="inboxRowTitle">{item.title}</div>
                                <div className="inboxRowBody">{item.body || "Tap to view in terminal"}</div>
                                {(() => {
                                  const taskId = String(item.taskId ?? "").trim();
                                  if (!taskId) return null;
                                  const summary = summarizeOrchestrationForInbox(orchestrationProgressByTask[taskId]);
                                  if (!summary) return null;
                                  return (
                                    <>
                                      <div className="inboxRowMeta mono">{summary.line1}</div>
                                      <div className="inboxRowMeta">{summary.line2}</div>
                                    </>
                                  );
                                })()}
                              </div>
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                            </button>
                            <button
                              className="rowActionBtn"
                              onClick={() => void dismissInboxItem(item.id)}
                              disabled={removeBusyKey === `inbox:${item.id}`}
                            >
                              Dismiss
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Running tasks */}
                  {!activeTaskId && (
                    <div className="card">
                      <div className="cardHead">
                        <div>
                          <div className="cardTitle">Active Tasks</div>
                          <div className="cardSub">{tasks.filter(t => t.runningCount > 0).length} running now</div>
                        </div>
                      </div>
                      <div className="cardBody">
                        {tasks.filter(t => t.runningCount > 0).length === 0 ? (
                          <div className="emptyCardRow">
                            {tasks.length === 0 ? "No tasks yet — create one from New." : "Nothing running right now."}
                          </div>
                        ) : tasks.filter(t => t.runningCount > 0).map(t => (
                          <div key={t.id} className="rowActionWrap">
                            <button className="sessionRow rowActionMain" onClick={() => setActiveTaskId(t.id)}>
                              <div className="sessionRowLeft">
                                <div className="sessionRowName">{t.title || "Untitled Task"}</div>
                                <div className="sessionRowMeta">{t.kind} · {t.memberCount} sessions{t.goal ? ` · ${t.goal.slice(0, 60)}` : ""}</div>
                              </div>
                              <div className="sessionRowRight">
                                <span className="dot dotOn">{t.runningCount} live</span>
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                              </div>
                            </button>
                            <button
                              className="rowActionBtn rowActionDanger"
                              onClick={() => void removeTask(t)}
                              disabled={removeBusyKey === `task:${t.id}`}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {!activeTaskId && inbox.length === 0 && tasks.filter(t => t.runningCount > 0).length === 0 && (
                    <div className="emptyFullPage">
                      <div className="emptyFullIcon">✓</div>
                      <div className="emptyFullTitle">All clear</div>
                      <div className="emptyFullSub">No pending actions or active tasks.</div>
                    </div>
                  )}
                </div>
              )}

              {/* ── PROJECTS TAB (workspace) ── */}
              {tab === "workspace" && (
                <div className="view">
                  {taskActionMsg ? <div className="syncNote">{taskActionMsg}</div> : null}
                  {activeTaskId ? (
                    <div className="taskDetailPanel">
                      <button className="backLink" onClick={() => setActiveTaskId(null)}>← All projects</button>
                      <div className="card">
                        <div className="cardHead">
                          <div>
                            <div className="cardTitle">{activeTask?.title || "Task"}</div>
                            <div className="cardSub">{activeTask?.kind} · {activeTask?.status}</div>
                          </div>
                          <div className="cardHeadActions">
                            {activeTask?.runningCount ? <span className="chip chipOn">{activeTask.runningCount} live</span> : null}
                            {activeTask ? (
                              <button
                                className="btn danger btnCompact"
                                onClick={() => void removeTask(activeTask)}
                                disabled={removeBusyKey === `task:${activeTask.id}`}
                              >
                                {removeBusyKey === `task:${activeTask.id}` ? "Removing…" : "Remove"}
                              </button>
                            ) : null}
                          </div>
                        </div>
                        <div className="cardBody">
                          {(!activeTask?.members || activeTask.members.length === 0) && (
                            <div className="emptyCardRow">No sessions in this task.</div>
                          )}
                          {activeTask?.members?.map(m => (
                            <div key={m.id} className="rowActionWrap">
                              <button className="sessionRow rowActionMain" onClick={() => openSession(m.sessionId, m.taskId)}>
                                <div className="sessionRowLeft">
                                  <div className="sessionRowName">{m.title || m.session?.tool || "Session"}</div>
                                  <div className="sessionRowMeta">{m.mode} · {m.role}{m.session?.cwd ? ` · ${formatDisplayPathTail(m.session.cwd, 1)}` : ""}</div>
                                </div>
                                <div className="sessionRowRight">
                                  <span className={`dot ${m.running ? "dotOn" : "dotOff"}`}>{m.running ? "live" : "idle"}</span>
                                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                                </div>
                              </button>
                              <button
                                className="rowActionBtn rowActionDanger"
                                onClick={() => void removeSession(m.sessionId)}
                                disabled={removeBusyKey === `session:${m.sessionId}`}
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                      {renderOrchestrationProgressCard(activeTask)}
                    </div>
                  ) : (
                    <div className="card">
                      <div className="cardHead">
                        <div>
                          <div className="cardTitle">All Projects</div>
                          <div className="cardSub">{tasks.length} tasks total</div>
                        </div>
                      </div>
                      <div className="cardBody">
                        {tasks.length === 0 && (
                          <div className="emptyCardRow">No projects yet. Create one from <strong>New</strong>.</div>
                        )}
                        {tasks.map(t => (
                          <div key={t.id} className="rowActionWrap">
                            <button className="sessionRow rowActionMain" onClick={() => setActiveTaskId(t.id)}>
                              <div className="sessionRowLeft">
                                <div className="sessionRowName">{t.title || "Untitled Task"}</div>
                                <div className="sessionRowMeta">{t.kind} · {t.memberCount} sessions</div>
                              </div>
                              <div className="sessionRowRight">
                                {t.runningCount > 0
                                  ? <span className="dot dotOn">{t.runningCount} live</span>
                                  : <span className="dot dotOff">{t.status}</span>}
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                              </div>
                            </button>
                            <button
                              className="rowActionBtn rowActionDanger"
                              onClick={() => void removeTask(t)}
                              disabled={removeBusyKey === `task:${t.id}`}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── TERMINAL TAB — session picker ── */}
              {tab === "run" && !activeSessionId && (
                <div className="view">
                  {taskActionMsg ? <div className="syncNote">{taskActionMsg}</div> : null}
                  <div className="card">
                    <div className="cardHead">
                      <div><div className="cardTitle">Quick Terminal</div><div className="cardSub">Launch a mirrored CLI session instantly</div></div>
                    </div>
                    <div className="cardBody">
                      <div className="toolToggle">
                        {(["codex", "claude", "opencode"] as ToolId[]).map((t) => (
                          <button key={t} className="toolToggleBtn" onClick={() => void quickLaunchTerminal(t)}>
                            {t}
                          </button>
                        ))}
                      </div>
                      {runLaunchMsg ? <div className="syncNote" style={{ marginTop: 8 }}>{runLaunchMsg}</div> : null}
                    </div>
                  </div>

                  {sessions.filter(s => s.running).length > 0 ? (
                    <div className="card">
                      <div className="cardHead">
                        <div><div className="cardTitle">Running Sessions</div><div className="cardSub">Tap to open</div></div>
                      </div>
                      <div className="cardBody">
                        {sessions.filter(s => s.running).map(s => (
                          <div key={s.id} className="rowActionWrap">
                            <button className="sessionRow rowActionMain" onClick={() => openSession(s.id, s.taskId)}>
                              <div className="sessionRowLeft">
                                <div className="sessionRowName mono">{s.tool}</div>
                                <div className="sessionRowMeta">{s.cwd ? formatDisplayPathTail(s.cwd, 2) : s.profileId}</div>
                              </div>
                              <div className="sessionRowRight">
                                <span className="dot dotOn">live</span>
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                              </div>
                            </button>
                            <button
                              className="rowActionBtn rowActionDanger"
                              onClick={() => void removeSession(s.id)}
                              disabled={removeBusyKey === `session:${s.id}`}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="emptyFullPage">
                      <div className="emptyFullIcon">
                        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                        </svg>
                      </div>
                      <div className="emptyFullTitle">No sessions running</div>
                      <div className="emptyFullSub">Use the 3 quick-launch buttons above to start instantly.</div>
                    </div>
                  )}
                </div>
              )}

              {/* ── NEW TAB ── */}
              {tab === "new" && (
                <div className="view newView">

                  {/* Mode switcher */}
                  <div className="newModeBar">
                    <button className={`newModeBtn ${newMode === "smart" ? "newModeBtnOn" : ""}`} onClick={() => { setNewMode("smart"); setCreateMsg(null); setRecommendation(null); }}>
                      Auto
                    </button>
                    <button className={`newModeBtn ${newMode === "manual" ? "newModeBtnOn" : ""}`} onClick={() => { setNewMode("manual"); setCreateMsg(null); setRecommendation(null); }}>
                      Manual
                    </button>
                  </div>

                  {/* ── SMART MODE ── */}
                  {newMode === "smart" && (
                    <>
                      <div className="newSection">
                        <div className="newSectionLabel">WHAT DO YOU WANT TO BUILD / FIX?</div>
                        <textarea
                          className="newTextarea"
                          rows={4}
                          value={createObjective}
                          onChange={e => { setCreateObjective(e.target.value); setRecommendation(null); }}
                          placeholder={"Fix all TypeScript errors in the server\nAdd dark mode to the web UI\nRefactor the auth system to use JWT refresh tokens"}
                          disabled={!!createBusy}
                        />
                      </div>
                      <div className="newSection">
                        <div className="newSectionLabel">PROJECT PATH</div>
                        <div className="newPathRow">
                          <input
                            className="newInput newPathInput"
                            value={formatDisplayPath(createProjectPath)}
                            onChange={e => setCreateProjectPath(e.target.value)}
                            placeholder={formatDisplayPath(defaultWorkspacePath) || "~/path/to/project"}
                            disabled={!!createBusy}
                          />
                          <button className="btn newPathBrowseBtn" disabled={!!createBusy} onClick={() => openDirectoryPicker("createProjectPath")}>
                            Browse
                          </button>
                        </div>
                      </div>
                      <div className="newSection">
                        <div className="newSectionLabel">BUDGET</div>
                        <div className="toolToggle">
                          {([["low", "Free"], ["balanced", "Claude Code"], ["high", "Custom"]] as const).map(([val, label]) => (
                            <button key={val} className={`toolToggleBtn ${budget === val ? "toolToggleBtnOn" : ""}`} onClick={() => setBudget(val)}>{label}</button>
                          ))}
                        </div>
                      </div>

                      {/* Analyzing state */}
                      {createBusy === "analyzing" && (
                        <div className="analyzeState">
                          <div className="analyzeSpinner" />
                          <div className="analyzeText">
                            <div className="analyzeTitle">Creator is analyzing…</div>
                            <div className="analyzeSub">Scanning workspace, scoring complexity, designing agent plan</div>
                          </div>
                        </div>
                      )}

                      {/* Recommendation result */}
                      {recommendation && !createBusy && (
                        <div className="recommendBox">
                          <div className="recommendHeader">
                            <div className="recommendTitle">Recommendation</div>
                            <div className="recommendConfidence mono">{Math.round((recommendation.confidence ?? 0.8) * 100)}% confident</div>
                          </div>

                          {(recommendation.notes ?? []).length > 0 && (
                            <div className="recommendNotes">
                              {(recommendation.notes as string[]).map((n, i) => (
                                <div key={i} className="recommendNote">· {n}</div>
                              ))}
                            </div>
                          )}

                          <div className="newSectionLabel" style={{ marginTop: 12 }}>ORCHESTRATOR</div>
                          <div className="presetAgent presetAgent--orchestrator">
                            <div className="presetAgentRole mono">ORCH</div>
                            <div className="presetAgentInfo">
                              <div className="presetAgentName">{recommendation.orchestrator?.tool ?? "claude"}</div>
                              <div className="presetAgentLabel">{recommendation.orchestrator?.profileId ?? ""} · coordinates all workers</div>
                            </div>
                          </div>
                          <div className="modelPickerRow">
                            <div className="modelPickerLabel mono">Orchestrator model</div>
                            <select
                              className="newSelect"
                              value={autoOrchestratorModel}
                              onChange={(e) => setAutoOrchestratorModel(e.target.value)}
                            >
                              <option value="">Default profile model</option>
                              {modelOptionsForTool(((recommendation.orchestrator?.tool ?? "codex") as ToolId)).map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </div>

                          <div className="newSectionLabel" style={{ marginTop: 10 }}>WORKERS — {(recommendation.workers ?? []).length}</div>
                          <div className="presetAgentStack">
                            {(recommendation.workers ?? []).map((w: any, i: number) => (
                              <div key={i} className="presetAgent presetAgent--worker">
                                <div className="presetAgentRole mono">W{i + 1}</div>
                                <div className="presetAgentInfo">
                                  <div className="presetAgentName">{w.name}</div>
                                  <div className="presetAgentLabel">{w.role}</div>
                                  <div className="modelPickerRow">
                                    <div className="modelPickerLabel mono">Worker model</div>
                                    <select
                                      className="newSelect"
                                      value={autoWorkerModels[i] ?? ""}
                                      onChange={(e) =>
                                        setAutoWorkerModels((prev) => ({ ...prev, [i]: e.target.value }))
                                      }
                                    >
                                      <option value="">Default profile model</option>
                                      {modelOptionsForTool((String(w?.tool ?? "codex").trim() as ToolId)).map((opt) => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                                <div className="presetAgentTool mono">{w.tool} · {w.profileId}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {createMsg && (
                        <div className={`createFeedback ${createMsg.ok ? "createFeedbackOk" : "createFeedbackError"}`}>
                          {createMsg.text}
                        </div>
                      )}

                      {!recommendation ? (
                        <button className="newLaunchBtn" disabled={!!createBusy} onClick={() => void analyzeGoal()}>
                          {createBusy === "analyzing" ? "Analyzing…" : "Analyze →"}
                        </button>
                      ) : (
                        <button className="newLaunchBtn" disabled={!!createBusy} onClick={() => void launchFromRecommendation()}>
                          {createBusy === "orchestration" ? "Launching…" : `Launch — ${(recommendation.workers ?? []).length + 1} agents`}
                        </button>
                      )}
                    </>
                  )}

                  {/* ── MANUAL MODE ── */}
                  {newMode === "manual" && (
                    <>
                      <div className="newSection">
                        <div className="newSectionLabel">PRESET</div>
                        <div className="presetRow">
                          {PRESETS.map(p => (
                            <button
                              key={p.id}
                              className={`presetCard ${selectedPreset === p.id ? "presetCardOn" : ""}`}
                              onClick={() => { setSelectedPreset(p.id); setCreateMsg(null); }}
                            >
                              <div className="presetCardName">{p.name}</div>
                              <div className="presetCardDesc">{p.desc}</div>
                            </button>
                          ))}
                        </div>
                        <div className="presetDetail">{selectedPresetDef.detail}</div>
                      </div>

                      <div className="newSection">
                        <div className="newSectionLabel">AGENTS</div>
                        {selectedPresetDef.id === "custom-team" ? (
                          <div className="presetAgentStack">
                            <div className="presetAgent presetAgent--orchestrator">
                              <div className="presetAgentRole mono">ORCH</div>
                              <div className="presetAgentInfo">
                                <div className="presetAgentName">Orchestrator</div>
                                <div className="presetAgentLabel">Exactly one coordinator session</div>
                              </div>
                              <div className="presetAgentTool mono">
                                {customOrchestratorTool} · {normalizeProfileIdForTool(customOrchestratorTool, customOrchestratorProfile, configProfiles)}
                              </div>
                            </div>
                            <div className="presetAgent presetAgent--worker">
                              <div className="presetAgentRole mono">WORK</div>
                              <div className="presetAgentInfo">
                                <div className="presetAgentName">{customTeamWorkerTotal} workers</div>
                                <div className="presetAgentLabel">
                                  {customWorkerGroups.length} group{customWorkerGroups.length !== 1 ? "s" : ""} · cap {CUSTOM_TEAM_MAX_WORKERS}
                                </div>
                              </div>
                              <div className="presetAgentTool mono">{customTeamWorkerTotal + 1} total agents</div>
                            </div>
                          </div>
                        ) : (
                          <div className="presetAgentStack">
                            {selectedPresetDef.agents.map((agent, i) => (
                              <div key={i} className={`presetAgent presetAgent--${agent.role}`}>
                                <div className="presetAgentRole mono">{agent.role === "orchestrator" ? "ORCH" : `W${i}`}</div>
                                <div className="presetAgentInfo">
                                  <div className="presetAgentName">{agent.name}</div>
                                  <div className="presetAgentLabel">{agent.label}</div>
                                </div>
                                <div className="presetAgentTool mono">{agent.profileId}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {selectedPresetDef.kind === "session" ? (
                        <>
                          <div className="newSection">
                            <div className="newSectionLabel">TOOL</div>
                            <div className="toolToggle">
                              {(["claude", "codex", "opencode"] as ToolId[]).map(t => (
                                <button key={t} className={`toolToggleBtn ${soloTool === t ? "toolToggleBtnOn" : ""}`}
                                  onClick={() => { setSoloTool(t); setSoloProfile(`${t}.default`); }}>{t}</button>
                              ))}
                            </div>
                          </div>
                          <div className="newSection">
                            <div className="newSectionLabel">MODEL (OPTIONAL)</div>
                            <select className="newSelect" value={soloModel} onChange={(e) => setSoloModel(e.target.value)}>
                              <option value="">Default profile model</option>
                              {modelOptionsForTool(soloTool).map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="newSection">
                            <div className="newSectionLabel">DIRECTORY</div>
                            <div className="newPathRow">
                              <input className="newInput newPathInput" value={formatDisplayPath(soloCwd)} onChange={e => setSoloCwd(e.target.value)} placeholder={formatDisplayPath(defaultWorkspacePath) || "~/path/to/project"} />
                              <button className="btn newPathBrowseBtn" disabled={!!createBusy} onClick={() => openDirectoryPicker("soloCwd")}>
                                Browse
                              </button>
                            </div>
                          </div>
                        </>
                      ) : selectedPresetDef.id === "custom-team" ? (
                        <>
                          <div className="newSection">
                            <div className="newSectionLabel">PROJECT PATH</div>
                            <div className="newPathRow">
                              <input className="newInput newPathInput" value={formatDisplayPath(createProjectPath)} onChange={e => setCreateProjectPath(e.target.value)} placeholder={formatDisplayPath(defaultWorkspacePath) || "~/path/to/project"} />
                              <button className="btn newPathBrowseBtn" disabled={!!createBusy} onClick={() => openDirectoryPicker("createProjectPath")}>
                                Browse
                              </button>
                            </div>
                          </div>
                          <div className="newSection">
                            <div className="newSectionLabel">OBJECTIVE</div>
                            <textarea className="newTextarea" rows={3} value={createObjective} onChange={e => setCreateObjective(e.target.value)} placeholder="What should this custom team accomplish?" />
                          </div>

                          <div className="newSection">
                            <div className="newSectionLabel">ORCHESTRATOR (LOCKED TO 1)</div>
                            <div className="modelPickerRow modelPickerRowCard">
                              <div className="modelPickerLabel mono">Tool</div>
                              <div className="toolToggle">
                                {(["claude", "codex", "opencode"] as ToolId[]).map(t => (
                                  <button
                                    key={t}
                                    className={`toolToggleBtn ${customOrchestratorTool === t ? "toolToggleBtnOn" : ""}`}
                                    onClick={() => setCustomOrchestratorTool(t)}
                                  >
                                    {t}
                                  </button>
                                ))}
                              </div>
                              <div className="modelPickerLabel mono">Profile</div>
                              <select
                                className="newSelect"
                                value={normalizeProfileIdForTool(customOrchestratorTool, customOrchestratorProfile, configProfiles)}
                                onChange={(e) => setCustomOrchestratorProfile(e.target.value)}
                              >
                                {profileOptionsForTool(customOrchestratorTool, configProfiles).map((p) => (
                                  <option key={p.id} value={p.id}>{p.label}</option>
                                ))}
                              </select>
                              <div className="modelPickerLabel mono">Model (optional override)</div>
                              <select className="newSelect" value={customOrchestratorModel} onChange={(e) => setCustomOrchestratorModel(e.target.value)}>
                                <option value="">Default profile model</option>
                                {modelOptionsForTool(customOrchestratorTool).map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            </div>
                          </div>

                          <div className="newSection">
                            <div className="newSectionLabel">AUTOMATION MODE</div>
                            <div className="modelPickerRow modelPickerRowCard">
                              <div className="modelPickerLabel mono">Orchestrator behavior</div>
                              <div className="toolToggle">
                                <button
                                  className={`toolToggleBtn ${customTeamAutomationMode === "manual" ? "toolToggleBtnOn" : ""}`}
                                  onClick={() => setCustomTeamAutomationMode("manual")}
                                >
                                  Manual
                                </button>
                                <button
                                  className={`toolToggleBtn ${customTeamAutomationMode === "guided" ? "toolToggleBtnOn" : ""}`}
                                  onClick={() => setCustomTeamAutomationMode("guided")}
                                >
                                  Guided
                                </button>
                                <button
                                  className={`toolToggleBtn ${customTeamAutomationMode === "autopilot" ? "toolToggleBtnOn" : ""}`}
                                  onClick={() => setCustomTeamAutomationMode("autopilot")}
                                >
                                  Autopilot
                                </button>
                              </div>
                              <div className="presetDetail">
                                {customTeamAutomationMode === "manual"
                                  ? "No auto-answer and no periodic steering."
                                  : customTeamAutomationMode === "guided"
                                    ? "Auto-answer worker questions through orchestrator with passive review."
                                    : "Auto-answer + active steering reviews for faster autonomous flow."}
                              </div>
                              <div className="modelPickerLabel mono">Question timeout</div>
                              <select
                                className="newSelect"
                                value={String(customTeamQuestionTimeoutMs)}
                                onChange={(e) => setCustomTeamQuestionTimeoutMs(Math.max(30_000, Number(e.target.value) || 120_000))}
                              >
                                <option value="60000">60s</option>
                                <option value="120000">120s</option>
                                <option value="180000">180s</option>
                                <option value="300000">300s</option>
                              </select>
                              <div className="modelPickerLabel mono">Review interval</div>
                              <select
                                className="newSelect"
                                value={String(customTeamReviewIntervalMs)}
                                onChange={(e) => setCustomTeamReviewIntervalMs(Math.max(30_000, Number(e.target.value) || 60_000))}
                                disabled={customTeamAutomationMode === "manual"}
                              >
                                <option value="60000">60s</option>
                                <option value="120000">120s</option>
                                <option value="180000">180s</option>
                                <option value="300000">300s</option>
                              </select>
                              <div className="modelPickerLabel mono">Risk policy</div>
                              <div className="toolToggle">
                                <button
                                  className={`toolToggleBtn ${!customTeamYoloMode ? "toolToggleBtnOn" : ""}`}
                                  onClick={() => setCustomTeamYoloMode(false)}
                                >
                                  Safe
                                </button>
                                <button
                                  className={`toolToggleBtn ${customTeamYoloMode ? "toolToggleBtnOn" : ""}`}
                                  onClick={() => setCustomTeamYoloMode(true)}
                                >
                                  YOLO
                                </button>
                              </div>
                            </div>
                          </div>

                          <div className="newSection">
                            <div className="newSectionLabel">WORKER GROUPS</div>
                            <div className="presetAgentStack">
                              {customWorkerGroups.map((group, idx) => {
                                const profileValue = normalizeProfileIdForTool(group.tool, group.profileId, configProfiles);
                                return (
                                  <div key={group.id} className="modelPickerRow modelPickerRowCard">
                                    <div className="modelPickerLabel mono">Group {idx + 1}</div>
                                    <div className="toolToggle">
                                      {(["claude", "codex", "opencode"] as ToolId[]).map((t) => (
                                        <button
                                          key={t}
                                          className={`toolToggleBtn ${group.tool === t ? "toolToggleBtnOn" : ""}`}
                                          onClick={() =>
                                            setCustomWorkerGroups((prev) =>
                                              prev.map((g) =>
                                                g.id === group.id
                                                  ? {
                                                    ...g,
                                                    tool: t,
                                                    profileId: normalizeProfileIdForTool(t, g.profileId, configProfiles),
                                                  }
                                                  : g,
                                              ),
                                            )
                                          }
                                        >
                                          {t}
                                        </button>
                                      ))}
                                    </div>
                                    <div className="modelPickerLabel mono">Profile</div>
                                    <select
                                      className="newSelect"
                                      value={profileValue}
                                      onChange={(e) =>
                                        setCustomWorkerGroups((prev) =>
                                          prev.map((g) => (g.id === group.id ? { ...g, profileId: e.target.value } : g)),
                                        )
                                      }
                                    >
                                      {profileOptionsForTool(group.tool, configProfiles).map((p) => (
                                        <option key={p.id} value={p.id}>{p.label}</option>
                                      ))}
                                    </select>
                                    <div className="modelPickerLabel mono">Role</div>
                                    <input
                                      className="newInput"
                                      value={group.role}
                                      onChange={(e) =>
                                        setCustomWorkerGroups((prev) =>
                                          prev.map((g) => (g.id === group.id ? { ...g, role: e.target.value } : g)),
                                        )
                                      }
                                      placeholder="debug / frontend / backend / tests"
                                    />
                                    <div className="modelPickerLabel mono">Count (1-{CUSTOM_TEAM_MAX_GROUP_COUNT})</div>
                                    <input
                                      type="number"
                                      min={1}
                                      max={CUSTOM_TEAM_MAX_GROUP_COUNT}
                                      className="newInput"
                                      value={group.count}
                                      onChange={(e) =>
                                        setCustomWorkerGroups((prev) =>
                                          prev.map((g) => {
                                            if (g.id !== group.id) return g;
                                            const next = Math.floor(Number(e.target.value || 1));
                                            return { ...g, count: Math.max(1, Math.min(CUSTOM_TEAM_MAX_GROUP_COUNT, next || 1)) };
                                          }),
                                        )
                                      }
                                    />
                                    <div className="modelPickerLabel mono">Model (optional override)</div>
                                    <select
                                      className="newSelect"
                                      value={group.model}
                                      onChange={(e) =>
                                        setCustomWorkerGroups((prev) =>
                                          prev.map((g) => (g.id === group.id ? { ...g, model: e.target.value } : g)),
                                        )
                                      }
                                    >
                                      <option value="">Default profile model</option>
                                      {modelOptionsForTool(group.tool).map((opt) => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                      ))}
                                    </select>
                                    <div className="modelPickerLabel mono">Task template</div>
                                    <textarea
                                      className="newTextarea"
                                      rows={2}
                                      value={group.taskTemplate}
                                      onChange={(e) =>
                                        setCustomWorkerGroups((prev) =>
                                          prev.map((g) => (g.id === group.id ? { ...g, taskTemplate: e.target.value } : g)),
                                        )
                                      }
                                      placeholder="Implement and verify {objective}"
                                    />
                                    <div className="customTeamActions">
                                      <button
                                        className="rowActionBtn"
                                        onClick={() =>
                                          setCustomWorkerGroups((prev) => [
                                            ...prev,
                                            makeCustomWorkerGroup({
                                              tool: group.tool,
                                              profileId: normalizeProfileIdForTool(group.tool, group.profileId, configProfiles),
                                              role: group.role || "worker",
                                              taskTemplate: group.taskTemplate || "Help accomplish: {objective}",
                                            }),
                                          ])
                                        }
                                      >
                                        Add group
                                      </button>
                                      <button
                                        className="rowActionBtn rowActionDanger"
                                        onClick={() =>
                                          setCustomWorkerGroups((prev) =>
                                            prev.length > 1 ? prev.filter((g) => g.id !== group.id) : prev,
                                          )
                                        }
                                        disabled={customWorkerGroups.length <= 1}
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="newSection">
                            <div className="newSectionLabel">PROJECT PATH</div>
                            <div className="newPathRow">
                              <input className="newInput newPathInput" value={formatDisplayPath(createProjectPath)} onChange={e => setCreateProjectPath(e.target.value)} placeholder={formatDisplayPath(defaultWorkspacePath) || "~/path/to/project"} />
                              <button className="btn newPathBrowseBtn" disabled={!!createBusy} onClick={() => openDirectoryPicker("createProjectPath")}>
                                Browse
                              </button>
                            </div>
                          </div>
                          <div className="newSection">
                            <div className="newSectionLabel">OBJECTIVE</div>
                            <textarea className="newTextarea" rows={3} value={createObjective} onChange={e => setCreateObjective(e.target.value)} placeholder="What should the agents accomplish?" />
                          </div>
                          <div className="newSection">
                            <div className="newSectionLabel">MODEL OVERRIDES (OPTIONAL)</div>
                            <div className="presetAgentStack">
                              {selectedPresetDef.agents.map((agent, idx) => (
                                <div key={`model-${idx}`} className="modelPickerRow modelPickerRowCard">
                                  <div className="modelPickerLabel mono">
                                    {agent.role === "orchestrator" ? "Orchestrator" : agent.name}
                                  </div>
                                  <select
                                    className="newSelect"
                                    value={manualAgentModels[idx] ?? ""}
                                    onChange={(e) =>
                                      setManualAgentModels((prev) => ({ ...prev, [idx]: e.target.value }))
                                    }
                                  >
                                    <option value="">Default profile model</option>
                                    {modelOptionsForTool(agent.tool).map((opt) => (
                                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                  </select>
                                </div>
                              ))}
                            </div>
                          </div>
                        </>
                      )}

                      {createMsg && (
                        <div className={`createFeedback ${createMsg.ok ? "createFeedbackOk" : "createFeedbackError"}`}>
                          {createMsg.text}
                        </div>
                      )}

                      {selectedPresetDef.id === "custom-team" && customTeamOverLimit && (
                        <div className="createFeedback createFeedbackError">
                          Worker count exceeds cap ({CUSTOM_TEAM_MAX_WORKERS}). Reduce group counts.
                        </div>
                      )}

                      <button className="newLaunchBtn" disabled={!!createBusy || (selectedPresetDef.id === "custom-team" && customTeamOverLimit)} onClick={() => void createFromPreset(selectedPresetDef)}>
                        {createBusy ? "Launching…" : selectedPresetDef.kind === "orchestration"
                          ? `Launch ${selectedPresetDef.name} — ${selectedPresetDef.id === "custom-team" ? customTeamWorkerTotal + 1 : selectedPresetDef.agents.length} agents`
                          : `Launch ${soloTool}`}
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* ── SETTINGS TAB ── */}
              {tab === "settings" && (
                <div className="view">
                  <button className="backLink" onClick={() => setTab("inbox")}>← Back</button>
                  <div className="card">
                    <div className="cardHead"><div className="cardTitle">Server</div></div>
                    <div className="cardBody">
                      <div className="settingsRow">
                        <span>Version</span>
                        <span className="mono">{doctor?.app?.version || "—"}</span>
                      </div>
                      <div className="settingsRow">
                        <span>Platform</span>
                        <span className="mono">{doctor?.process?.platform || "—"}</span>
                      </div>
                      <div className="settingsRow">
                        <span>Terminal mode</span>
                        <span>{features.terminalModeEnabled ? "enabled" : "disabled"}</span>
                      </div>
                    </div>
                  </div>
                  <div className="card">
                    <div className="cardHead"><div className="cardTitle">Display & Privacy</div></div>
                    <div className="cardBody">
                      <div className="settingsRow settingsRowStack">
                        <div className="settingsCell">
                          <div>Path display mode</div>
                          <div className="settingsHint">Hide `/home/username` or `/Users/username` when sharing screens.</div>
                        </div>
                        <div className="toolToggle toolToggleInline">
                          <button
                            className={`toolToggleBtn ${pathPrivacyMode === "full" ? "toolToggleBtnOn" : ""}`}
                            onClick={() => setPathPrivacyMode("full")}
                          >
                            Full
                          </button>
                          <button
                            className={`toolToggleBtn ${pathPrivacyMode === "share" ? "toolToggleBtnOn" : ""}`}
                            onClick={() => setPathPrivacyMode("share")}
                          >
                            Sharing
                          </button>
                        </div>
                      </div>
                      <div className="settingsRow">
                        <span>Preview</span>
                        <span className="mono settingsPathPreview">
                          {formatDisplayPath(defaultWorkspacePath || doctor?.process?.cwd || "") || "—"}
                        </span>
                      </div>
                      <div className="settingsRow settingsRowStack">
                        <div className="settingsCell">
                          <div>Auto-trust Claude workspace in Sharing mode</div>
                          <div className="settingsHint">
                            Uses Claude `--dangerously-skip-permissions` so the trust prompt does not expose full paths.
                          </div>
                          {!claudeSupportsDangerousSkip ? (
                            <div className="settingsHint settingsHintWarn">
                              This Claude build does not report support for `--dangerously-skip-permissions`.
                            </div>
                          ) : null}
                        </div>
                        <div className="toolToggle toolToggleInline">
                          <button
                            className={`toolToggleBtn ${!claudeAutoTrustShareMode ? "toolToggleBtnOn" : ""}`}
                            onClick={() => setClaudeAutoTrustShareMode(false)}
                          >
                            Off
                          </button>
                          <button
                            className={`toolToggleBtn ${claudeAutoTrustShareMode ? "toolToggleBtnOn" : ""}`}
                            onClick={() => setClaudeAutoTrustShareMode(true)}
                          >
                            On
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="card">
                    <div className="cardHead"><div className="cardTitle">Tools</div></div>
                    <div className="cardBody">
                      {(["claude", "codex", "opencode"] as const).map(t => {
                        const info = doctor?.tools?.[t];
                        if (!info) return null;
                        return (
                          <div key={t} className="settingsRow">
                            <span className="mono">{t}</span>
                            <span className="chip">{info.version || "detected"}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {doctor?.workspaceRoots?.length ? (
                    <div className="card">
                      <div className="cardHead"><div className="cardTitle">Workspace Roots</div></div>
                      <div className="cardBody">
                        {doctor.workspaceRoots.map(r => (
                          <div key={r} className="settingsRow mono" style={{ fontSize: 12 }}>{formatDisplayPath(r)}</div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="card">
                    <div className="cardBody">
                      <button className="btn danger" style={{ width: "100%" }} onClick={() => { setAuthed("no"); setPairCode(""); setToken(""); }}>
                        Disconnect
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Hide nav when session is active (full-screen session view) */}
        {!activeSessionId && (
          <BottomNav
            tab={tab}
            inboxCount={inboxCount}
            onSetTab={t => { setTab(t); setActiveTaskId(null); setActiveSessionId(null); }}
            onOpenInbox={() => { setTab("inbox"); setActiveTaskId(null); setActiveSessionId(null); }}
          />
        )}
      </div>
      <PickerModal
        open={dirPickerOpen}
        path={dirPickerPath}
        parent={dirPickerParent}
        entries={dirPickerEntries}
        showHidden={dirPickerShowHidden}
        busy={dirPickerBusy}
        message={dirPickerMsg}
        formatPath={formatDisplayPath}
        onClose={() => {
          setDirPickerOpen(false);
          setDirPickerMsg(null);
        }}
        onUse={applyPickedDirectory}
        onSetPath={setDirPickerPath}
        onGo={(path) => loadDirectoryPicker(path)}
        onUp={(path) => loadDirectoryPicker(path)}
        onToggleHidden={(next) => toggleDirectoryHidden(next)}
        onCreateFolder={(name, parentPath) => createDirectoryInPicker(name, parentPath)}
      />
    </div>
  );
}
