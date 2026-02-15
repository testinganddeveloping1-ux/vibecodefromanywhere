import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Terminal as XTermTerminal } from "@xterm/xterm";
import type { FitAddon as XTermFitAddon } from "@xterm/addon-fit";

type ToolId = "codex" | "claude" | "opencode";
type TabId = "run" | "workspace" | "inbox" | "new" | "settings";

/* ---- SVG Icon Components ---- */
function IconTerminal() {
  return (
    <svg viewBox="0 0 24 24">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}
function IconFolder() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function IconInbox() {
  return (
    <svg viewBox="0 0 24 24">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg viewBox="0 0 24 24">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg viewBox="0 0 24 24" style={{ width: 18, height: 18, stroke: "var(--muted)", fill: "none", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

type Profile = { id: string; tool: ToolId; title: string; sendSuffix: string };

type SessionRow = {
  id: string;
  tool: ToolId;
  profileId: string;
  toolSessionId?: string | null;
  cwd?: string | null;
  workspaceKey?: string | null;
  workspaceRoot?: string | null;
  treePath?: string | null;
  label?: string | null;
  pinnedSlot?: number | null;
  createdAt?: number;
  updatedAt?: number;
  running?: boolean;
  attention?: number;
  preview?: string | null;
};

type WorktreeInfo = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
};

type WorkspaceItem = {
  key: string;
  root: string;
  isGit: boolean;
  trees: WorktreeInfo[];
  sessions: SessionRow[];
  lastUsed: number;
};

type InboxItem = {
  id: number;
  sessionId: string;
  ts: number;
  status: "open" | "sent" | "resolved" | "dismissed";
  kind: string;
  severity: "info" | "warn" | "danger";
  title: string;
  body: string;
  signature: string;
  options: { id: string; label: string; send: string }[];
  session: SessionRow | null;
};

type ToolSessionTool = "codex" | "claude";
type ToolSessionSummary = {
  tool: ToolSessionTool;
  id: string;
  cwd: string;
  createdAt: number | null;
  updatedAt: number;
  title: string | null;
  preview: string | null;
  messageCount: number | null;
  gitBranch: string | null;
};
type ToolSessionMessage = { role: "user" | "assistant"; ts: number; text: string };

type Doctor = {
  tools: {
    codex: { sandboxModes: string[]; approvalPolicies: string[]; supports: any; version?: string };
    claude: { permissionModes: string[]; supports: any; version?: string };
    opencode: { supports: any; version?: string };
  };
  workspaceRoots: string[];
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...(init ?? {}) });
  if (res.status === 401) throw new Error("unauthorized");
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  const isJson = ct.includes("application/json");
  if (!res.ok) {
    let msg = `http ${res.status}`;
    if (isJson) {
      try {
        const body: any = await res.json();
        if (typeof body?.message === "string" && body.message.trim()) msg = body.message.trim();
        else if (typeof body?.reason === "string" && body.reason.trim())
          msg = `${typeof body?.error === "string" ? body.error : "error"}: ${body.reason.trim()}`;
        else if (typeof body?.error === "string" && body.error.trim()) msg = body.error.trim();
      } catch {
        // ignore
      }
    } else {
      try {
        const text = await res.text();
        if (text.trim()) msg = text.trim().slice(0, 220);
      } catch {
        // ignore
      }
    }
    throw new Error(msg);
  }
  return (isJson ? await res.json() : ((await res.text()) as any)) as T;
}

function dirsFromText(t: string): string[] {
  return t
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ToolChip({ tool }: { tool: ToolId }) {
  return <span className="chip chipOn">{tool}</span>;
}

type EventItem = { id: number; ts: number; kind: string; data: any };
type RecentWorkspace = { path: string; lastUsed: number };

function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack;
  return haystack.split(needle).join(replacement);
}

function formatInputForDisplay(text: any): string {
  const raw = typeof text === "string" ? text : String(text ?? "");
  if (!raw) return "";

  // Pure key presses (common ones)
  if (/^(?:\r\n|\r|\n)+$/.test(raw)) return "[ENTER]";
  if (raw === "\t") return "[TAB]";
  if (raw === "\u001b") return "[ESC]";
  if (raw === "\u001b[Z") return "[SHIFT+TAB]";
  if (raw === "\u001b[A") return "[UP]";
  if (raw === "\u001b[B") return "[DOWN]";
  if (raw === "\u001b[C") return "[RIGHT]";
  if (raw === "\u001b[D") return "[LEFT]";

  // For normal messages, strip trailing CR/LF that we add as send suffix.
  let s = raw.replace(/[\r\n]+$/g, "");

  // Humanize common control sequences so "More" key buttons are visible in the log/history.
  s = replaceAll(s, "\u001b[Z", "[SHIFT+TAB]");
  s = replaceAll(s, "\u001b[A", "[UP]");
  s = replaceAll(s, "\u001b[B", "[DOWN]");
  s = replaceAll(s, "\u001b[C", "[RIGHT]");
  s = replaceAll(s, "\u001b[D", "[LEFT]");
  s = s.replace(/\t/g, "[TAB]");
  s = s.replace(/\u001b/g, "[ESC]");

  // Replace any remaining control chars (keeps UI stable).
  s = s.replace(/[\u0000-\u001f\u007f]/g, (c) => {
    const code = c.charCodeAt(0).toString(16).padStart(2, "0");
    return `[0x${code}]`;
  });

  return s;
}

function normalizeEvent(raw: any): EventItem | null {
  if (!raw || typeof raw.kind !== "string") return null;
  const id = Number.isFinite(Number(raw.id)) ? Number(raw.id) : Number(raw.ts ?? Date.now());
  const ts = Number(raw.ts ?? Date.now());
  return { id, ts, kind: String(raw.kind), data: raw.data ?? {} };
}

function formatEventLine(e: EventItem): string {
  const k = String(e.kind ?? "");
  if (k === "input") return formatInputForDisplay(e.data?.text ?? "");
  if (k === "interrupt" || k === "stop" || k === "kill") return k.toUpperCase();
  if (k === "session.created") return `Started tool=${String(e.data?.tool ?? "")} profile=${String(e.data?.profileId ?? "")} cwd=${String(e.data?.cwd ?? "")}`;
  if (k === "session.exit") return `Exit code=${String(e.data?.exitCode ?? "null")} signal=${String(e.data?.signal ?? "null")}`;
  if (k === "session.meta") {
    const parts: string[] = [];
    if (Object.prototype.hasOwnProperty.call(e.data ?? {}, "label")) parts.push(`label=${JSON.stringify(e.data?.label ?? null)}`);
    if (Object.prototype.hasOwnProperty.call(e.data ?? {}, "pinnedSlot")) parts.push(`slot=${String(e.data?.pinnedSlot ?? null)}`);
    return parts.length ? `Meta ${parts.join(" ")}` : "Meta updated";
  }
  if (k === "session.git") return `Git workspace=${String(e.data?.workspaceKey ?? "")} tree=${String(e.data?.treePath ?? "")}`;
  if (k === "profile.startup") return `Startup macros: ${String(e.data?.profileId ?? "")}`;
  if (k === "profile.startup_failed") return `Startup macros failed: ${String(e.data?.profileId ?? "")}`;
  if (k === "inbox.respond") {
    const send = formatInputForDisplay(e.data?.send ?? "");
    const opt = String(e.data?.optionId ?? "");
    return `Inbox responded option=${opt}${send ? ` send=${send}` : ""}`;
  }
  if (k === "inbox.dismiss") return "Inbox dismissed";
  try {
    return JSON.stringify(e.data ?? {});
  } catch {
    return String(e.data ?? "");
  }
}

function FencedMessage({ text }: { text: string }) {
  const raw = String(text ?? "");
  const parts = raw.split("```");
  if (parts.length <= 1) return <div className="mdText">{raw}</div>;

  return (
    <div className="md">
      {parts.map((p, i) => {
        const isCode = i % 2 === 1;
        if (isCode) {
          const idx = p.indexOf("\n");
          const lang = idx >= 0 ? p.slice(0, idx).trim() : "";
          const code = (idx >= 0 ? p.slice(idx + 1) : p).replace(/\n$/, "");
          return (
            <pre key={i} className="mdCode" data-lang={lang || undefined}>
              <code>{code}</code>
            </pre>
          );
        }
        if (!p) return null;
        return (
          <div key={i} className="mdText">
            {p}
          </div>
        );
      })}
    </div>
  );
}

export function App() {
  const [authed, setAuthed] = useState<"unknown" | "yes" | "no">("unknown");
  const [token, setToken] = useState("");

  const [tab, setTab] = useState<TabId>("workspace");
  const [tools, setTools] = useState<ToolId[]>(["codex", "claude", "opencode"]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [doctor, setDoctor] = useState<Doctor | null>(null);

  const [tool, setTool] = useState<ToolId>("codex");
  const [profileId, setProfileId] = useState<string>("codex.default");
  const [cwd, setCwd] = useState<string>("");
  const [advanced, setAdvanced] = useState(false);

  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<string | null>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem("fyp_ws") : null;
      return raw ? String(raw) : null;
    } catch {
      return null;
    }
  });
  const [selectedTreePath, setSelectedTreePath] = useState<string>(() => {
    try {
      const ws = typeof window !== "undefined" ? window.localStorage.getItem("fyp_ws") : null;
      const mapRaw = typeof window !== "undefined" ? window.localStorage.getItem("fyp_tree_map") : null;
      if (ws && mapRaw) {
        try {
          const m = JSON.parse(mapRaw) as any;
          const v = m && typeof m === "object" ? m[String(ws)] : null;
          if (typeof v === "string") return v;
        } catch {
          // ignore
        }
      }
      // Back-compat fallback (old single-key value).
      const raw = typeof window !== "undefined" ? window.localStorage.getItem("fyp_tree") : null;
      return raw ? String(raw) : "";
    } catch {
      return "";
    }
  });
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [toolSessions, setToolSessions] = useState<ToolSessionSummary[]>([]);
  const [toolSessionsLoading, setToolSessionsLoading] = useState(false);
  const [toolSessionsMsg, setToolSessionsMsg] = useState<string | null>(null);

  const [showToolChat, setShowToolChat] = useState(false);
  const [toolChatSession, setToolChatSession] = useState<ToolSessionSummary | null>(null);
  const [toolChatMessages, setToolChatMessages] = useState<ToolSessionMessage[]>([]);
  const [toolChatLoading, setToolChatLoading] = useState(false);
  const [toolChatMsg, setToolChatMsg] = useState<string | null>(null);

  const [slotCfg, setSlotCfg] = useState<{ slots: 3 | 4 | 6 }>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem("fyp_slots") : null;
      const n = raw ? Number(raw) : 3;
      return { slots: n === 6 ? 6 : n === 4 ? 4 : 3 };
    } catch {
      return { slots: 3 };
    }
  });

  const [codexOpt, setCodexOpt] = useState({
    sandbox: "",
    askForApproval: "",
    fullAuto: false,
    bypassApprovalsAndSandbox: false,
    search: false,
    noAltScreen: true,
    addDirText: "",
  });
  const [claudeOpt, setClaudeOpt] = useState({
    permissionMode: "",
    dangerouslySkipPermissions: false,
    addDirText: "",
  });
  const [opencodeOpt, setOpenCodeOpt] = useState({
    model: "",
    agent: "",
    prompt: "",
    cont: false,
    session: "",
    fork: false,
  });

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeSession = useMemo(
    () => (activeId ? sessions.find((s) => s.id === activeId) ?? null : null),
    [activeId, sessions],
  );
  const activeWorkspaceKey = (activeSession?.workspaceKey ?? selectedWorkspaceKey ?? null) as string | null;
  const pinnedBySlot = useMemo(() => {
    const out: Record<number, SessionRow> = {};
    if (!activeWorkspaceKey) return out;
    for (const s of sessions) {
      const gk = String(s.workspaceKey ?? (s.cwd ? `dir:${s.cwd}` : `dir:${s.id}`));
      if (gk !== activeWorkspaceKey) continue;
      const slot = typeof s.pinnedSlot === "number" ? s.pinnedSlot : null;
      if (!slot || slot < 1 || slot > 6) continue;
      out[slot] = s;
    }
    return out;
  }, [sessions, activeWorkspaceKey]);
  const pinnedOrder = useMemo(() => {
    const ids: string[] = [];
    for (let i = 1; i <= slotCfg.slots; i++) {
      const s = pinnedBySlot[i];
      if (s?.id) ids.push(s.id);
    }
    return ids;
  }, [pinnedBySlot, slotCfg.slots]);
  const [composer, setComposer] = useState("");

  const [showPicker, setShowPicker] = useState(false);
  const [pickPath, setPickPath] = useState<string>("");
  const [pickEntries, setPickEntries] = useState<{ name: string; path: string; kind: string }[]>([]);
  const [pickParent, setPickParent] = useState<string | null>(null);
  const [pickShowHidden, setPickShowHidden] = useState(false);

  const [showConfig, setShowConfig] = useState(false);
  const [configToml, setConfigToml] = useState("");
  const [configMsg, setConfigMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [events, setEvents] = useState<EventItem[]>([]);
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);
  const [workspacePreset, setWorkspacePreset] = useState<{ profileId: string; overrides: any } | null>(null);
  const [presetMsg, setPresetMsg] = useState<string | null>(null);
  const [autoPreset, setAutoPreset] = useState(true);
  const [savePreset, setSavePreset] = useState(true);
  const [pairCode, setPairCode] = useState("");
  const [pairInfo, setPairInfo] = useState<{ code: string; url: string; expiresAt: number } | null>(null);
  const [pairMsg, setPairMsg] = useState<string | null>(null);

  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelProvider, setModelProvider] = useState<string>("opencode");
  const [modelQuery, setModelQuery] = useState<string>("");
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelListMsg, setModelListMsg] = useState<string | null>(null);
  const [modelLoading, setModelLoading] = useState(false);

  const termRef = useRef<HTMLDivElement | null>(null);
  const term = useRef<XTermTerminal | null>(null);
  const fit = useRef<XTermFitAddon | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const termInit = useRef<Promise<void> | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const globalWs = useRef<WebSocket | null>(null);
  const connectedSessionId = useRef<string | null>(null);
  const pendingInputBySession = useRef<Record<string, string[]>>({});
  const selectedWorkspaceKeyRef = useRef<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const tabRef = useRef<TabId>("workspace");
  const authedRef = useRef<"unknown" | "yes" | "no">("unknown");
  const sessionCtl = useRef<{ id: string | null; attempt: number; timer: any; ping: any }>({ id: null, attempt: 0, timer: null, ping: null });
  const globalCtl = useRef<{ attempt: number; timer: any; ping: any }>({ attempt: 0, timer: null, ping: null });

  const [sessionWsState, setSessionWsState] = useState<"closed" | "connecting" | "open">("closed");
  const [globalWsState, setGlobalWsState] = useState<"closed" | "connecting" | "open">("closed");
  const [online, setOnline] = useState<boolean>(() => (typeof navigator !== "undefined" ? navigator.onLine : true));
  const [fontSize, setFontSize] = useState<number>(() => {
    try {
      const v = typeof window !== "undefined" ? window.localStorage.getItem("fyp_font") : null;
      const n = v ? Number(v) : 15;
      return Number.isFinite(n) ? Math.min(22, Math.max(11, n)) : 15;
    } catch {
      return 15;
    }
  });

  const orderedProfiles = useMemo(() => {
    const base = profiles.filter((p) => p.tool === tool);
    const prio: Record<string, number> =
      tool === "codex"
        ? {
            "codex.default": 0,
            "codex.plan": 1,
            "codex.full_auto": 2,
            "codex.danger": 3,
          }
        : tool === "claude"
          ? {
              "claude.default": 0,
              "claude.plan": 1,
              "claude.accept_edits": 2,
              "claude.bypass_plan": 3,
            }
          : {
              "opencode.default": 0,
              "opencode.plan_build": 1,
            };
    return base
      .slice()
      .sort((a, b) => (prio[a.id] ?? 999) - (prio[b.id] ?? 999) || a.title.localeCompare(b.title));
  }, [profiles, tool]);
  const selectedProfile = useMemo(() => profiles.find((p) => p.id === profileId) ?? null, [profiles, profileId]);
  const recentForPicker = useMemo(() => recentWorkspaces.map((r) => r.path).filter(Boolean).slice(0, 8), [recentWorkspaces]);
  const filteredWorkspaces = useMemo(() => {
    const q = workspaceQuery.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter((w) => String(w.root).toLowerCase().includes(q) || String(w.key).toLowerCase().includes(q));
  }, [workspaceQuery, workspaces]);

  async function ensureTerminalReady(): Promise<void> {
    if (term.current && fit.current) return;
    if (termInit.current) return termInit.current;
    termInit.current = (async () => {
      const el = termRef.current;
      if (!el) return;

      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      const el2 = termRef.current;
      if (!el2) return;
      if (term.current) return;

      const t = new Terminal({
        cursorBlink: true,
        fontFamily: "var(--mono)",
        fontSize,
        theme: {
          background: "#060810",
          foreground: "#e4eaf4",
          cursor: "#f5a623",
          selectionBackground: "rgba(245,166,35,.25)",
          selectionForeground: "#eaf0fa",
        },
        scrollback: 8000,
      });
      const f = new FitAddon();
      t.loadAddon(f);
      t.open(el2);
      f.fit();
      term.current = t;
      fit.current = f;

      // Make the terminal interactive: forward keystrokes to the remote PTY.
      t.onData((data) => {
        if (!ws.current || ws.current.readyState !== WebSocket.OPEN || !connectedSessionId.current) return;
        ws.current.send(JSON.stringify({ type: "input", text: data }));
      });

      roRef.current?.disconnect();
      roRef.current = new ResizeObserver(() => {
        fit.current?.fit();
        const cols = term.current?.cols;
        const rows = term.current?.rows;
        if (!cols || !rows || !ws.current || ws.current.readyState !== WebSocket.OPEN || !connectedSessionId.current) return;
        ws.current.send(JSON.stringify({ type: "resize", cols, rows }));
      });
      roRef.current.observe(el2);
    })()
      .catch(() => {
        // ignore; user can re-open Run to retry
      })
      .finally(() => {
        termInit.current = null;
      });
    return termInit.current;
  }

  async function loadWorkspacePreset(pathStr: string, toolId: ToolId) {
    if (!pathStr.trim()) {
      setWorkspacePreset(null);
      return;
    }
    try {
      const r = await api<{ ok: true; preset: any | null }>(
        `/api/workspaces/preset?path=${encodeURIComponent(pathStr)}&tool=${encodeURIComponent(toolId)}`,
      );
      if (r.preset && typeof r.preset.profileId === "string") {
        setWorkspacePreset({ profileId: r.preset.profileId, overrides: r.preset.overrides ?? {} });
      } else {
        setWorkspacePreset(null);
      }
    } catch {
      setWorkspacePreset(null);
    }
  }

  function applyPresetNow(p: { profileId: string; overrides: any }) {
    setPresetMsg(null);
    setProfileId(p.profileId);
    const o = p.overrides ?? {};
    if (tool === "codex" && o.codex) {
      setCodexOpt((prev) => ({
        ...prev,
        sandbox: typeof o.codex.sandbox === "string" ? o.codex.sandbox : prev.sandbox,
        askForApproval: typeof o.codex.askForApproval === "string" ? o.codex.askForApproval : prev.askForApproval,
        fullAuto: typeof o.codex.fullAuto === "boolean" ? o.codex.fullAuto : prev.fullAuto,
        bypassApprovalsAndSandbox:
          typeof o.codex.bypassApprovalsAndSandbox === "boolean" ? o.codex.bypassApprovalsAndSandbox : prev.bypassApprovalsAndSandbox,
        search: typeof o.codex.search === "boolean" ? o.codex.search : prev.search,
        addDirText: Array.isArray(o.codex.addDir) ? o.codex.addDir.join("\n") : prev.addDirText,
      }));
    }
    if (tool === "claude" && o.claude) {
      setClaudeOpt((prev) => ({
        ...prev,
        permissionMode: typeof o.claude.permissionMode === "string" ? o.claude.permissionMode : prev.permissionMode,
        dangerouslySkipPermissions:
          typeof o.claude.dangerouslySkipPermissions === "boolean" ? o.claude.dangerouslySkipPermissions : prev.dangerouslySkipPermissions,
        addDirText: Array.isArray(o.claude.addDir) ? o.claude.addDir.join("\n") : prev.addDirText,
      }));
    }
    if (tool === "opencode" && o.opencode) {
      setOpenCodeOpt((prev) => ({
        ...prev,
        agent: typeof o.opencode.agent === "string" ? o.opencode.agent : prev.agent,
        prompt: typeof o.opencode.prompt === "string" ? o.opencode.prompt : prev.prompt,
        cont: typeof o.opencode.continue === "boolean" ? o.opencode.continue : prev.cont,
        session: typeof o.opencode.session === "string" ? o.opencode.session : prev.session,
        fork: typeof o.opencode.fork === "boolean" ? o.opencode.fork : prev.fork,
      }));
    }
    setPresetMsg("Applied workspace defaults");
  }

  async function refreshSessions() {
    try {
      const rows = await api<SessionRow[]>("/api/sessions");
      setSessions(rows);
      if (rows.length > 0) setActiveId((prev) => prev ?? rows[0]!.id);
    } catch {
      // ignore
    }
  }

  async function refreshRecentWorkspaces() {
    try {
      const r = await api<{ ok: true; items: RecentWorkspace[] }>("/api/workspaces/recent?limit=12");
      setRecentWorkspaces(r.items ?? []);
      const most = String(r.items?.[0]?.path ?? "");
      // Friendly default: if user hasn't typed anything, start from the most recent workspace.
      if (most) setCwd((prev) => (prev.trim() ? prev : most));
    } catch {
      // ignore
    }
  }

  async function refreshWorkspaces() {
    try {
      const r = await api<{ ok: true; items: WorkspaceItem[] }>("/api/workspaces");
      setWorkspaces(r.items ?? []);
      const cur = selectedWorkspaceKeyRef.current ?? selectedWorkspaceKey;
      if (cur && r.items?.some((w) => String(w.key) === String(cur))) return;
      if (r.items?.[0]?.key ?? "") setSelectedWorkspaceKey(String(r.items[0]!.key));
    } catch {
      // ignore
    }
  }

  async function refreshInbox(opts?: { workspaceKey?: string | null; sessionId?: string | null }) {
    const qs = new URLSearchParams();
    if (opts?.workspaceKey) qs.set("workspaceKey", String(opts.workspaceKey));
    if (opts?.sessionId) qs.set("sessionId", String(opts.sessionId));
    try {
      const r = await api<{ ok: true; items: InboxItem[] }>(`/api/inbox?${qs.toString()}`);
      setInbox(r.items ?? []);
    } catch {
      // ignore
    }
  }

  async function refreshToolSessions(opts?: { under?: string; refresh?: boolean }) {
    const under = typeof opts?.under === "string" ? opts.under.trim() : "";
    const refresh = Boolean(opts?.refresh);
    setToolSessionsMsg(null);
    setToolSessionsLoading(true);
    try {
      const qs = new URLSearchParams();
      if (under) qs.set("under", under);
      if (refresh) qs.set("refresh", "1");
      const r = await api<{ ok: true; items: ToolSessionSummary[] }>(`/api/tool-sessions?${qs.toString()}`);
      setToolSessions(Array.isArray(r.items) ? r.items : []);
    } catch (e: any) {
      setToolSessions([]);
      setToolSessionsMsg(typeof e?.message === "string" ? e.message : "failed to load tool sessions");
    } finally {
      setToolSessionsLoading(false);
    }
  }

  useEffect(() => {
    const u = new URL(window.location.href);
    const t = u.searchParams.get("token");
    const pair = u.searchParams.get("pair");
    if (t) {
      u.searchParams.delete("token");
      window.history.replaceState({}, "", u.toString());
    }
    if (pair) {
      u.searchParams.delete("pair");
      window.history.replaceState({}, "", u.toString());
      (async () => {
        try {
          await api("/api/auth/pair/claim", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: pair }),
          });
          window.location.reload();
        } catch {
          setAuthed("no");
        }
      })();
      return;
    }

    (async () => {
      try {
        await api("/api/doctor" + (t ? `?token=${encodeURIComponent(t)}` : ""));
        setAuthed("yes");
      } catch {
        setAuthed("no");
      }
    })();
  }, []);

  useEffect(() => {
    if (authed !== "yes") return;
    (async () => {
      const cfg = await api<{ tools: string[]; profiles: Profile[] }>("/api/config");
      setTools(cfg.tools.filter(Boolean) as ToolId[]);
      setProfiles(cfg.profiles);
      if (cfg.profiles.some((p) => p.id === `${tool}.default`)) setProfileId(`${tool}.default`);
      await refreshSessions();
      await refreshRecentWorkspaces();

      const d = await api<Doctor>("/api/doctor");
      setDoctor(d);

      setCodexOpt((p) => ({
        ...p,
        sandbox: d.tools.codex.sandboxModes?.includes("workspace-write") ? "workspace-write" : (d.tools.codex.sandboxModes?.[0] ?? ""),
        askForApproval: d.tools.codex.approvalPolicies?.includes("on-request") ? "on-request" : (d.tools.codex.approvalPolicies?.[0] ?? ""),
      }));
      setClaudeOpt((p) => ({
        ...p,
        permissionMode: d.tools.claude.permissionModes?.includes("default") ? "default" : (d.tools.claude.permissionModes?.[0] ?? ""),
      }));
    })();
  }, [authed]);

  useEffect(() => {
    if (authed !== "yes") return;
    if (!autoPreset) return;
    const p = cwd.trim();
    if (!p) return;
    const t = setTimeout(() => loadWorkspacePreset(p, tool), 180);
    return () => clearTimeout(t);
  }, [cwd, tool, authed, autoPreset]);

  useEffect(() => {
    selectedWorkspaceKeyRef.current = selectedWorkspaceKey;
  }, [selectedWorkspaceKey]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  useEffect(() => {
    authedRef.current = authed;
  }, [authed]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    try {
      if (selectedWorkspaceKey) window.localStorage.setItem("fyp_ws", selectedWorkspaceKey);
      else window.localStorage.removeItem("fyp_ws");
    } catch {
      // ignore
    }
  }, [selectedWorkspaceKey]);

  useEffect(() => {
    try {
      // Back-compat: store last chosen tree path.
      if (selectedTreePath) window.localStorage.setItem("fyp_tree", selectedTreePath);
      else window.localStorage.removeItem("fyp_tree");

      // Preferred: store per-workspace selection for git workspaces.
      if (!selectedWorkspaceKey || selectedWorkspaceKey.startsWith("dir:")) return;
      const raw = window.localStorage.getItem("fyp_tree_map");
      let m: any = {};
      try {
        m = raw ? JSON.parse(raw) : {};
      } catch {
        m = {};
      }
      if (!m || typeof m !== "object") m = {};
      if (selectedTreePath) m[String(selectedWorkspaceKey)] = selectedTreePath;
      else delete m[String(selectedWorkspaceKey)];
      window.localStorage.setItem("fyp_tree_map", JSON.stringify(m));
    } catch {
      // ignore
    }
  }, [selectedWorkspaceKey, selectedTreePath]);

  useEffect(() => {
    // Keep the selected tree consistent per workspace.
    if (!selectedWorkspaceKey) return;
    const w = workspaces.find((x) => x.key === selectedWorkspaceKey) ?? null;
    if (!w) return;

    if (!w.isGit) {
      if (selectedTreePath) setSelectedTreePath("");
      return;
    }

    let saved = "";
    try {
      const raw = window.localStorage.getItem("fyp_tree_map");
      if (raw) {
        const m = JSON.parse(raw) as any;
        const v = m && typeof m === "object" ? m[String(selectedWorkspaceKey)] : null;
        if (typeof v === "string") saved = v;
      }
    } catch {
      // ignore
    }

    const allowed = new Set<string>([String(w.root || ""), ...(w.trees ?? []).map((t) => String(t.path || "")).filter(Boolean)]);
    let desired = saved || String(w.root || "");
    if (desired && !allowed.has(desired)) desired = String(w.root || "");
    if (desired && desired !== selectedTreePath) setSelectedTreePath(desired);
  }, [selectedWorkspaceKey, workspaces]);

  useEffect(() => {
    if (authed !== "yes") return;
    let stopped = false;

    function backoffMs(attempt: number): number {
      const base = 140;
      const cap = 6000;
      const exp = Math.min(7, Math.max(0, attempt));
      const ms = Math.min(cap, base * Math.pow(2, exp));
      const jitter = Math.floor(Math.random() * 200);
      return ms + jitter;
    }

    function startPing(sock: WebSocket) {
      return setInterval(() => {
        try {
          if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        } catch {
          // ignore
        }
      }, 15000);
    }

    function cleanup() {
      if (globalCtl.current.timer) clearTimeout(globalCtl.current.timer);
      globalCtl.current.timer = null;
      if (globalCtl.current.ping) clearInterval(globalCtl.current.ping);
      globalCtl.current.ping = null;
      try {
        globalWs.current?.close();
      } catch {
        // ignore
      }
      globalWs.current = null;
      setGlobalWsState("closed");
    }

    function connect(attempt = 0) {
      if (stopped) return;
      if (globalCtl.current.timer) clearTimeout(globalCtl.current.timer);
      globalCtl.current.timer = null;
      if (globalCtl.current.ping) clearInterval(globalCtl.current.ping);
      globalCtl.current.ping = null;

      setGlobalWsState(attempt === 0 ? "connecting" : "connecting");
      globalCtl.current.attempt = attempt;

      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const s = new WebSocket(`${proto}://${window.location.host}/ws/global`);
      globalWs.current = s;

      s.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg?.type === "pong") return;
          if (msg?.type === "sessions.changed") refreshSessions();
          if (msg?.type === "workspaces.changed") {
            refreshRecentWorkspaces();
            refreshWorkspaces();
          }
          if (msg?.type === "inbox.changed") {
            refreshInbox({ workspaceKey: selectedWorkspaceKeyRef.current });
            refreshSessions();
            refreshWorkspaces();
          }
          if (msg?.type === "session.preview" && typeof msg.sessionId === "string" && typeof msg.line === "string") {
            const sid = msg.sessionId;
            const line = msg.line;
            setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, preview: line } : s)));
            setWorkspaces((prev) =>
              prev.map((w) => ({
                ...w,
                sessions: (w.sessions ?? []).map((s) => (s.id === sid ? { ...s, preview: line } : s)),
              })),
            );
          }
        } catch {
          // ignore
        }
      };

      s.onopen = () => {
        if (stopped) {
          try {
            s.close();
          } catch {
            // ignore
          }
          return;
        }
        globalCtl.current.attempt = 0;
        setGlobalWsState("open");
        globalCtl.current.ping = startPing(s);
        // Immediately sync once.
        refreshSessions();
        refreshRecentWorkspaces();
        refreshWorkspaces();
        refreshInbox({ workspaceKey: selectedWorkspaceKeyRef.current });
      };

      s.onerror = () => {
        try {
          s.close();
        } catch {
          // ignore
        }
      };

      s.onclose = () => {
        if (globalWs.current === s) globalWs.current = null;
        if (globalCtl.current.ping) clearInterval(globalCtl.current.ping);
        globalCtl.current.ping = null;
        setGlobalWsState("closed");
        if (stopped) return;
        const nextAttempt = Math.min(9, (globalCtl.current.attempt ?? 0) + 1);
        globalCtl.current.attempt = nextAttempt;
        const delay = backoffMs(nextAttempt);
        setGlobalWsState("connecting");
        globalCtl.current.timer = setTimeout(() => connect(nextAttempt), delay);
      };
    }

    cleanup();
    connect(0);
    return () => {
      stopped = true;
      cleanup();
    };
  }, [authed]);

  useEffect(() => {
    if (authed !== "yes") return;
    refreshInbox({ workspaceKey: selectedWorkspaceKey });
  }, [selectedWorkspaceKey, authed]);

  useEffect(() => {
    if (authed !== "yes") return;
    const w = selectedWorkspaceKey ? workspaces.find((x) => x.key === selectedWorkspaceKey) ?? null : null;
    const under = String(w?.root ?? "").trim();
    if (!under) {
      setToolSessions([]);
      return;
    }
    const t = setTimeout(() => refreshToolSessions({ under }), 160);
    return () => clearTimeout(t);
  }, [selectedWorkspaceKey, workspaces, authed]);

  useEffect(() => {
    try {
      window.localStorage.setItem("fyp_slots", String(slotCfg.slots));
    } catch {
      // ignore
    }
  }, [slotCfg]);

  useEffect(() => {
    return () => {
      roRef.current?.disconnect();
      roRef.current = null;
      term.current?.dispose();
      term.current = null;
      fit.current = null;
    };
  }, []);

  useEffect(() => {
    if (tab !== "run") return;
    (async () => {
      try {
        await ensureTerminalReady();
        setTimeout(() => fit.current?.fit(), 20);
      } catch {
        // ignore
      }
    })();
  }, [tab]);

  useEffect(() => {
    if (!term.current) return;
    term.current.options.fontSize = fontSize;
    try {
      window.localStorage.setItem("fyp_font", String(fontSize));
    } catch {
      // ignore
    }
    setTimeout(() => fit.current?.fit(), 10);
  }, [fontSize]);

  useEffect(() => {
    if (tab !== "run") return;
    setTimeout(() => fit.current?.fit(), 50);
  }, [tab, activeId]);

  useEffect(() => {
    if (tab !== "run") return;
    if (!activeId) return;
    let cancelled = false;
    const id = activeId;
    (async () => {
      try {
        await ensureTerminalReady();
        if (cancelled) return;
        if (connectedSessionId.current === id && ws.current && ws.current.readyState === WebSocket.OPEN) return;
        setEvents([]);
        connectWs(id);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, activeId]);

  useEffect(() => {
    // Swipe left/right on the terminal area to switch pinned sessions.
    // This keeps the UI fast and uncluttered on mobile.
    if (tab !== "run") return;
    const el = termRef.current;
    if (!el) return;
    let startX = 0;
    let startY = 0;
    let active = false;
    const onDown = (e: PointerEvent) => {
      term.current?.focus();
      if (e.pointerType === "mouse") return;
      active = true;
      startX = e.clientX;
      startY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.2) return;

      if (!activeId) return;
      if (pinnedOrder.length < 2) return;
      const idx = pinnedOrder.indexOf(activeId);
      if (idx < 0) return;
      const dir = dx < 0 ? 1 : -1;
      const next = (idx + dir + pinnedOrder.length) % pinnedOrder.length;
      const id = pinnedOrder[next];
      if (id) openSession(id);
    };
    el.addEventListener("pointerdown", onDown, { passive: true });
    el.addEventListener("pointerup", onUp, { passive: true });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [tab, activeId, pinnedOrder, slotCfg]);

  function backoffMs(attempt: number): number {
    const base = 140;
    const cap = 6000;
    const exp = Math.min(7, Math.max(0, attempt));
    const ms = Math.min(cap, base * Math.pow(2, exp));
    const jitter = Math.floor(Math.random() * 200);
    return ms + jitter;
  }

  function ingestEventRaw(raw: any) {
    const ev2 = normalizeEvent(raw);
    if (!ev2) return;
    setEvents((prev) => {
      // de-dupe by event id (ws replay + http fallback can overlap)
      if (prev.some((p) => p.id === ev2.id)) return prev;
      const next = [...prev, ev2];
      return next.length > 400 ? next.slice(next.length - 400) : next;
    });
  }

  function startPing(sock: WebSocket) {
    return setInterval(() => {
      try {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      } catch {
        // ignore
      }
    }, 15000);
  }

  function connectWs(id: string, attempt = 0) {
    // Stop any pending reconnect loop for the previous connection.
    if (sessionCtl.current.timer) clearTimeout(sessionCtl.current.timer);
    sessionCtl.current.timer = null;
    if (sessionCtl.current.ping) clearInterval(sessionCtl.current.ping);
    sessionCtl.current.ping = null;

    sessionCtl.current.id = id;
    sessionCtl.current.attempt = attempt;
    setSessionWsState("connecting");

    try {
      ws.current?.close();
    } catch {
      // ignore
    }
    ws.current = null;

    connectedSessionId.current = id;
    term.current?.reset();
    term.current?.write("\u001b[2J\u001b[H");

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const s = new WebSocket(`${proto}://${window.location.host}/ws/sessions/${id}`);
    ws.current = s;

    s.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg?.type === "pong") return;
        if (msg.type === "output" && typeof msg.chunk === "string") term.current?.write(msg.chunk);
        if (msg.type === "event") {
          const raw = msg.event ?? msg; // back-compat
          ingestEventRaw(raw);
        }
      } catch {
        // ignore
      }
    };

    s.onopen = () => {
      // If the user switched sessions before this connection opened, abort.
      if (activeIdRef.current !== id) {
        try {
          s.close();
        } catch {
          // ignore
        }
        return;
      }
      sessionCtl.current.attempt = 0;
      setSessionWsState("open");
      sessionCtl.current.ping = startPing(s);

      fit.current?.fit();
      const cols = term.current?.cols;
      const rows = term.current?.rows;
      if (cols && rows) s.send(JSON.stringify({ type: "resize", cols, rows }));
      const queued = pendingInputBySession.current[id];
      if (Array.isArray(queued) && queued.length > 0) {
        for (const text of queued) s.send(JSON.stringify({ type: "input", text }));
        delete pendingInputBySession.current[id];
      }
    };

    s.onerror = () => {
      try {
        s.close();
      } catch {
        // ignore
      }
    };

    s.onclose = () => {
      if (ws.current === s) ws.current = null;
      if (connectedSessionId.current === id) connectedSessionId.current = null;
      if (sessionCtl.current.ping) clearInterval(sessionCtl.current.ping);
      sessionCtl.current.ping = null;

      const stillWanted = tabRef.current === "run" && activeIdRef.current === id && authedRef.current === "yes";
      if (!stillWanted) {
        setSessionWsState("closed");
        return;
      }

      const nextAttempt = Math.min(9, attempt + 1);
      sessionCtl.current.attempt = nextAttempt;
      const delay = backoffMs(nextAttempt);
      setSessionWsState("connecting");
      sessionCtl.current.timer = setTimeout(() => connectWs(id, nextAttempt), delay);
    };
  }

  function openSession(id: string) {
    setActiveId(id);
    const sess = sessions.find((s) => s.id === id) ?? null;
    if (sess) {
      const gk = String(sess.workspaceKey ?? (sess.cwd ? `dir:${sess.cwd}` : `dir:${sess.id}`));
      if (gk) {
        selectedWorkspaceKeyRef.current = gk;
        setSelectedWorkspaceKey(gk);
      }
    }
    setEvents([]);
    setTab("run");
  }

  async function sendControl(type: "interrupt" | "stop" | "kill") {
    if (!activeId) {
      setToast("No active session");
      return;
    }

    // Prefer websocket (lowest latency, updates stream immediately).
    if (ws.current && ws.current.readyState === WebSocket.OPEN && connectedSessionId.current === activeId) {
      ws.current.send(JSON.stringify({ type }));
      setToast(`${type} sent`);
      return;
    }

    // Fallback to HTTP so controls still work during reconnects.
    try {
      const r: any = await api(`/api/sessions/${encodeURIComponent(activeId)}/${type}`, { method: "POST" });
      if (r?.event && activeIdRef.current === activeId) ingestEventRaw(r.event);
      setToast(`${type} sent`);
    } catch (e: any) {
      setToast(typeof e?.message === "string" ? e.message : "Not connected");
    }
  }

  async function sendRaw(text: string) {
    if (!activeId) {
      setToast("No active session");
      return;
    }

    if (ws.current && ws.current.readyState === WebSocket.OPEN && connectedSessionId.current === activeId) {
      ws.current.send(JSON.stringify({ type: "input", text }));
      return;
    }

    try {
      const r: any = await api(`/api/sessions/${encodeURIComponent(activeId)}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (r?.event && activeIdRef.current === activeId) ingestEventRaw(r.event);
      setToast("Sent");
    } catch (e: any) {
      setToast(typeof e?.message === "string" ? e.message : "Not connected");
    }
  }

  async function sendText() {
    const text = composer.trimEnd();
    if (!text) return;
    if (!activeId) {
      setToast("No active session");
      return;
    }
    const suffix = (() => {
      const pid = activeSession?.profileId ?? "";
      const p = pid ? profiles.find((x) => x.id === pid) ?? null : null;
      return typeof p?.sendSuffix === "string" ? p.sendSuffix : "\r";
    })();
    const full = text + suffix;

    if (ws.current && ws.current.readyState === WebSocket.OPEN && connectedSessionId.current === activeId) {
      ws.current.send(JSON.stringify({ type: "input", text: full }));
      setToast("Sent");
      setComposer("");
      return;
    }

    // HTTP fallback for reliability (works even if the session socket is reconnecting).
    try {
      const r: any = await api(`/api/sessions/${encodeURIComponent(activeId)}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: full }),
      });
      if (r?.event && activeIdRef.current === activeId) ingestEventRaw(r.event);
      setToast("Sent");
      setComposer("");
      return;
    } catch {
      // If the host is unreachable (offline), keep the message and send once the socket reconnects.
      const q = pendingInputBySession.current[activeId] ?? [];
      q.push(full);
      pendingInputBySession.current[activeId] = q;
      setToast(!online ? "Queued (offline)" : "Queued (reconnecting...)");
      setComposer("");
    }
  }

  async function startSessionWith(input: { tool: ToolId; profileId: string; cwd?: string; overrides?: any; savePreset?: boolean; toolAction?: "resume" | "fork"; toolSessionId?: string }) {
    try {
      const res = await api<{ id: string }>("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: input.tool,
          profileId: input.profileId,
          cwd: input.cwd,
          toolAction: input.toolAction,
          toolSessionId: input.toolSessionId,
          overrides: input.overrides ?? {},
          savePreset: typeof input.savePreset === "boolean" ? input.savePreset : false,
        }),
      });
      setToast("Session started");
      await refreshSessions();
      await refreshRecentWorkspaces();
      await refreshWorkspaces();
      openSession(res.id);
    } catch (e: any) {
      setToast(typeof e?.message === "string" ? e.message : "failed to create session");
    }
  }

  async function createSession() {
    const overrides: any = {};
    if (tool === "codex") {
      overrides.codex = {
        sandbox: codexOpt.sandbox || undefined,
        askForApproval: codexOpt.askForApproval || undefined,
        fullAuto: codexOpt.fullAuto,
        bypassApprovalsAndSandbox: codexOpt.bypassApprovalsAndSandbox,
        search: codexOpt.search,
        noAltScreen: codexOpt.noAltScreen,
        addDir: dirsFromText(codexOpt.addDirText),
      };
    }
    if (tool === "claude") {
      overrides.claude = {
        permissionMode: claudeOpt.permissionMode || undefined,
        dangerouslySkipPermissions: claudeOpt.dangerouslySkipPermissions,
        addDir: dirsFromText(claudeOpt.addDirText),
      };
    }
    if (tool === "opencode") {
      overrides.opencode = {
        model: opencodeOpt.model || undefined,
        agent: opencodeOpt.agent || undefined,
        prompt: opencodeOpt.prompt || undefined,
        continue: opencodeOpt.cont,
        session: opencodeOpt.session || undefined,
        fork: opencodeOpt.fork,
      };
    }
    await startSessionWith({
      tool,
      profileId,
      cwd: cwd.trim() ? cwd.trim() : undefined,
      overrides,
      savePreset,
    });
  }

  async function loadOpenCodeModels(opts?: { provider?: string; refresh?: boolean }) {
    setModelListMsg(null);
    setModelLoading(true);
    try {
      const qs = new URLSearchParams();
      const provider = typeof opts?.provider === "string" ? opts.provider.trim() : "";
      const refresh = Boolean(opts?.refresh);
      if (provider) qs.set("provider", provider);
      if (refresh) qs.set("refresh", "1");
      const r = await api<{ ok: boolean; items: string[]; cached?: boolean }>("/api/opencode/models" + (qs.toString() ? `?${qs}` : ""));
      setModelList(Array.isArray((r as any)?.items) ? (r as any).items.map((s: any) => String(s)).filter(Boolean) : []);
    } catch (e: any) {
      setModelList([]);
      setModelListMsg(typeof e?.message === "string" ? e.message : "failed to load models");
    } finally {
      setModelLoading(false);
    }
  }

  async function respondInbox(attentionId: number, optionId: string) {
    const sid = inbox.find((x) => x.id === attentionId)?.sessionId ?? null;
    try {
      const r: any = await api(`/api/inbox/${attentionId}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionId }),
      });
      if (r?.event && sid && activeIdRef.current === sid) ingestEventRaw(r.event);
      await refreshInbox({ workspaceKey: selectedWorkspaceKey });
    } catch (e: any) {
      setToast(typeof e?.message === "string" ? e.message : "failed to respond");
    }
  }

  async function dismissInbox(attentionId: number) {
    const sid = inbox.find((x) => x.id === attentionId)?.sessionId ?? null;
    try {
      const r: any = await api(`/api/inbox/${attentionId}/dismiss`, { method: "POST" });
      if (r?.event && sid && activeIdRef.current === sid) ingestEventRaw(r.event);
      await refreshInbox({ workspaceKey: selectedWorkspaceKey });
    } catch {
      setToast("dismiss failed");
    }
  }

  async function openToolChat(tool: ToolSessionTool, sessionId: string, opts?: { refresh?: boolean }) {
    setToolChatMsg(null);
    setToolChatLoading(true);
    setToolChatMessages([]);
    setToolChatSession(null);
    setShowToolChat(true);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", "240");
      if (opts?.refresh) qs.set("refresh", "1");
      const r = await api<{ ok: true; session: ToolSessionSummary; messages: ToolSessionMessage[] }>(
        `/api/tool-sessions/${encodeURIComponent(tool)}/${encodeURIComponent(sessionId)}/messages?${qs.toString()}`,
      );
      setToolChatSession(r.session ?? null);
      setToolChatMessages(Array.isArray(r.messages) ? r.messages : []);
    } catch (e: any) {
      setToolChatMsg(typeof e?.message === "string" ? e.message : "failed to load chat history");
    } finally {
      setToolChatLoading(false);
    }
  }

  async function startFromToolSession(ts: ToolSessionSummary, action: "resume" | "fork") {
    try {
      // Prefer per-workspace defaults (tool-native settings and approvals) if present.
      let pid = `${ts.tool}.default`;
      let overrides: any = {};
      try {
        const pr = await api<{ ok: true; preset: any | null }>(
          `/api/workspaces/preset?path=${encodeURIComponent(ts.cwd)}&tool=${encodeURIComponent(ts.tool)}`,
        );
        if (pr?.preset && typeof pr.preset.profileId === "string") {
          pid = pr.preset.profileId;
          overrides = pr.preset.overrides ?? {};
        }
      } catch {
        // ignore
      }
      await startSessionWith({
        tool: ts.tool as any,
        profileId: pid,
        cwd: ts.cwd,
        overrides,
        savePreset: false,
        toolAction: action,
        toolSessionId: ts.id,
      });
    } catch (e: any) {
      setToast(typeof e?.message === "string" ? e.message : "failed to start session");
    }
  }

  async function setSessionMeta(sessionId: string, patch: { label?: string | null; pinnedSlot?: number | null }) {
    const r: any = await api(`/api/sessions/${encodeURIComponent(sessionId)}/meta`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (r?.event && activeIdRef.current === sessionId) ingestEventRaw(r.event);
  }

  async function togglePin(sessionId: string) {
    const sess = sessions.find((s) => s.id === sessionId) ?? null;
    if (!sess) return;
    const groupKey = String(sess.workspaceKey ?? `dir:${sess.cwd ?? sessionId}`);
    const current = typeof sess.pinnedSlot === "number" ? sess.pinnedSlot : null;

    // Unpin
    if (current && current >= 1 && current <= 6) {
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, pinnedSlot: null } : s)));
      try {
        await setSessionMeta(sessionId, { pinnedSlot: null });
        setToast("Unpinned");
      } catch (e: any) {
        setToast(typeof e?.message === "string" ? e.message : "unpin failed");
        refreshSessions();
        refreshWorkspaces();
      }
      return;
    }

    // Pick a slot (first free in visible slots; else replace last visible).
    const used = new Set<number>();
    for (const s of sessions) {
      const g = String(s.workspaceKey ?? `dir:${s.cwd ?? s.id}`);
      if (g !== groupKey) continue;
      const ps = typeof s.pinnedSlot === "number" ? s.pinnedSlot : null;
      if (ps && ps >= 1 && ps <= 6) used.add(ps);
    }
    let chosen: number = slotCfg.slots;
    for (let i = 1; i <= slotCfg.slots; i++) {
      if (!used.has(i)) {
        chosen = i;
        break;
      }
    }

    // Optimistic: clear any other session in this group already in this slot.
    setSessions((prev) =>
      prev.map((s) => {
        const g = String(s.workspaceKey ?? `dir:${s.cwd ?? s.id}`);
        if (g !== groupKey) return s;
        if (s.id === sessionId) return { ...s, pinnedSlot: chosen };
        if (s.pinnedSlot === chosen) return { ...s, pinnedSlot: null };
        return s;
      }),
    );
    try {
      await setSessionMeta(sessionId, { pinnedSlot: chosen });
      setToast(`Pinned to slot ${chosen}`);
    } catch (e: any) {
      setToast(typeof e?.message === "string" ? e.message : "pin failed");
      refreshSessions();
      refreshWorkspaces();
    }
  }

  function renderPinnedBar() {
    const slots = slotCfg.slots;
    return (
      <div className="pinBar">
        {Array.from({ length: slots }).map((_, idx) => {
          const slot = idx + 1;
          const s = pinnedBySlot[slot] ?? null;
          const on = s?.id && s.id === activeId;
          return (
            <div
              key={slot}
              className={`pinSlot ${on ? "pinOn" : ""} ${s ? "pinFilled" : "pinEmpty"}`}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (s?.id) openSession(s.id);
                else setTab("workspace");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (s?.id) openSession(s.id);
                  else setTab("workspace");
                }
              }}
              aria-label={s?.id ? `Pinned session ${slot}` : `Empty slot ${slot}`}
            >
              <div className="pinTop">
                <span className="pinIdx mono">{slot}</span>
                {s ? <span className="chip chipOn">{s.tool}</span> : <span className="chip">empty</span>}
                <div className="spacer" />
                {s ? (
                  <button
                    className="pinX"
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePin(s.id);
                    }}
                  >
                    Unpin
                  </button>
                ) : null}
	              </div>
	              <div className="pinMain mono">{s ? (s.label ? s.label : s.profileId) : "Tap to open Workspace"}</div>
	              {s?.attention && s.attention > 0 ? (
	                <div className="pinBadgeRow">
	                  <span className="badge">{s.attention} waiting</span>
	                </div>
	              ) : null}
	              {s?.preview ? <div className="pinSub mono">{s.preview}</div> : null}
	            </div>
	          );
	        })}
      </div>
    );
  }

  async function loadPicker(pathStr?: string, opts?: { showHidden?: boolean }) {
    const p = pathStr ?? pickPath ?? "";
    const showHidden = typeof opts?.showHidden === "boolean" ? opts.showHidden : pickShowHidden;
    const qs = new URLSearchParams();
    if (p) qs.set("path", p);
    if (showHidden) qs.set("showHidden", "1");
    const r = await api<{ dir: string; parent: string | null; entries: { name: string; path: string; kind: string }[] }>(
      "/api/fs/list?" + qs.toString(),
    );
    setPickPath(r.dir);
    setPickParent(r.parent);
    setPickEntries(r.entries);
  }

  async function openConfig() {
    setConfigMsg(null);
    setShowConfig(true);
    try {
      const r = await api<{ toml: string }>("/api/config/raw");
      setConfigToml(r.toml);
    } catch (e: any) {
      setConfigMsg(typeof e?.message === "string" ? e.message : "failed to load config");
    }
  }

  async function saveConfig() {
    setConfigMsg(null);
    try {
      await api("/api/config/raw", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toml: configToml }),
      });
      setConfigMsg("Saved. Profiles update live; tool command changes may require a restart.");
      const cfg = await api<{ tools: string[]; profiles: Profile[] }>("/api/config");
      setProfiles(cfg.profiles);
    } catch (e: any) {
      setConfigMsg(typeof e?.message === "string" ? e.message : "save failed");
    }
  }

  async function rescanDoctor() {
    try {
      await api("/api/doctor/rescan", { method: "POST" });
      const d2 = await api<Doctor>("/api/doctor");
      setDoctor(d2);
      setToast("Rescanned tool capabilities");
    } catch {
      setToast("Rescan failed");
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!showControls) return;
    setLabelDraft(activeSession?.label ?? "");
  }, [showControls, activeId]);

  const codexCaps = doctor?.tools.codex;
  const claudeCaps = doctor?.tools.claude;
  const opencodeCaps = doctor?.tools.opencode as any;
  const activeInboxItems = activeId ? inbox.filter((x) => x.sessionId === activeId) : [];
  const activeInboxCount = activeInboxItems.length;
  const workspaceInboxCount = inbox.length;
  const activeAttention = activeInboxItems[0] ?? null;

  const modelProviders = useMemo(() => {
    const set = new Set<string>();
    for (const m of modelList) {
      const s = String(m || "");
      const idx = s.indexOf("/");
      if (idx > 0) set.add(s.slice(0, idx));
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [modelList]);

  const filteredModels = useMemo(() => {
    const prov = String(modelProvider || "").trim();
    const q = String(modelQuery || "").trim().toLowerCase();
    let items = modelList;
    if (prov) items = items.filter((m) => String(m).startsWith(prov + "/"));
    if (q) items = items.filter((m) => String(m).toLowerCase().includes(q));
    return items;
  }, [modelList, modelProvider, modelQuery]);

  if (authed === "unknown") return (
    <div className="login">
      <div style={{ textAlign: "center" }}>
        <div className="logo" style={{ width: 48, height: 48, fontSize: 14, margin: "0 auto 12px" }}>FYP</div>
        <div className="muted" style={{ fontSize: 13 }}>Connecting...</div>
      </div>
    </div>
  );

  if (authed === "no") {
    return (
      <div className="login">
        <div className="loginCard">
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <div className="logo" style={{ width: 38, height: 38, fontSize: 12 }}>FYP</div>
            <div className="loginTitle">FromYourPhone</div>
          </div>
          <div className="loginSub">Scan the QR code or paste the token from the host terminal.</div>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="token..."
            autoCapitalize="none"
            autoCorrect="off"
          />
          <div className="loginActions">
            <button
              className="btn primary"
              onClick={() => {
                const u = new URL(window.location.href);
                u.searchParams.set("token", token.trim());
                window.location.href = u.toString();
              }}
            >
              Unlock
            </button>
            <button className="btn" onClick={() => window.location.reload()}>
              Retry
            </button>
          </div>
          <div className="loginHint">Or pair with a short code (from Settings on an already-auth’d device).</div>
          <div className="loginActions" style={{ marginTop: 10 }}>
            <input
              value={pairCode}
              onChange={(e) => setPairCode(e.target.value)}
              placeholder="pair code (8 chars)"
              autoCapitalize="characters"
              autoCorrect="off"
            />
            <button
              className="btn"
              onClick={async () => {
                setPairMsg(null);
                try {
                  await api("/api/auth/pair/claim", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ code: pairCode }),
                  });
                  window.location.reload();
                } catch (e: any) {
                  setPairMsg(typeof e?.message === "string" ? e.message : "pair failed");
                }
              }}
            >
              Pair
            </button>
          </div>
          {pairMsg ? <div className="loginHint">{pairMsg}</div> : null}
          <div className="loginHint">Token is stored as an httpOnly cookie after first use.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="hdr">
        <div className="hdrLeft">
          <div className="logo">FYP</div>
          <div className="hdrText">
            <div className="hdrTitle">FromYourPhone</div>
            <div className="hdrMeta">
              <span className={`chip ${online && globalWsState === "open" ? "chipOn" : ""}`}>
                {!online ? "offline" : globalWsState === "open" ? "live" : globalWsState === "connecting" ? "reconnecting" : "disconnected"}
              </span>
              {activeSession ? (
                <span className="chip mono" style={{ fontSize: 10 }}>{activeSession.tool}</span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="hdrRight">
          <button className="btn ghost" onClick={() => setTab("settings")} aria-label="Settings" style={{ padding: "8px 10px" }}>
            <IconSettings />
          </button>
        </div>
      </header>

      <main className="stage">
        <section className="viewRun" hidden={tab !== "run"} aria-hidden={tab !== "run"}>
          {!activeId ? (
            <div className="empty">
              <div className="emptyTitle">No active session</div>
              <div className="emptySub">Start a new session to see the terminal here.</div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                <button className="btn primary" onClick={() => setTab("new")}>
                  New Session
                </button>
                <button className="btn ghost" onClick={() => setTab("workspace")}>
                  Projects
                </button>
              </div>
            </div>
          ) : (
            <div className="run">
              {renderPinnedBar()}
              <div className="runBar">
                <div className="runInfo">
                  <div className={`dot ${activeSession?.running ? "dotOn" : "dotOff"}`}>
                    {activeSession?.running ? "RUN" : "IDLE"}
                  </div>
                  <span className="mono" style={{ fontSize: 12, color: "var(--ink2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                    {activeSession?.label || activeSession?.profileId || ""}
                  </span>
                  {activeInboxCount > 0 ? (
                    <button className="btn primary" style={{ padding: "4px 10px", minHeight: 28, fontSize: 11 }} onClick={() => { refreshInbox({ workspaceKey: activeWorkspaceKey }); setTab("inbox"); }}>
                      {activeInboxCount} pending
                    </button>
                  ) : null}
                </div>
                <div className="runBtns">
                  <button className="btn" onClick={() => sendControl("interrupt")}>Int</button>
                  <button className="btn ghost" onClick={() => setShowLog(true)}>Log</button>
                  <button
                    className="btn ghost"
                    onClick={() => {
                      const t = activeSession?.tool ?? null;
                      const sid = String(activeSession?.toolSessionId ?? "");
                      if ((t !== "codex" && t !== "claude") || !sid) {
                        setToast("Chat history not linked yet");
                        return;
                      }
                      openToolChat(t, sid);
                    }}
                  >
                    Chat
                  </button>
                  <button className="btn ghost" onClick={() => setShowControls(true)}>More</button>
                </div>
              </div>

              {activeAttention ? (
                <div className={`attentionCard attention${activeAttention.severity}`}>
                  <div className="attentionHead">
                    <span className="chip">{activeAttention.severity}</span>
                    <span className="mono attentionTitle">{activeAttention.title}</span>
                    <div className="spacer" />
                    <button className="btn ghost" onClick={() => setTab("inbox")}>
                      All ({workspaceInboxCount})
                    </button>
                  </div>
                  <div className="attentionBody mono">{activeAttention.body}</div>
                  <div className="attentionActions">
                    {(activeAttention.options ?? []).map((o) => (
                      <button
                        key={o.id}
                        className={o.id === "n" || o.id === "esc" || o.id === "c" ? "btn" : "btn primary"}
                        onClick={() => respondInbox(activeAttention.id, o.id)}
                      >
                        {o.label}
                      </button>
                    ))}
                    <button className="btn ghost" onClick={() => dismissInbox(activeAttention.id)}>
                      Dismiss
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="termPanel">
                <div className="term" ref={termRef} />
              </div>

              {events.length ? (
                <div className="historyBar">
                  <button className="btn ghost" onClick={() => setShowLog(true)}>
                    History
                  </button>
                  <div className="historyScroll">
                    {events
                      .filter(
                        (e) =>
                          e.kind === "input" ||
                          e.kind === "interrupt" ||
                          e.kind === "stop" ||
                          e.kind === "kill" ||
                          e.kind === "inbox.respond" ||
                          e.kind === "inbox.dismiss",
                      )
                      .slice(-8)
                      .map((e) => (
                        <div key={e.id} className={`historyItem ${e.kind === "input" ? "historyInput" : "historyAction"}`}>
                          <span className="mono">
                            {e.kind === "input"
                              ? formatInputForDisplay(e.data?.text ?? "").slice(0, 44)
                              : e.kind === "inbox.respond"
                                ? `INBOX:${String(e.data?.optionId ?? "").slice(0, 6) || "OK"}`
                                : e.kind === "inbox.dismiss"
                                  ? "INBOX:DISMISS"
                                  : e.kind.toUpperCase()}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}

              <div className="compose">
                <textarea
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  placeholder="Message... (Enter to send, Shift+Enter for newline)"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendText();
                    }
                  }}
                />
                <button className="btn primary" onClick={sendText}>
                  Send
                </button>
              </div>
            </div>
          )}
        </section>

        {tab === "workspace" ? (
          <section className="view">
            <div className="card">
              <div className="cardHead">
                <div>
                  <div className="cardTitle">Projects</div>
                  <div className="cardSub">Your workspaces and active sessions.</div>
                </div>
                <button className="btn ghost" onClick={refreshWorkspaces}>
                  Refresh
                </button>
              </div>
              <div className="row">
                <div className="field">
                  <label>Find Workspace</label>
                  <input
                    value={workspaceQuery}
                    onChange={(e) => setWorkspaceQuery(e.target.value)}
                    placeholder="Search paths..."
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                  <div className="help">Tap a workspace to open its trees + sessions below.</div>
                </div>
              </div>
              <div className="row" style={{ padding: 0 }}>
                <div className="list">
                  {filteredWorkspaces.length === 0 ? (
                    <div className="row">
                      <div className="help">No matching workspaces yet. Start a session in New.</div>
                    </div>
                  ) : null}
                  {filteredWorkspaces.map((w) => {
                    const waiting = (w.sessions ?? []).reduce((acc, s) => acc + (s.attention ?? 0), 0);
                    const on = selectedWorkspaceKey === w.key;
                    return (
                      <button
                        key={w.key}
                        type="button"
                        className={`listRow ${on ? "listRowOn" : ""}`}
                        onClick={() => setSelectedWorkspaceKey(w.key)}
                      >
                        <div className="listLeft">
                          <span className={`chip ${w.isGit ? "chipOn" : ""}`}>{w.isGit ? "git" : "dir"}</span>
                          <div className="listText">
                            <div className="listTitle mono">{w.root}</div>
                            <div className="listSub mono">
                              {(w.sessions ?? []).length} sessions{waiting ? ` · ${waiting} waiting` : ""}
                            </div>
                          </div>
                        </div>
                        <div className="listRight">{on ? "open" : ""}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="row">
                <div className="help mono">{selectedWorkspaceKey ?? ""}</div>
              </div>
              {(() => {
	                const w = selectedWorkspaceKey ? workspaces.find((x) => x.key === selectedWorkspaceKey) ?? null : null;
	                if (!w) return <div className="row"><div className="help">Pick a workspace to see sessions and worktrees.</div></div>;
	                const trees = (w.trees ?? []).filter((t) => t.path);
	                return (
	                  <>
                    {w.isGit ? (
                      <div className="row">
                        <div className="field">
                          <label>Git Trees (Worktrees)</label>
                          <select value={selectedTreePath || w.root} onChange={(e) => setSelectedTreePath(e.target.value)}>
                            <option value={w.root}>Main: {w.root}</option>
                            {trees
                              .filter((t) => t.path !== w.root)
                              .map((t) => (
                                <option key={t.path} value={t.path}>
                                  {t.branch ? t.branch.replace(/^refs\/heads\//, "") : t.detached ? "(detached)" : ""} {t.path}
                                </option>
                              ))}
                          </select>
                          <div className="help">New sessions start in the selected tree path.</div>
                        </div>
                      </div>
                    ) : null}

	                    <div className="row">
	                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
	                        <button
	                          className="btn primary"
	                          onClick={() => {
	                            const base = selectedTreePath || w.root || "";
	                            if (base) {
	                              setCwd(base);
	                              setTab("new");
	                              setToast("Workspace loaded into New Session");
	                            }
	                          }}
	                        >
	                          New Session Here
	                        </button>
	                        <button className="btn" onClick={() => setTab("inbox")}>
	                          Inbox
	                        </button>
	                      </div>
	                    </div>

                      {(() => {
                        const base = selectedTreePath || w.root || "";
                        const have = new Set(profiles.map((p) => p.id));
                        if (!base) return null;
                        const toolProfiles: { tool: ToolId; profiles: { id: string; label: string; danger?: boolean }[] }[] = [];
                        if (tools.includes("codex")) {
                          const p: { id: string; label: string; danger?: boolean }[] = [];
                          if (have.has("codex.default")) p.push({ id: "codex.default", label: "Normal" });
                          if (have.has("codex.plan")) p.push({ id: "codex.plan", label: "Plan" });
                          if (have.has("codex.full_auto")) p.push({ id: "codex.full_auto", label: "Auto" });
                          if (have.has("codex.danger")) p.push({ id: "codex.danger", label: "Danger", danger: true });
                          if (p.length) toolProfiles.push({ tool: "codex", profiles: p });
                        }
                        if (tools.includes("claude")) {
                          const p: { id: string; label: string; danger?: boolean }[] = [];
                          if (have.has("claude.default")) p.push({ id: "claude.default", label: "Normal" });
                          if (have.has("claude.plan")) p.push({ id: "claude.plan", label: "Plan" });
                          if (have.has("claude.accept_edits")) p.push({ id: "claude.accept_edits", label: "Accept Edits" });
                          if (have.has("claude.bypass_plan")) p.push({ id: "claude.bypass_plan", label: "Bypass", danger: true });
                          if (p.length) toolProfiles.push({ tool: "claude", profiles: p });
                        }
                        if (tools.includes("opencode")) {
                          const p: { id: string; label: string; danger?: boolean }[] = [];
                          if (have.has("opencode.default")) p.push({ id: "opencode.default", label: "Normal" });
                          if (have.has("opencode.plan_build")) p.push({ id: "opencode.plan_build", label: "Plan+Build" });
                          if (p.length) toolProfiles.push({ tool: "opencode", profiles: p });
                        }
                        if (!toolProfiles.length) return null;
                        return (
                          <div className="quickStartSection">
                            <div className="quickStartLabel">Quick Start</div>
                            {toolProfiles.map((tp) => (
                              <div key={tp.tool}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                                  <span className="chip chipOn" style={{ fontSize: 10 }}>{tp.tool}</span>
                                </div>
                                <div className="quickStartGroup">
                                  {tp.profiles.map((p) => (
                                    <button
                                      key={p.id}
                                      className={p.danger ? "btn danger" : "btn"}
                                      onClick={() => startSessionWith({ tool: tp.tool, profileId: p.id, cwd: base, savePreset: false })}
                                    >
                                      {p.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}

	                    <div className="row" style={{ padding: 0 }}>
	                      <div className="list">
	                        {(() => {
	                          const map = new Map<string, SessionRow[]>();
	                          for (const s of w.sessions ?? []) {
	                            const k = String(s.treePath || s.cwd || w.root || "unknown");
	                            const arr = map.get(k) ?? [];
	                            arr.push(s);
	                            map.set(k, arr);
	                          }
	                          const groups = Array.from(map.entries())
	                            .map(([k, sess]) => ({
	                              key: k,
	                              last: Math.max(0, ...sess.map((s) => Number(s.updatedAt ?? 0))),
	                              sessions: sess.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0)),
	                            }))
	                            .sort((a, b) => b.last - a.last);

	                          const labelForTree = (treePath: string): string => {
	                            if (!w.isGit) return "dir";
	                            if (treePath === w.root) return "main";
	                            const wt = trees.find((t) => t.path === treePath) ?? null;
	                            if (wt?.branch) return wt.branch.replace(/^refs\/heads\//, "");
	                            if (wt?.detached) return "detached";
	                            return "tree";
	                          };

	                          return groups.map((g) => (
	                            <div key={g.key}>
	                              <div className="groupHdr">
	                                <span className="chip">{labelForTree(g.key)}</span>
	                                <span className="mono groupPath">{g.key}</span>
	                              </div>
	                              {g.sessions.map((s) => {
	                                const isPinned =
	                                  typeof s.pinnedSlot === "number" && Number.isFinite(s.pinnedSlot) && s.pinnedSlot >= 1 && s.pinnedSlot <= 6;
	                                return (
	                                  <div
	                                    key={s.id}
	                                    className="listRow listRowDiv"
	                                    role="button"
	                                    tabIndex={0}
	                                    onClick={() => openSession(s.id)}
	                                    onKeyDown={(e) => {
	                                      if (e.key === "Enter" || e.key === " ") {
	                                        e.preventDefault();
	                                        openSession(s.id);
	                                      }
	                                    }}
	                                  >
	                                    <div className="listLeft">
	                                      <ToolChip tool={s.tool} />
	                                      <div className="listText">
	                                        <div className="listTitle">
	                                          {s.label ? s.label : s.profileId}
	                                          {isPinned ? <span className="badge badgePin">#{s.pinnedSlot}</span> : null}
	                                          {s.attention && s.attention > 0 ? <span className="badge">{s.attention}</span> : null}
	                                        </div>
	                                        <div className="listSub mono">
	                                          {s.running ? "RUNNING" : "STOPPED"} {s.id ? `· ${s.id}` : ""}
	                                        </div>
	                                        {s.preview ? <div className="preview mono">{s.preview}</div> : null}
	                                      </div>
	                                    </div>
	                                    <div className="listRight">
	                                      <button
	                                        className={`btn ${isPinned ? "" : "ghost"}`}
	                                        onClick={(e) => {
	                                          e.stopPropagation();
	                                          togglePin(s.id);
	                                        }}
	                                      >
	                                        {isPinned ? `Unpin` : `Pin`}
	                                      </button>
	                                    </div>
	                                  </div>
	                                );
	                              })}
	                            </div>
	                          ));
	                        })()}
	                      </div>
	                    </div>

                      {(() => {
                        const wsRoot = String(w.root || "").trim();
                        const items = Array.isArray(toolSessions) ? toolSessions : [];

                        const isUnder = (p: string, root: string): boolean => {
                          const r = root.replace(/\/+$/g, "");
                          return p === r || p.startsWith(r + "/");
                        };

                        const treeRoots = [String(w.root || ""), ...trees.map((t) => String(t.path || "")).filter(Boolean)]
                          .map((s) => s.replace(/\/+$/g, ""))
                          .filter(Boolean);

                        const pickTreeRoot = (p: string): string => {
                          if (!w.isGit) return wsRoot || p;
                          let best = wsRoot || (treeRoots[0] ?? p);
                          for (const r of treeRoots) {
                            if (!r) continue;
                            if (isUnder(p, r) && r.length >= best.length) best = r;
                          }
                          return best || p;
                        };

                        const map = new Map<string, ToolSessionSummary[]>();
                        for (const ts of items) {
                          if (!ts?.cwd) continue;
                          if (wsRoot && !isUnder(ts.cwd, wsRoot)) continue;
                          const k = pickTreeRoot(String(ts.cwd));
                          const arr = map.get(k) ?? [];
                          arr.push(ts);
                          map.set(k, arr);
                        }

                        const groups = Array.from(map.entries())
                          .map(([k, sess]) => ({
                            key: k,
                            last: Math.max(0, ...sess.map((s) => Number(s.updatedAt ?? 0))),
                            sessions: sess.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0)),
                          }))
                          .sort((a, b) => b.last - a.last);

                        const labelForTree = (treePath: string): string => {
                          if (!w.isGit) return "dir";
                          if (treePath === w.root) return "main";
                          const wt = trees.find((t) => t.path === treePath) ?? null;
                          if (wt?.branch) return wt.branch.replace(/^refs\/heads\//, "");
                          if (wt?.detached) return "detached";
                          return "tree";
                        };

                        return (
                          <>
                            <div className="row" style={{ marginTop: 8 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}>
                                <div className="cardTitle" style={{ margin: 0 }}>Tool Sessions</div>
                                <div className="spacer" />
                                <button className="btn ghost" onClick={() => refreshToolSessions({ under: wsRoot, refresh: true })}>
                                  Refresh
                                </button>
                              </div>
                              <div className="help">Chat history stored by Codex and Claude on this host. Tap to view, or resume in a live terminal.</div>
                              {toolSessionsMsg ? <div className="help mono">{toolSessionsMsg}</div> : null}
                            </div>

                            <div className="row" style={{ padding: 0 }}>
                              <div className="list">
                                {toolSessionsLoading ? (
                                  <div className="row">
                                    <div className="help">Loading tool sessions...</div>
                                  </div>
                                ) : groups.length === 0 ? (
                                  <div className="row">
                                    <div className="help">No stored tool sessions found in this workspace yet.</div>
                                  </div>
                                ) : null}

                                {groups.map((g) => (
                                  <div key={g.key}>
                                    <div className="groupHdr">
                                      <span className="chip">{labelForTree(g.key)}</span>
                                      <span className="mono groupPath">{g.key}</span>
                                    </div>
                                    {g.sessions.map((ts) => (
                                      <div
                                        key={ts.id}
                                        className="listRow listRowDiv"
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => openToolChat(ts.tool, ts.id)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            openToolChat(ts.tool, ts.id);
                                          }
                                        }}
                                      >
                                        <div className="listLeft">
                                          <ToolChip tool={ts.tool as any} />
                                          <div className="listText">
                                            <div className="listTitle">
                                              {ts.title ? ts.title : ts.gitBranch ? ts.gitBranch : ts.id.slice(0, 8)}
                                              {typeof ts.messageCount === "number" ? <span className="badge">{ts.messageCount}</span> : null}
                                            </div>
                                            <div className="listSub mono">
                                              {ts.gitBranch ? `${ts.gitBranch} · ` : ""}
                                              {new Date(ts.updatedAt).toLocaleString()} · {ts.id.slice(0, 8)}
                                            </div>
                                            {ts.preview ? <div className="preview mono">{ts.preview}</div> : null}
                                          </div>
                                        </div>
                                        <div className="listRight">
                                          <button
                                            className="btn primary"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              startFromToolSession(ts, "resume");
                                            }}
                                          >
                                            Resume
                                          </button>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </>
                        );
                      })()}
	                  </>
	                );
	              })()}
            </div>
          </section>
        ) : null}

        {tab === "inbox" ? (
          <section className="view">
            <div className="card">
              <div className="cardHead">
                <div>
                  <div className="cardTitle">Inbox</div>
                  <div className="cardSub">Approvals and questions that need your touch.</div>
                </div>
                <button className="btn" onClick={() => refreshInbox({ workspaceKey: selectedWorkspaceKey })}>
                  Refresh
                </button>
              </div>
              <div className="row">
                <div className="help">Showing open items {selectedWorkspaceKey ? "for this workspace" : "(all)"}.</div>
              </div>
              <div className="row" style={{ padding: 0 }}>
                <div className="list">
                  {inbox.length === 0 ? (
                    <div className="row">
                      <div className="help">Nothing waiting. If Codex is running, approvals will appear here.</div>
                    </div>
                  ) : null}
                  {inbox.map((it) => (
                    <div key={it.id} className={`inboxItem inbox${it.severity}`}>
                      <div className="inboxHead">
                        <span className="chip">{it.severity}</span>
                        <span className="mono inboxTitle">{it.title}</span>
                        <div className="spacer" />
                        <button className="btn ghost" onClick={() => dismissInbox(it.id)}>
                          Dismiss
                        </button>
                      </div>
                      <div className="inboxBody mono">{it.body}</div>
                      <div className="inboxMeta mono">
                        {it.session?.tool ? `${it.session.tool} · ` : ""}
                        {it.session?.profileId ? `${it.session.profileId} · ` : ""}
                        {it.sessionId}
                      </div>
                      <div className="inboxActions">
                        {(it.options ?? []).map((o) => (
                          <button key={o.id} className={o.id === "n" ? "btn" : "btn primary"} onClick={() => respondInbox(it.id, o.id)}>
                            {o.label}
                          </button>
                        ))}
                        <button
                          className="btn"
                          onClick={() => {
                            openSession(it.sessionId);
                            setToast("Opened session");
                          }}
                        >
                          Open Session
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {tab === "new" ? (
          <section className="view">
            <div className="card">
              <div className="cardHead">
                <div>
                  <div className="cardTitle">New Session</div>
                  <div className="cardSub">Pick a tool, profile, and workspace to begin.</div>
                </div>
                <button className="btn ghost" onClick={() => setAdvanced((v) => !v)}>
                  {advanced ? "Hide Options" : "Options"}
                </button>
              </div>

              <div className="row">
                <div className="seg">
                  {tools.map((t) => (
                    <button
                      key={t}
                      className={`segBtn ${tool === t ? "segOn" : ""}`}
                      onClick={() => {
                        setTool(t);
                        setProfileId(`${t}.default`);
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="row">
                <div className="field">
                  <label>Profile</label>
                  <div className="profileList" role="list">
                    {orderedProfiles.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`profileCard ${profileId === p.id ? "profileOn" : ""}`}
                        onClick={() => setProfileId(p.id)}
                      >
                        <div className="profileTitle">{p.title}</div>
                        <div className="profileMeta">
                          <span className="chip chipOn">{p.tool}</span>
                          <span className="mono">{p.id}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="row">
                <div className="field">
                  <label>Workspace</label>
                  <div className="inline">
                    <input
                      value={cwd}
                      onChange={(e) => setCwd(e.target.value)}
                      placeholder={doctor?.workspaceRoots?.[0] ?? "/path/to/workspace"}
                      autoCapitalize="none"
                      autoCorrect="off"
                    />
                    <button
                      className="btn"
                      onClick={async () => {
                        setShowPicker(true);
                        await loadPicker(cwd.trim() || undefined);
                      }}
                    >
                      Browse
                    </button>
                  </div>
                  {recentForPicker.length ? (
                    <div className="chipsRow" style={{ marginTop: 10 }}>
                      <span className="muted" style={{ fontSize: 12 }}>
                        Recent:
                      </span>
                      {recentForPicker.map((p) => (
                        <button key={p} className="chip chipBtn mono" onClick={() => setCwd(p)}>
                          {p}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="chipsRow" style={{ marginTop: 10, justifyContent: "space-between" }}>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                      <label className="toggle" style={{ margin: 0 }}>
                        <input type="checkbox" checked={autoPreset} onChange={(e) => setAutoPreset(e.target.checked)} />
                        <span className="muted">Auto defaults</span>
                      </label>
                      <label className="toggle" style={{ margin: 0 }}>
                        <input type="checkbox" checked={savePreset} onChange={(e) => setSavePreset(e.target.checked)} />
                        <span className="muted">Save defaults</span>
                      </label>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        className="btn"
                        onClick={() => {
                          const p = workspacePreset;
                          if (!p) {
                            setPresetMsg("No saved defaults for this workspace");
                            return;
                          }
                          applyPresetNow(p);
                        }}
                      >
                        Apply Defaults
                      </button>
                    </div>
                  </div>
                  {presetMsg ? <div className="help mono">{presetMsg}</div> : null}
                  <div className="help">Codex uses `--cd`. OpenCode uses the positional project path.</div>
                </div>
              </div>

              {advanced ? (
                <div className="adv">
                  {tool === "codex" ? (
                    <div className="grid2">
                      <div className="field">
                        <label>Sandbox</label>
                        <select value={codexOpt.sandbox} onChange={(e) => setCodexOpt((p) => ({ ...p, sandbox: e.target.value }))}>
                          {(codexCaps?.sandboxModes ?? ["workspace-write"]).map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label>Approval Policy</label>
                        <select
                          value={codexOpt.askForApproval}
                          onChange={(e) => setCodexOpt((p) => ({ ...p, askForApproval: e.target.value }))}
                        >
                          {(codexCaps?.approvalPolicies ?? ["on-request"]).map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="toggles">
                        <label className="toggle">
                          <input type="checkbox" checked={codexOpt.fullAuto} onChange={(e) => setCodexOpt((p) => ({ ...p, fullAuto: e.target.checked }))} />
                          <span>Full Auto</span>
                        </label>
                        <label className="toggle">
                          <input
                            type="checkbox"
                            checked={codexOpt.noAltScreen}
                            onChange={(e) => setCodexOpt((p) => ({ ...p, noAltScreen: e.target.checked }))}
                          />
                          <span>No Alt Screen (better Inbox detection)</span>
                        </label>
                        <label className="toggle">
                          <input type="checkbox" checked={codexOpt.search} onChange={(e) => setCodexOpt((p) => ({ ...p, search: e.target.checked }))} />
                          <span>Web Search</span>
                        </label>
                        <label className="toggle dangerToggle">
                          <input
                            type="checkbox"
                            checked={codexOpt.bypassApprovalsAndSandbox}
                            onChange={(e) => setCodexOpt((p) => ({ ...p, bypassApprovalsAndSandbox: e.target.checked }))}
                          />
                          <span>Bypass Approvals and Sandbox</span>
                        </label>
                      </div>
                      <div className="field span2">
                        <label>Additional Writable Dirs</label>
                        <textarea value={codexOpt.addDirText} onChange={(e) => setCodexOpt((p) => ({ ...p, addDirText: e.target.value }))} placeholder="/path/one\n/path/two" />
                        <div className="help">Each line becomes `--add-dir` (validated under allowed roots).</div>
                      </div>
                    </div>
                  ) : null}

                  {tool === "claude" ? (
                    <div className="grid2">
                      <div className="field">
                        <label>Permission Mode</label>
                        <select
                          value={claudeOpt.permissionMode}
                          onChange={(e) => setClaudeOpt((p) => ({ ...p, permissionMode: e.target.value }))}
                        >
                          {(claudeCaps?.permissionModes ?? ["default"]).map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label>Danger</label>
                        <label className="toggle dangerToggle">
                          <input
                            type="checkbox"
                            checked={claudeOpt.dangerouslySkipPermissions}
                            onChange={(e) => setClaudeOpt((p) => ({ ...p, dangerouslySkipPermissions: e.target.checked }))}
                          />
                          <span>dangerously-skip-permissions</span>
                        </label>
                      </div>
                      <div className="field span2">
                        <label>Additional Dirs</label>
                        <textarea value={claudeOpt.addDirText} onChange={(e) => setClaudeOpt((p) => ({ ...p, addDirText: e.target.value }))} placeholder="/path/one\n/path/two" />
                        <div className="help">Each line becomes `--add-dir` (validated under allowed roots).</div>
                      </div>
                    </div>
                  ) : null}

                  {tool === "opencode" ? (
                    <div className="grid2">
                      <div className="field span2">
                        <label>Model (--model)</label>
                        <div className="inline">
                          <input
                            value={opencodeOpt.model}
                            onChange={(e) => setOpenCodeOpt((p) => ({ ...p, model: e.target.value }))}
                            placeholder="provider/model (optional)"
                            autoCapitalize="none"
                            autoCorrect="off"
                          />
                          <button
                            className="btn"
                            disabled={modelLoading}
                            onClick={async () => {
                              // Best-effort: if user already typed a provider/model, prefill provider & search.
                              const cur = String(opencodeOpt.model || "").trim();
                              const idx = cur.indexOf("/");
                              if (idx > 0) {
                                setModelProvider(cur.slice(0, idx));
                                setModelQuery(cur.slice(idx + 1));
                              } else if (cur) {
                                setModelQuery(cur);
                              }
                              setShowModelPicker(true);
                              if (modelList.length === 0) await loadOpenCodeModels({ provider: "" });
                            }}
                          >
                            Browse
                          </button>
                        </div>
                        <div className="help">
                          Example free models: <span className="mono">opencode/kimi-k2.5-free</span>,{" "}
                          <span className="mono">opencode/minimax-m2.5-free</span>. Other providers require host credentials (
                          run <span className="mono">opencode auth</span> on the host).
                        </div>
                        {!opencodeCaps?.supports?.model ? (
                          <div className="help">
                            Your installed <span className="mono">opencode</span> doesn’t report <span className="mono">--model</span> support (update OpenCode to enable the model picker).
                          </div>
                        ) : null}
                      </div>
                      <div className="field">
                        <label>Agent</label>
                        <input value={opencodeOpt.agent} onChange={(e) => setOpenCodeOpt((p) => ({ ...p, agent: e.target.value }))} placeholder="build / plan / ..." autoCapitalize="none" autoCorrect="off" />
                      </div>
                      <div className="field">
                        <label>Session</label>
                        <input value={opencodeOpt.session} onChange={(e) => setOpenCodeOpt((p) => ({ ...p, session: e.target.value }))} placeholder="session id (optional)" autoCapitalize="none" autoCorrect="off" />
                      </div>
                      <div className="field span2">
                        <label>Prompt Override</label>
                        <input value={opencodeOpt.prompt} onChange={(e) => setOpenCodeOpt((p) => ({ ...p, prompt: e.target.value }))} placeholder="prompt name (optional)" autoCapitalize="none" autoCorrect="off" />
                      </div>
                      <div className="toggles span2">
                        <label className="toggle">
                          <input type="checkbox" checked={opencodeOpt.cont} onChange={(e) => setOpenCodeOpt((p) => ({ ...p, cont: e.target.checked }))} />
                          <span>Continue last</span>
                        </label>
                        <label className="toggle">
                          <input type="checkbox" checked={opencodeOpt.fork} onChange={(e) => setOpenCodeOpt((p) => ({ ...p, fork: e.target.checked }))} />
                          <span>Fork session</span>
                        </label>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="row">
                <button className="btn primary big" onClick={createSession}>
                  Start Session
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {tab === "settings" ? (
          <section className="view">
            <div className="card">
              <div className="cardHead">
                <div>
                  <div className="cardTitle">Pair A Device</div>
                  <div className="cardSub">Generates a short code so you don’t paste long tokens.</div>
                </div>
                <button
                  className="btn primary"
                  onClick={async () => {
                    try {
                      const r = await api<{ ok: boolean; code: string; expiresAt: number }>("/api/auth/pair/start", { method: "POST" });
                      const url = `${window.location.origin}/?pair=${encodeURIComponent(r.code)}`;
                      setPairInfo({ code: r.code, url, expiresAt: r.expiresAt });
                      setToast("Pair code generated");
                    } catch {
                      setToast("Failed to generate pair code");
                    }
                  }}
                >
                  Generate Code
                </button>
              </div>
              <div className="row">
                <div className="help">Open this site on the new phone, tap Pair, and enter the code.</div>
              </div>
              {pairInfo ? (
                <div className="row">
                  <div className="field">
                    <label>Pair Code</label>
                    <div className="pairCodeBig mono">{pairInfo.code}</div>
                    <div className="help mono">{pairInfo.url}</div>
                    <div className="runBtns" style={{ marginTop: 10 }}>
                      <button
                        className="btn"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(pairInfo.code);
                            setToast("Copied code");
                          } catch {
                            setToast("Copy failed (needs HTTPS)");
                          }
                        }}
                      >
                        Copy Code
                      </button>
                      <button
                        className="btn"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(pairInfo.url);
                            setToast("Copied link");
                          } catch {
                            setToast("Copy failed (needs HTTPS)");
                          }
                        }}
                      >
                        Copy Link
                      </button>
                      <button className="btn ghost" onClick={() => window.open(pairInfo.url, "_blank")}>
                        Open
                      </button>
                    </div>
                    <div className="help">Expires: {new Date(pairInfo.expiresAt).toLocaleString()}</div>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="card">
              <div className="cardHead">
                <div>
                  <div className="cardTitle">Pinned Slots</div>
                  <div className="cardSub">3 recommended, 4 recommended max, 6 experimental.</div>
                </div>
              </div>
              <div className="row">
                <div className="seg">
                  <button className={`segBtn ${slotCfg.slots === 3 ? "segOn" : ""}`} onClick={() => setSlotCfg({ slots: 3 })}>
                    3 (Recommended)
                  </button>
                  <button className={`segBtn ${slotCfg.slots === 4 ? "segOn" : ""}`} onClick={() => setSlotCfg({ slots: 4 })}>
                    4 (Rec. Max)
                  </button>
                  <button className={`segBtn ${slotCfg.slots === 6 ? "segOn" : ""}`} onClick={() => setSlotCfg({ slots: 6 })}>
                    6 (Experimental)
                  </button>
                </div>
              </div>
              <div className="row">
                <div className="help">
                  Pin/unpin from Workspace. Swipe left/right in Run to switch between pinned sessions.
                </div>
              </div>
            </div>
            <div className="card">
              <div className="cardHead">
                <div>
                  <div className="cardTitle">Tool Doctor</div>
                  <div className="cardSub">Detected capabilities on this host.</div>
                </div>
                <button className="btn" onClick={rescanDoctor}>
                  Rescan
                </button>
              </div>
              <div className="doctorGrid">
                <div className="doctorBox">
                  <div className="doctorTitle">codex</div>
                  <div className="mono muted">{doctor?.tools.codex.version ?? ""}</div>
                  <div className="doctorBadges">
                    <span className="chip">sandbox</span>
                    <span className="chip">approvals</span>
                    <span className="chip">--cd</span>
                  </div>
                </div>
                <div className="doctorBox">
                  <div className="doctorTitle">claude</div>
                  <div className="mono muted">{doctor?.tools.claude.version ?? ""}</div>
                  <div className="doctorBadges">
                    <span className="chip">permission-mode</span>
                    <span className="chip">skip-perms</span>
                  </div>
                </div>
                <div className="doctorBox">
                  <div className="doctorTitle">opencode</div>
                  <div className="mono muted">{doctor?.tools.opencode.version ?? ""}</div>
                  <div className="doctorBadges">
                    <span className="chip">--agent</span>
                    <span className="chip">serve</span>
                    <span className="chip">web</span>
                  </div>
                </div>
              </div>
              <div className="help">
                Allowed workspace roots: <span className="mono">{(doctor?.workspaceRoots ?? []).join(", ")}</span>
              </div>
            </div>

            <div className="card">
              <div className="cardHead">
                <div>
                  <div className="cardTitle">Config</div>
                  <div className="cardSub">Edit `~/.fromyourphone/config.toml`</div>
                </div>
                <button className="btn primary" onClick={openConfig}>
                  Open Editor
                </button>
              </div>
              <div className="help">
                Profiles are best defined with tool-native fields: `profiles.*.codex`, `profiles.*.claude`, `profiles.*.opencode`.
              </div>
            </div>
          </section>
        ) : null}
      </main>

      <nav className="nav">
        <button className={`navBtn ${tab === "run" ? "navOn" : ""}`} onClick={() => setTab("run")}>
          <IconTerminal />
          <span className="navLabel">Terminal</span>
        </button>
        <button className={`navBtn ${tab === "workspace" ? "navOn" : ""}`} onClick={() => setTab("workspace")}>
          <IconFolder />
          <span className="navLabel">Projects</span>
        </button>
        <button className={`navBtn ${tab === "inbox" ? "navOn" : ""}`} onClick={() => {
          refreshInbox({ workspaceKey: selectedWorkspaceKey });
          setTab("inbox");
        }}>
          <IconInbox />
          <span className="navLabel">Inbox</span>
          {workspaceInboxCount > 0 ? <span className="navBadge">{workspaceInboxCount}</span> : null}
        </button>
        <button className={`navBtn ${tab === "new" ? "navOn" : ""}`} onClick={() => setTab("new")}>
          <IconPlus />
          <span className="navLabel">New</span>
        </button>
      </nav>

      {showPicker ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHead">
              <b>Pick Workspace Folder</b>
              <span className="chip mono">{pickPath || ""}</span>
              <div className="spacer" />
              <button className="btn" onClick={() => setShowPicker(false)}>
                Close
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setCwd(pickPath);
                  setShowPicker(false);
                  setToast("Workspace selected");
                }}
              >
                Use
              </button>
            </div>
            <div className="modalBody">
              <div className="inline">
                <input value={pickPath} onChange={(e) => setPickPath(e.target.value)} placeholder="/path/to/workspace" autoCapitalize="none" autoCorrect="off" />
                <button className="btn" onClick={() => loadPicker(pickPath)}>
                  Go
                </button>
                {pickParent ? (
                  <button className="btn" onClick={() => loadPicker(pickParent)}>
                    Up
                  </button>
                ) : null}
                <button
                  className={`btn ${pickShowHidden ? "primary" : "ghost"}`}
                  onClick={async () => {
                    const next = !pickShowHidden;
                    setPickShowHidden(next);
                    await loadPicker(pickPath, { showHidden: next });
                  }}
                >
                  {pickShowHidden ? "Hide dotfolders" : "Show dotfolders"}
                </button>
              </div>
              <div className="list">
                {pickEntries.map((e) => (
                  <button className="listRow" key={e.path} onClick={() => e.kind === "dir" && loadPicker(e.path)}>
                    <div className="listLeft">
                      <span className="chip">{e.kind}</span>
                      <div className="listText">
                        <div className="listTitle">{e.name}</div>
                        <div className="listSub mono">{e.path}</div>
                      </div>
                    </div>
                    <div className="listRight">{e.kind === "dir" ? ">" : ""}</div>
                  </button>
                ))}
              </div>
              <div className="help">Dot-folders are hidden by default. Use the toggle above for `.worktrees`, `.git`, etc.</div>
            </div>
          </div>
        </div>
      ) : null}

      {showConfig ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHead">
              <b>config.toml</b>
              <span className="chip">live profiles</span>
              <div className="spacer" />
              <button className="btn" onClick={() => setShowConfig(false)}>
                Close
              </button>
              <button className="btn primary" onClick={saveConfig}>
                Save
              </button>
            </div>
            <div className="modalBody">
              <textarea className="codebox" value={configToml} onChange={(e) => setConfigToml(e.target.value)} />
              <div className="help">{configMsg ? configMsg : "Tip: use tool-native fields, not startup macros."}</div>
            </div>
          </div>
        </div>
      ) : null}

      {showModelPicker ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHead">
              <b>OpenCode Models</b>
              <span className="chip mono">{modelList.length}</span>
              <div className="spacer" />
              <button className="btn" onClick={() => setShowModelPicker(false)}>
                Close
              </button>
            </div>
            <div className="modalBody">
              <div className="grid2">
                <div className="field">
                  <label>Provider</label>
                  <select value={modelProvider} onChange={(e) => setModelProvider(e.target.value)}>
                    <option value="">All providers</option>
                    {modelProviders.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Search</label>
                  <input
                    value={modelQuery}
                    onChange={(e) => setModelQuery(e.target.value)}
                    placeholder="glm, kimi, gpt-5, ... (filter)"
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </div>
                <div className="runBtns span2" style={{ marginTop: 10 }}>
                  <button
                    className="btn"
                    disabled={modelLoading}
                    onClick={async () => {
                      await loadOpenCodeModels({ provider: "" });
                      setToast("Loaded models");
                    }}
                  >
                    Reload
                  </button>
                  <button
                    className="btn primary"
                    disabled={modelLoading}
                    onClick={async () => {
                      await loadOpenCodeModels({ provider: "", refresh: true });
                      setToast("Refreshed models");
                    }}
                  >
                    Refresh
                  </button>
                  <button
                    className="btn ghost"
                    onClick={() => {
                      setOpenCodeOpt((p) => ({ ...p, model: "" }));
                      setToast("Model cleared");
                      setShowModelPicker(false);
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
              {modelListMsg ? <div className="help mono">{modelListMsg}</div> : null}
              <div className="help">
                Model IDs are <span className="mono">provider/model</span>. If a provider needs credentials, configure it on the host (try{" "}
                <span className="mono">opencode auth</span>).
              </div>

              <div className="list">
                {filteredModels.slice(0, 240).map((m) => {
                  const s = String(m);
                  const idx = s.indexOf("/");
                  const prov = idx > 0 ? s.slice(0, idx) : "model";
                  const name = idx > 0 ? s.slice(idx + 1) : s;
                  const selected = String(opencodeOpt.model || "").trim() === s;
                  return (
                    <button
                      className={`listRow ${selected ? "listRowOn" : ""}`}
                      key={s}
                      onClick={() => {
                        setOpenCodeOpt((p) => ({ ...p, model: s }));
                        setToast(`Selected: ${s}`);
                        setShowModelPicker(false);
                      }}
                    >
                      <div className="listLeft">
                        <span className={`chip ${selected ? "chipOn" : ""}`}>{prov}</span>
                        <div className="listText">
                          <div className="listTitle mono">{name}</div>
                          <div className="listSub mono">{s}</div>
                        </div>
                      </div>
                      <div className="listRight mono">{selected ? "selected" : ""}</div>
                    </button>
                  );
                })}
              </div>
              <div className="help mono">
                {filteredModels.length > 240 ? `Showing 240 of ${filteredModels.length}. Refine provider/search.` : `Showing ${filteredModels.length}.`}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showToolChat ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal modalChat">
            <div className="modalHead">
              <b>Chat History</b>
              {toolChatSession ? <span className="chip chipOn">{toolChatSession.tool}</span> : <span className="chip">loading</span>}
              {toolChatSession?.id ? <span className="chip mono">{toolChatSession.id.slice(0, 8)}</span> : null}
              <div className="spacer" />
              {toolChatSession ? (
                <>
                  <button className="btn" onClick={() => openToolChat(toolChatSession.tool, toolChatSession.id, { refresh: true })} disabled={toolChatLoading}>
                    Refresh
                  </button>
                  <button className="btn primary" onClick={() => startFromToolSession(toolChatSession, "resume")} disabled={toolChatLoading}>
                    Resume
                  </button>
                  <button className="btn ghost" onClick={() => startFromToolSession(toolChatSession, "fork")} disabled={toolChatLoading}>
                    Fork
                  </button>
                </>
              ) : null}
              <button className="btn" onClick={() => setShowToolChat(false)}>
                Close
              </button>
            </div>
            <div className="modalBody">
              {toolChatSession?.cwd ? <div className="help mono">{toolChatSession.cwd}</div> : null}
              {toolChatMsg ? <div className="help mono">{toolChatMsg}</div> : null}
              {toolChatLoading ? <div className="help">Loading chat...</div> : null}
              <div className="chatList">
                {toolChatMessages.map((m, idx) => (
                  <div key={idx} className={`chatMsg ${m.role === "user" ? "chatUser" : "chatAssistant"}`}>
                    <div className="chatMeta mono">
                      {m.role} · {new Date(m.ts).toLocaleString()}
                    </div>
                    <div className="chatText">
                      <FencedMessage text={m.text} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showLog ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHead">
              <b>Session Log</b>
              <span className="chip">{events.length}</span>
              <div className="spacer" />
              <button className="btn" onClick={() => setShowLog(false)}>
                Close
              </button>
            </div>
            <div className="modalBody">
              <div className="list">
                {events.slice(-200).map((e) => (
                  <div key={e.id} className="listRow" style={{ cursor: "default" }}>
                    <div className="listLeft">
                      <span className="chip">{e.kind}</span>
                      <div className="listText">
                        <div className="listTitle mono">
                          {formatEventLine(e).slice(0, 320)}
                        </div>
                        <div className="listSub mono">{new Date(e.ts).toLocaleString()}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="help">This includes your inputs plus actions (interrupt/stop/kill) and approval decisions.</div>
            </div>
          </div>
        </div>
      ) : null}

      {showControls ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHead">
              <b>Controls</b>
              {activeSession ? <span className="chip mono">{activeSession.tool}</span> : null}
              <div className="spacer" />
              <button className="btn" onClick={() => setShowControls(false)}>
                Close
              </button>
	            </div>
	            <div className="modalBody">
	              <div className="row">
	                <div className="cardTitle">Session</div>
	                <div className="field" style={{ marginTop: 10 }}>
	                  <label>Label</label>
	                  <input
	                    value={labelDraft}
	                    onChange={(e) => setLabelDraft(e.target.value)}
	                    placeholder="optional name (e.g. api-fix, auth, ui)"
	                    autoCapitalize="none"
	                    autoCorrect="off"
	                  />
	                </div>
	                <div className="runBtns" style={{ marginTop: 10 }}>
	                  <button
	                    className="btn primary"
	                    onClick={async () => {
	                      if (!activeSession?.id) return;
	                      try {
	                        await setSessionMeta(activeSession.id, { label: labelDraft.trim() ? labelDraft.trim() : null });
	                        setToast("Saved label");
	                        setShowControls(false);
	                        refreshSessions();
	                        refreshWorkspaces();
	                      } catch (e: any) {
	                        setToast(typeof e?.message === "string" ? e.message : "failed to save label");
	                      }
	                    }}
	                  >
	                    Save
	                  </button>
	                  <button className="btn ghost" onClick={() => setLabelDraft("")}>
	                    Clear
	                  </button>
	                </div>
	                <div className="help">Labels show on pinned slots and in the Workspace list.</div>
	              </div>
	              <div className="row">
	                <div className="cardTitle">Terminal</div>
	                <div className="runBtns" style={{ marginTop: 10 }}>
	                  <button className="btn ghost" onClick={() => setFontSize((n) => Math.max(11, n - 1))}>
	                    A-
	                  </button>
	                  <button className="btn ghost" onClick={() => setFontSize((n) => Math.min(22, n + 1))}>
	                    A+
	                  </button>
	                  <button className="btn" onClick={() => fit.current?.fit()}>
	                    Fit
	                  </button>
	                </div>
                  <div className="runBtns" style={{ marginTop: 10 }}>
                    <button className="btn" onClick={() => sendRaw("\u001b")}>
                      Esc
                    </button>
                    <button className="btn" onClick={() => sendRaw("\t")}>
                      Tab
                    </button>
                    <button className="btn" onClick={() => sendRaw("\u001b[Z")}>
                      Shift+Tab
                    </button>
                    <button className="btn" onClick={() => sendRaw("\r")}>
                      Enter
                    </button>
                  </div>
                  <div className="runBtns" style={{ marginTop: 10 }}>
                    <button className="btn" onClick={() => sendRaw("\u001b[D")}>
                      Left
                    </button>
                    <button className="btn" onClick={() => sendRaw("\u001b[A")}>
                      Up
                    </button>
                    <button className="btn" onClick={() => sendRaw("\u001b[B")}>
                      Down
                    </button>
                    <button className="btn" onClick={() => sendRaw("\u001b[C")}>
                      Right
                    </button>
                  </div>
                  <div className="help">Use these keys for TUI menus (permissions, mode picker, etc.).</div>
	              </div>
              <div className="row">
                <div className="cardTitle">Process</div>
                <div className="runBtns" style={{ marginTop: 10 }}>
                  <button className="btn" onClick={() => sendControl("stop")}>
                    Stop
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => {
                      sendControl("kill");
                      setShowControls(false);
                    }}
                  >
                    Kill
                  </button>
                </div>
                <div className="help">Stop sends Ctrl+C. Kill sends SIGKILL to the tool process.</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <div className="toast mono">{toast}</div> : null}
    </div>
  );
}
