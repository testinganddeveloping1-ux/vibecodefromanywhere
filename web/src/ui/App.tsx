import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Terminal as XTermTerminal } from "@xterm/xterm";
import type { FitAddon as XTermFitAddon } from "@xterm/addon-fit";

import type {
  Doctor,
  EventItem,
  InboxItem,
  Profile,
  RecentWorkspace,
  SessionRow,
  TabId,
  ToolId,
  ToolSessionMessage,
  ToolSessionSummary,
  ToolSessionTool,
  TuiAssist,
  WorkspaceItem,
} from "./types";
import { api } from "./lib/api";
import { groupByRecent, treeLabel } from "./lib/grouping";
import { dirsFromText, normalizeEvent } from "./lib/text";
import { lsGet, lsRemove, lsSet } from "./lib/storage";
import { HeaderBar } from "./components/HeaderBar";
import { ConnectingScreen, UnlockScreen } from "./components/LoginScreens";
import { BottomNav } from "./components/BottomNav";
import { PinnedSlotsBar } from "./components/PinnedSlotsBar";

import { TerminalAssistOverlay } from "./components/TerminalAssistOverlay";
import { CodexNativeThreadView } from "./components/CodexNativeThreadView";
import { ToolChip } from "./components/ToolChip";
import { PickerModal } from "./modals/PickerModal";
import { ConfigModal } from "./modals/ConfigModal";
import { ModelPickerModal } from "./modals/ModelPickerModal";
import { ToolChatModal } from "./modals/ToolChatModal";
import { LogModal } from "./modals/LogModal";
import { ControlsModal } from "./modals/ControlsModal";

function cleanPreviewLine(raw: string): string {
  let s = String(raw ?? "");
  if (!s.trim()) return "";
  // Control chars (including C1) can leak into previews and render as weird fragments on phones.
  s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
  // Some terminals emit cursor-position sequences as visible text when partially stripped (e.g. "4;2H").
  s = s.replace(/\b\d{1,3}(?:;\d{1,3})+[A-Za-z]\b/g, " ");

  // Codex prompts often include a "›" marker. Keeping the last one makes previews far more readable.
  const lastPrompt = s.lastIndexOf("›");
  if (lastPrompt >= 0) s = s.slice(lastPrompt);

  // De-noise common Codex footer hints when they appear.
  s = s.replace(/\s*\?\s*for shortcuts\b/gi, "?");
  s = s.replace(/\s*\b\d{1,3}%\s*context left\b\s*$/gi, "");

  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

function isPhoneLikeDevice(): boolean {
  try {
    const ua = typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "";
    const coarse =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(pointer: coarse)").matches
        : false;
    return coarse || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  } catch {
    return false;
  }
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
    const raw = lsGet("fyp_ws");
    return raw ? String(raw) : null;
  });
  const [selectedTreePath, setSelectedTreePath] = useState<string>(() => {
    const ws = lsGet("fyp_ws");
    const mapRaw = lsGet("fyp_tree_map");
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
    const raw = lsGet("fyp_tree");
    return raw ? String(raw) : "";
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
  const [toolChatLimit, setToolChatLimit] = useState<number>(240);

  // Codex Native (app-server) thread view
  const [codexNativeThread, setCodexNativeThread] = useState<any | null>(null);
  const [codexNativeLoading, setCodexNativeLoading] = useState(false);
  const [codexNativeMsg, setCodexNativeMsg] = useState<string | null>(null);
  const [codexNativeLive, setCodexNativeLive] = useState<{ kind: string; threadId: string; turnId: string; itemId: string; text: string } | null>(null);
  const [codexNativeDiff, setCodexNativeDiff] = useState<string | null>(null);

  const [slotCfg, setSlotCfg] = useState<{ slots: 3 | 4 | 6 }>(() => {
    const raw = lsGet("fyp_slots");
    const n = raw ? Number(raw) : 3;
    return { slots: n === 6 ? 6 : n === 4 ? 4 : 3 };
  });
  const [autoPinNew, setAutoPinNew] = useState<boolean>(() => {
    const raw = lsGet("fyp_autopin");
    if (raw == null) return true;
    return raw === "1" || raw === "true" || raw === "yes";
  });

  const [codexOpt, setCodexOpt] = useState(() => {
    const rawTransport = lsGet("fyp_codex_transport");
    const transport =
      rawTransport === "pty" || rawTransport === "codex-app-server" ? rawTransport : "codex-app-server";
    return {
      transport,
      sandbox: "",
      askForApproval: "",
      fullAuto: false,
      bypassApprovalsAndSandbox: false,
      search: false,
      noAltScreen: true,
      addDirText: "",
    };
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
  const activeIsCodexNative =
    activeSession?.tool === "codex" && String(activeSession?.transport ?? "pty") === "codex-app-server";
  const activeIsRawTerminal = Boolean(activeSession) && !activeIsCodexNative;
  const activeSessionClosing = Boolean(activeSession?.closing);
  const activeToolSessionId = useMemo(() => {
    const v = typeof activeSession?.toolSessionId === "string" ? String(activeSession.toolSessionId).trim() : "";
    return v || "";
  }, [activeSession?.toolSessionId]);
  const activeCanOpenChatHistory =
    !activeIsCodexNative && (activeSession?.tool === "codex" || activeSession?.tool === "claude") && Boolean(activeToolSessionId);
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
  const workspaceSessionsSorted = useMemo(() => {
    const norm = (v: unknown): string => String(v ?? "").trim().replace(/\/+$/g, "");
    const key = String(activeWorkspaceKey ?? "").trim();
    const activeRoot = norm(activeSession?.workspaceRoot || activeSession?.treePath || activeSession?.cwd || "");
    const byId = new Map<string, SessionRow>();

    for (const s of sessions) {
      const gk = String(s.workspaceKey ?? (s.cwd ? `dir:${s.cwd}` : `dir:${s.id}`));
      let include = false;
      if (key && gk === key) include = true;

      if (!include && activeRoot) {
        const roots = [s.workspaceRoot, s.treePath, s.cwd].map((x) => norm(x)).filter(Boolean);
        include = roots.some((r) => r === activeRoot || r.startsWith(activeRoot + "/") || activeRoot.startsWith(r + "/"));
      }

      if (!include) continue;
      const prev = byId.get(s.id);
      if (!prev || Number(s.updatedAt ?? 0) >= Number(prev.updatedAt ?? 0)) byId.set(s.id, s);
    }

    return Array.from(byId.values()).sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
  }, [sessions, activeWorkspaceKey, activeSession?.workspaceRoot, activeSession?.treePath, activeSession?.cwd]);
  const workspaceSessionOrder = useMemo(
    () => workspaceSessionsSorted.map((s) => s.id),
    [workspaceSessionsSorted],
  );
  const fallbackSwitchOrder = useMemo(() => {
    if (!activeSession) return [] as string[];
    return sessions
      .filter((s) => s.tool === activeSession.tool)
      .slice()
      .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
      .map((s) => s.id);
  }, [sessions, activeSession?.tool]);
  const sessionSwitchOrder = useMemo(
    () => {
      const primary = pinnedOrder.length >= 2 ? pinnedOrder : workspaceSessionOrder;
      if (primary.length >= 2) return primary;
      if (fallbackSwitchOrder.length >= 2) return fallbackSwitchOrder;
      return primary;
    },
    [pinnedOrder, workspaceSessionOrder, fallbackSwitchOrder],
  );
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
  const [tuiAssist, setTuiAssist] = useState<TuiAssist | null>(null);
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);
  const [workspacePreset, setWorkspacePreset] = useState<{ profileId: string; overrides: any } | null>(null);
  const [presetMsg, setPresetMsg] = useState<string | null>(null);
  const [autoPreset, setAutoPreset] = useState(true);
  const [savePreset, setSavePreset] = useState(true);
  const [pairCode, setPairCode] = useState("");
  const [pairInfo, setPairInfo] = useState<{ code: string; url: string; expiresAt: number } | null>(null);
  const [pairMsg, setPairMsg] = useState<string | null>(null);
  const [unlockMsg, setUnlockMsg] = useState<string | null>(null);

  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelProvider, setModelProvider] = useState<string>("opencode");
  const [modelQuery, setModelQuery] = useState<string>("");
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelListMsg, setModelListMsg] = useState<string | null>(null);
  const [modelLoading, setModelLoading] = useState(false);

  const termRef = useRef<HTMLDivElement | null>(null);
  const runSurfaceRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const term = useRef<XTermTerminal | null>(null);
  const fit = useRef<XTermFitAddon | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const termInit = useRef<Promise<void> | null>(null);
  const nativeChatRef = useRef<HTMLDivElement | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const globalWs = useRef<WebSocket | null>(null);
  const connectedSessionId = useRef<string | null>(null);
  const pendingInputBySession = useRef<Record<string, string[]>>({});
  const termOutBuf = useRef<{ chunks: string[]; bytes: number; timer: any } | null>(null);
  const termReplay = useRef<{ sessionId: string | null; inProgress: boolean }>({ sessionId: null, inProgress: false });
  const selectedWorkspaceKeyRef = useRef<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const tabRef = useRef<TabId>("workspace");
  const authedRef = useRef<"unknown" | "yes" | "no">("unknown");
  const dismissedAssistSig = useRef<string>("");
  const sessionCtl = useRef<{ id: string | null; attempt: number; timer: any; ping: any }>({ id: null, attempt: 0, timer: null, ping: null });
  const globalCtl = useRef<{ attempt: number; timer: any; ping: any }>({ attempt: 0, timer: null, ping: null });

  const [sessionWsState, setSessionWsState] = useState<"closed" | "connecting" | "open">("closed");
  const [globalWsState, setGlobalWsState] = useState<"closed" | "connecting" | "open">("closed");
  const [online, setOnline] = useState<boolean>(() => (typeof navigator !== "undefined" ? navigator.onLine : true));
  const [fontSize, setFontSize] = useState<number>(() => {
    const v = lsGet("fyp_font");
    // Phone-first default: smaller font gives more columns so TUIs wrap less.
    const n = v ? Number(v) : isPhoneLikeDevice() ? 13 : 15;
    return Number.isFinite(n) ? Math.min(22, Math.max(11, n)) : 15;
  });
  const [lineHeight, setLineHeight] = useState<number>(() => {
    const v = lsGet("fyp_lh");
    const n = v ? Number(v) : 1.4;
    return Number.isFinite(n) ? Math.min(1.6, Math.max(1.1, n)) : 1.4;
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
  const mergedWorkspaces = useMemo(() => {
    const norm = (v: string) => String(v || "").trim().replace(/\/+$/g, "");
    const byRoot = new Map<string, WorkspaceItem>();

    for (const w of workspaces) {
      const rootNorm = norm(String(w.root || ""));
      const mergeKey = rootNorm || String(w.key || "");
      const prev = byRoot.get(mergeKey);
      if (!prev) {
        byRoot.set(mergeKey, {
          ...w,
          trees: Array.isArray(w.trees) ? [...w.trees] : [],
          sessions: Array.isArray(w.sessions) ? [...w.sessions] : [],
        });
        continue;
      }

      const out: WorkspaceItem = {
        ...prev,
        trees: Array.isArray(prev.trees) ? [...prev.trees] : [],
        sessions: Array.isArray(prev.sessions) ? [...prev.sessions] : [],
      };

      const prevIsDir = String(prev.key || "").startsWith("dir:");
      const curIsDir = String(w.key || "").startsWith("dir:");
      if (prevIsDir && !curIsDir) out.key = w.key;

      if ((!prev.root || prev.root === "(unknown)") && w.root && w.root !== "(unknown)") out.root = w.root;
      out.isGit = Boolean(prev.isGit || w.isGit);

      const treeMap = new Map<string, any>();
      for (const t of [...(prev.trees ?? []), ...(w.trees ?? [])]) {
        const p = String((t as any)?.path ?? "");
        if (!p) continue;
        treeMap.set(p, t);
      }
      out.trees = Array.from(treeMap.values());

      const sessMap = new Map<string, SessionRow>();
      for (const s of [...(prev.sessions ?? []), ...(w.sessions ?? [])]) {
        const sid = String((s as any)?.id ?? "");
        if (!sid) continue;
        const cur = sessMap.get(sid);
        if (!cur || Number((s as any)?.updatedAt ?? 0) >= Number((cur as any)?.updatedAt ?? 0)) {
          sessMap.set(sid, s as SessionRow);
        }
      }
      out.sessions = Array.from(sessMap.values()).sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
      out.lastUsed = Math.max(Number(prev.lastUsed ?? 0), Number(w.lastUsed ?? 0), ...out.sessions.map((s) => Number(s.updatedAt ?? 0)));

      byRoot.set(mergeKey, out);
    }

    return Array.from(byRoot.values()).sort((a, b) => Number(b.lastUsed ?? 0) - Number(a.lastUsed ?? 0));
  }, [workspaces]);
  const filteredWorkspaces = useMemo(() => {
    const q = workspaceQuery.trim().toLowerCase();
    if (!q) return mergedWorkspaces;
    return mergedWorkspaces.filter((w) => String(w.root).toLowerCase().includes(q) || String(w.key).toLowerCase().includes(q));
  }, [workspaceQuery, mergedWorkspaces]);

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

      // Best-effort: wait for web fonts so xterm measures cell height correctly.
      // This reduces "lines clipping into each other" on some mobile browsers.
      try {
        const fonts: any = (document as any).fonts;
        if (fonts && typeof fonts.ready?.then === "function") {
          await Promise.race([
            fonts.ready,
            new Promise((r) => setTimeout(r, 700)),
          ]);
        }
      } catch {
        // ignore
      }

      const monoStack = (() => {
        try {
          const v = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim();
          return v || "\"IBM Plex Mono\", ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Monaco, Consolas, monospace";
        } catch {
          return "\"IBM Plex Mono\", ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Monaco, Consolas, monospace";
        }
      })();
      const isPhoneLike = isPhoneLikeDevice();
      const safeFontSize = fontSize;
      // iOS/Android canvas rendering can clip lines when lineHeight is too tight.
      const safeLineHeight = isPhoneLike ? Math.max(1.45, lineHeight) : lineHeight;

      const t = new Terminal({
        cursorBlink: true,
        fontFamily: monoStack,
        fontSize: safeFontSize,
        lineHeight: safeLineHeight,
        theme: {
          background: "#060810",
          foreground: "#e4eaf4",
          cursor: "#f5a623",
          selectionBackground: "rgba(148,163,184,.14)",
          selectionForeground: "#eaf0fa",
        },
        scrollback: 8000,
        allowTransparency: !isPhoneLike,
        rightClickSelectsWord: false,
      });
      try {
        (t.options as any).customGlyphs = !isPhoneLike;
      } catch {
        // ignore
      }
      const f = new FitAddon();
      t.loadAddon(f);
      t.open(el2);
      f.fit();
      try {
        t.refresh(0, Math.max(0, t.rows - 1));
      } catch {
        // ignore
      }
      term.current = t;
      fit.current = f;

      // If the web font loads after xterm mounts (slow mobile networks), the initial measurements
      // can be wrong and cause vertical clipping. Re-fit once fonts settle.
      try {
        const fonts: any = (document as any).fonts;
        if (fonts && typeof fonts.ready?.then === "function") {
          fonts.ready.then(() => {
            if (term.current !== t) return;
            try {
              f.fit();
              t.refresh(0, Math.max(0, t.rows - 1));
            } catch {
              // ignore
            }
          });
        }
      } catch {
        // ignore
      }

      try {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            fit.current?.fit();
            t.refresh(0, Math.max(0, t.rows - 1));
          });
        });
      } catch {
        // ignore
      }

      // Make the terminal interactive: forward keystrokes to the remote PTY.
      t.onData((data) => {
        if (!ws.current || ws.current.readyState !== WebSocket.OPEN || !connectedSessionId.current) return;
        // Filter out focus tracking sequences which can confuse some TUIs.
        const filtered = String(data ?? "").replace(/\x1b\[\[?[IO]/g, "");
        if (!filtered) return;
        ws.current.send(JSON.stringify({ type: "input", text: filtered }));
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

  async function refreshSessions(): Promise<SessionRow[] | null> {
    try {
      const rows = await api<SessionRow[]>("/api/sessions");
      setSessions(rows);
      // Keep the UI stable: if the current active session was deleted, fall back to the newest session (or none).
      setActiveId((prev) => {
        if (prev && rows.some((s) => s.id === prev)) return prev;
        return rows.length > 0 ? rows[0]!.id : null;
      });
      return rows;
    } catch {
      // ignore
      return null;
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
    // Mobile soft keyboard handling:
    // When the keyboard opens, the VisualViewport shrinks (esp. iOS Safari).
    // We expose the inset as a CSS var so the bottom UI doesn't get clipped.
    const root = document.documentElement;
    let raf = 0;

    const update = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          const vv: any = (window as any).visualViewport;
          const layoutH = window.innerHeight;
          const vvHeight = typeof vv?.height === "number" ? vv.height : layoutH;
          // iOS Safari can report non-zero offsetTop during address-bar transitions/zoom.
          // Using it here causes false "keyboard closed" states, so we ignore it.
          const kb = Math.max(0, layoutH - vvHeight);
          root.style.setProperty("--kb", `${Math.round(kb)}px`);
          if (kb > 30) root.dataset.kb = "1";
          else delete root.dataset.kb;
        } catch {
          // ignore
        }
      });
    };

    const vv: any = (window as any).visualViewport;
    update();
    vv?.addEventListener?.("resize", update);
    vv?.addEventListener?.("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv?.removeEventListener?.("resize", update);
      vv?.removeEventListener?.("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

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
          setPairMsg("Pair link expired or invalid. Generate a new one from host.");
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
        sandbox: d.tools.codex.sandboxModes?.includes("read-only")
          ? "read-only"
          : d.tools.codex.sandboxModes?.includes("workspace-write")
            ? "workspace-write"
            : (d.tools.codex.sandboxModes?.[0] ?? ""),
        askForApproval: d.tools.codex.approvalPolicies?.includes("on-request") ? "on-request" : (d.tools.codex.approvalPolicies?.[0] ?? ""),
      }));
      setClaudeOpt((p) => ({
        ...p,
        permissionMode: d.tools.claude.permissionModes?.includes("default") ? "default" : (d.tools.claude.permissionModes?.[0] ?? ""),
      }));
    })();
  }, [authed]);

  useEffect(() => {
    // Persist the user's preferred Codex transport (Native vs Terminal).
    // This is especially important on mobile where the default should be stable.
    try {
      lsSet("fyp_codex_transport", String((codexOpt as any).transport ?? "codex-app-server"));
    } catch {
      // ignore
    }
  }, [String((codexOpt as any).transport ?? "")]);

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
    if (!selectedWorkspaceKey) return;
    if (mergedWorkspaces.some((w) => String(w.key) === String(selectedWorkspaceKey))) return;
    const first = String(mergedWorkspaces[0]?.key ?? "").trim();
    if (first) setSelectedWorkspaceKey(first);
  }, [selectedWorkspaceKey, mergedWorkspaces]);

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
    if (authed !== "yes") return;
    // Mobile browsers frequently suspend background tabs and can leave websockets half-open.
    // When the app becomes visible again, force a clean reconnect.
    const onVis = () => {
      try {
        if (document.hidden) return;
      } catch {
        // ignore
      }
      try {
        globalWs.current?.close();
      } catch {
        // ignore
      }
      try {
        ws.current?.close();
      } catch {
        // ignore
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [authed]);

  useEffect(() => {
    if (selectedWorkspaceKey) lsSet("fyp_ws", selectedWorkspaceKey);
    else lsRemove("fyp_ws");
  }, [selectedWorkspaceKey]);

  useEffect(() => {
    // Back-compat: store last chosen tree path.
    if (selectedTreePath) lsSet("fyp_tree", selectedTreePath);
    else lsRemove("fyp_tree");

    // Preferred: store per-workspace selection for git workspaces.
    if (!selectedWorkspaceKey || selectedWorkspaceKey.startsWith("dir:")) return;
    const raw = lsGet("fyp_tree_map");
    let m: any = {};
    try {
      m = raw ? JSON.parse(raw) : {};
    } catch {
      m = {};
    }
    if (!m || typeof m !== "object") m = {};
    if (selectedTreePath) m[String(selectedWorkspaceKey)] = selectedTreePath;
    else delete m[String(selectedWorkspaceKey)];
    lsSet("fyp_tree_map", JSON.stringify(m));
  }, [selectedWorkspaceKey, selectedTreePath]);

  useEffect(() => {
    // Keep the selected tree consistent per workspace.
    if (!selectedWorkspaceKey) return;
    const w = mergedWorkspaces.find((x) => x.key === selectedWorkspaceKey) ?? null;
    if (!w) return;

    if (!w.isGit) {
      if (selectedTreePath) setSelectedTreePath("");
      return;
    }

    let saved = "";
    try {
      const raw = lsGet("fyp_tree_map");
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
  }, [selectedWorkspaceKey, mergedWorkspaces]);

  useEffect(() => {
    if (authed !== "yes") return;
    let stopped = false;

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
            const line = cleanPreviewLine(msg.line);
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
    const w = selectedWorkspaceKey ? mergedWorkspaces.find((x) => x.key === selectedWorkspaceKey) ?? null : null;
    const under = String(w?.root ?? "").trim();
    if (!under) {
      setToolSessions([]);
      return;
    }
    const t = setTimeout(() => refreshToolSessions({ under }), 160);
    return () => clearTimeout(t);
  }, [selectedWorkspaceKey, mergedWorkspaces, authed]);

  useEffect(() => {
    lsSet("fyp_slots", String(slotCfg.slots));
  }, [slotCfg]);

  useEffect(() => {
    lsSet("fyp_autopin", autoPinNew ? "1" : "0");
  }, [autoPinNew]);

  useEffect(() => {
    return () => {
      try {
        if (termOutBuf.current?.timer) clearTimeout(termOutBuf.current.timer);
      } catch {
        // ignore
      }
      termOutBuf.current = null;
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
    lsSet("fyp_font", String(fontSize));
    setTimeout(() => {
      try {
        fit.current?.fit();
        term.current?.refresh(0, Math.max(0, (term.current?.rows ?? 1) - 1));
      } catch {
        // ignore
      }
    }, 10);
  }, [fontSize]);

  useEffect(() => {
    if (!term.current) return;
    const safeLineHeight = isPhoneLikeDevice() ? Math.max(1.45, lineHeight) : lineHeight;
    term.current.options.lineHeight = safeLineHeight;
    lsSet("fyp_lh", String(lineHeight));
    setTimeout(() => {
      try {
        fit.current?.fit();
        term.current?.refresh(0, Math.max(0, (term.current?.rows ?? 1) - 1));
      } catch {
        // ignore
      }
    }, 10);
  }, [lineHeight]);

  useEffect(() => {
    if (tab !== "run") return;
    setTimeout(() => fit.current?.fit(), 50);
  }, [tab, activeId]);

  useEffect(() => {
    // Mobile browsers (esp. iOS) often change the visual viewport when the address bar or keyboard
    // appears. ResizeObserver doesn't always fire in those cases, so we explicitly refit xterm.
    const onResize = () => {
      try {
        fit.current?.fit();
        const cols = term.current?.cols;
        const rows = term.current?.rows;
        if (!cols || !rows || !ws.current || ws.current.readyState !== WebSocket.OPEN || !connectedSessionId.current) return;
        ws.current.send(JSON.stringify({ type: "resize", cols, rows }));
      } catch {
        // ignore
      }
    };

    window.addEventListener("resize", onResize, { passive: true } as any);
    window.addEventListener("orientationchange", onResize, { passive: true } as any);
    const vv: any = (window as any).visualViewport;
    if (vv && typeof vv.addEventListener === "function") {
      vv.addEventListener("resize", onResize, { passive: true } as any);
    }

    return () => {
      window.removeEventListener("resize", onResize as any);
      window.removeEventListener("orientationchange", onResize as any);
      if (vv && typeof vv.removeEventListener === "function") {
        vv.removeEventListener("resize", onResize as any);
      }
    };
  }, []);

  useEffect(() => {
    if (tab !== "run") return;
    if (!activeId) return;
    let cancelled = false;
    const id = activeId;
    (async () => {
      try {
        const isCodexNative =
          activeSession?.tool === "codex" && String(activeSession?.transport ?? "pty") === "codex-app-server";

        // Codex Native: load structured thread + connect session socket for live deltas.
        if (isCodexNative) {
          termReplay.current = { sessionId: null, inProgress: false };
          setCodexNativeDiff(null);
          setCodexNativeLive(null);
          setCodexNativeThread(null);
          setCodexNativeMsg(null);
          setEvents([]);
          if (!(connectedSessionId.current === id && ws.current && ws.current.readyState === WebSocket.OPEN)) {
            connectWs(id);
          }
          const threadId = typeof activeSession?.toolSessionId === "string" ? String(activeSession.toolSessionId) : "";
          if (threadId) await loadCodexNativeThread(threadId);
          await loadSessionEvents(id);
          return;
        }

        // PTY: replay transcript + events, then stream live output.
        await ensureTerminalReady();
        if (cancelled) return;
        termReplay.current = { sessionId: id, inProgress: true };
        setEvents([]);
        if (!(connectedSessionId.current === id && ws.current && ws.current.readyState === WebSocket.OPEN)) {
          connectWs(id);
        }
        await Promise.all([loadSessionEvents(id), loadSessionTranscriptToTerm(id)]);
      } catch {
        // ignore
      } finally {
        if (termReplay.current.sessionId === id) {
          termReplay.current.inProgress = false;
          flushTermOutput();
        }
      }
    })();
    return () => {
      cancelled = true;
      if (termReplay.current.sessionId === id) termReplay.current.inProgress = false;
    };
  }, [tab, activeId, activeSession?.tool, activeSession?.transport, activeSession?.toolSessionId]);

  useEffect(() => {
    if (tab !== "run") return;
    if (!activeIsCodexNative) return;
    const el = nativeChatRef.current;
    if (!el) return;
    const t = setTimeout(() => {
      try {
        el.scrollTop = el.scrollHeight;
      } catch {
        // ignore
      }
    }, 30);
    return () => clearTimeout(t);
  }, [tab, activeIsCodexNative, codexNativeThread, codexNativeLive?.text, codexNativeDiff]);

  useEffect(() => {
    if (tab !== "run") return;
    if (activeId) return;

    // If there is no active session (e.g. user deleted the last one), stop reconnect loops and close the socket.
    if (sessionCtl.current.timer) clearTimeout(sessionCtl.current.timer);
    sessionCtl.current.timer = null;
    if (sessionCtl.current.ping) clearInterval(sessionCtl.current.ping);
    sessionCtl.current.ping = null;
    try {
      ws.current?.close();
    } catch {
      // ignore
    }
    ws.current = null;
    connectedSessionId.current = null;
    setSessionWsState("closed");
    try {
      if (termOutBuf.current?.timer) clearTimeout(termOutBuf.current.timer);
    } catch {
      // ignore
    }
    termOutBuf.current = null;

    dismissedAssistSig.current = "";
    setTuiAssist(null);
  }, [tab, activeId]);

  useEffect(() => {
    // Swipe left/right on the terminal area to switch sessions.
    // Keep this very light-touch so scrolling/typing in mobile browsers stays reliable.
    if (tab !== "run") return;
    if (activeIsCodexNative) return;
    if (activeSessionClosing) return;
    const el = termRef.current;
    if (!el) return;
    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startTs = 0;

    const reset = () => {
      pointerId = null;
      startTs = 0;
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startTs = Date.now();
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      if (pointerId == null || e.pointerId !== pointerId) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const dt = startTs > 0 ? Date.now() - startTs : 9999;
      reset();

      if (dt > 760) return;
      if (ax < 70 || ax <= ay * 1.25) return;
      void switchSessionRelative(dx < 0 ? 1 : -1, "swipe");
    };

    const onCancel = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      if (pointerId == null || e.pointerId !== pointerId) return;
      reset();
    };

    el.addEventListener("pointerdown", onDown, { passive: true });
    el.addEventListener("pointerup", onUp, { passive: true });
    el.addEventListener("pointercancel", onCancel, { passive: true });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
    };
  }, [tab, activeId, sessionSwitchOrder, activeIsCodexNative, activeSessionClosing]);

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

  async function loadSessionEvents(sessionId: string) {
    try {
      const r = await api<{ items: any[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/events?limit=220`);
      const rows = Array.isArray((r as any)?.items) ? (r as any).items : [];
      const parsed = rows.map(normalizeEvent).filter(Boolean) as EventItem[];
      setEvents(parsed);
    } catch {
      // ignore
    }
  }

  async function loadSessionTranscriptToTerm(sessionId: string) {
    try {
      const r = await api<{ items: { chunk: string }[] }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/transcript?limit=1200`,
      );
      const rows = Array.isArray((r as any)?.items) ? (r as any).items : [];
      const chunks = rows.map((x: any) => (typeof x?.chunk === "string" ? x.chunk : "")).filter(Boolean);
      if (!chunks.length) return;

      // Write in batches so mobile browsers stay responsive.
      const joined = chunks.join("");
      const batchSize = 24_000;
      for (let i = 0; i < joined.length; i += batchSize) {
        if (activeIdRef.current !== sessionId) return;
        term.current?.write(joined.slice(i, i + batchSize));
        // Yield to the browser event loop.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, 0));
      }
      try {
        (term.current as any)?.scrollToBottom?.();
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
  }

  function flushTermOutput() {
    const rec = termOutBuf.current;
    if (!rec || rec.chunks.length === 0) return;
    if (rec.timer) {
      clearTimeout(rec.timer);
      rec.timer = null;
    }
    const joined = rec.chunks.join("");
    rec.chunks = [];
    rec.bytes = 0;
    try {
      term.current?.write(joined);
    } catch {
      // ignore
    }
  }

  function queueTermOutput(chunk: string) {
    const rec = termOutBuf.current ?? { chunks: [], bytes: 0, timer: null };
    rec.chunks.push(chunk);
    rec.bytes += chunk.length;
    termOutBuf.current = rec;
    if (termReplay.current.inProgress) {
      // During transcript replay we buffer live output but avoid flushing so history
      // doesn't interleave with the replayed scrollback.
      if (rec.bytes > 900_000 && rec.chunks.length > 220) {
        rec.chunks = rec.chunks.slice(-220);
        rec.bytes = rec.chunks.reduce((n, s) => n + s.length, 0);
      }
      return;
    }
    if (rec.bytes > 96_000 || rec.chunks.length > 120) {
      flushTermOutput();
      return;
    }
    if (!rec.timer) {
      rec.timer = setTimeout(() => flushTermOutput(), 16);
    }
  }

  function startPing(sock: WebSocket) {
    return setInterval(() => {
      try {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      } catch {
        // ignore
      }
    }, 5000);
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
    // Only reset the terminal on an intentional session switch (attempt=0).
    // During reconnects we keep the current scrollback so the UI doesn't "blink" or lose history.
    if (attempt === 0) {
      try {
        if (termOutBuf.current?.timer) clearTimeout(termOutBuf.current.timer);
      } catch {
        // ignore
      }
      termOutBuf.current = null;
      term.current?.reset();
      term.current?.write("\u001b[2J\u001b[H");
      dismissedAssistSig.current = "";
      setTuiAssist(null);
    }

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const s = new WebSocket(`${proto}://${window.location.host}/ws/sessions/${id}`);
    ws.current = s;

    s.onmessage = (ev) => {
      try {
        if (ws.current !== s) return; // stale socket after a fast session switch
        const msg = JSON.parse(String(ev.data));
        if (msg?.type === "pong") return;
        if (msg?.type === "session.closing") {
          setSessionWsState("connecting");
          setToast("Session closing...");
          void refreshSessions();
          return;
        }
        if (msg?.type === "session.closed") {
          setSessionWsState("closed");
          if (activeIdRef.current === id) setActiveId(null);
          setToast("Session closed");
          void refreshSessions();
          void refreshWorkspaces();
          return;
        }
        if (msg?.type === "codex.native.delta" && typeof msg?.delta === "string") {
          const kind = typeof msg?.kind === "string" ? msg.kind : "agent";
          const threadId = typeof msg?.threadId === "string" ? msg.threadId : "";
          const turnId = typeof msg?.turnId === "string" ? msg.turnId : "";
          const itemId = typeof msg?.itemId === "string" ? msg.itemId : "";
          const delta = String(msg.delta ?? "");
          if (delta) {
            setCodexNativeLive((prev) => {
              if (!prev || prev.threadId !== threadId || prev.turnId !== turnId || prev.itemId !== itemId || prev.kind !== kind) {
                return { kind, threadId, turnId, itemId, text: delta };
              }
              return { ...prev, text: prev.text + delta };
            });
          }
          return;
        }
        if (msg?.type === "codex.native.diff" && typeof msg?.diff === "string") {
          setCodexNativeDiff(String(msg.diff ?? ""));
          return;
        }
        if (msg?.type === "codex.native.turn" && typeof msg?.event === "string") {
          const threadId = typeof msg?.threadId === "string" ? msg.threadId : "";
          if (msg.event === "started") {
            setCodexNativeLive(null);
            setCodexNativeDiff(null);
          }
          if (msg.event === "completed" && threadId) {
            setCodexNativeLive(null);
            void loadCodexNativeThread(threadId);
          }
          return;
        }
        if (msg.type === "output" && typeof msg.chunk === "string") queueTermOutput(msg.chunk);
        if (msg.type === "assist") {
          const a = (msg?.assist ?? null) as any;
          const sig = a && typeof a.signature === "string" ? String(a.signature) : "";
          if (sig && sig === dismissedAssistSig.current) return;
          setTuiAssist(a && typeof a.title === "string" && Array.isArray(a.options) ? (a as TuiAssist) : null);
        }
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
      flushTermOutput();

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
    dismissedAssistSig.current = "";
    setTuiAssist(null);
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

  function switchSessionRelative(delta: number, source: "swipe" | "button" = "button"): boolean {
    if (!activeId) return false;
    if (sessionSwitchOrder.length < 2) return false;
    const idx = sessionSwitchOrder.indexOf(activeId);
    if (idx < 0) return false;
    const step = delta >= 0 ? 1 : -1;
    const next = (idx + step + sessionSwitchOrder.length) % sessionSwitchOrder.length;
    const nextId = sessionSwitchOrder[next];
    if (!nextId || nextId === activeId) return false;
    const s = sessions.find((x) => x.id === nextId) ?? null;
    openSession(nextId);
    const label = String(s?.label || s?.profileId || s?.tool || "").trim();
    setToast(
      `${next + 1}/${sessionSwitchOrder.length}${label ? ` · ${label}` : ""}`,
    );
    if (source === "swipe") {
      try {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(8);
      } catch {
        // ignore
      }
    }
    return true;
  }

  async function removeSession(sessionId: string) {
    const sess = sessions.find((s) => s.id === sessionId) ?? null;
    if (!sess) return;
    const label = sess.label || sess.profileId || sessionId.slice(0, 8);
    const runningNote = sess.running ? "\n\nThis session is running and will be force-closed first." : "";
    const ok = window.confirm(
      `Remove session "${label}"?${runningNote}\n\nThis deletes the FromYourPhone record (terminal replay + inbox items). It does NOT delete ${sess.tool} chat logs stored by the tool.`,
    );
    if (!ok) return;

    // Optimistic UI so it disappears immediately.
    const remaining = sessions.filter((s) => s.id !== sessionId);
    setSessions(remaining);
    setWorkspaces((prev) =>
      prev.map((w) => ({
        ...w,
        sessions: (w.sessions ?? []).filter((s) => s.id !== sessionId),
      })),
    );
    setInbox((prev) => prev.filter((it) => it.sessionId !== sessionId));
    try {
      delete pendingInputBySession.current[sessionId];
    } catch {
      // ignore
    }

    // If the removed session was active, switch immediately to avoid reconnect loops.
    if (activeIdRef.current === sessionId) {
      const next = remaining[0]?.id ?? null;
      activeIdRef.current = next;
      setActiveId(next);
    }

    setShowControls(false);

    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}?force=1`, { method: "DELETE" });
      setToast(sess.running ? "Session closed and removed" : "Session removed");
    } catch (e: any) {
      setToast(typeof e?.message === "string" ? e.message : "remove failed");
    } finally {
      refreshSessions();
      refreshWorkspaces();
      refreshInbox({ workspaceKey: selectedWorkspaceKeyRef.current });
    }
  }

  async function sendControl(type: "interrupt" | "stop" | "kill") {
    if (!activeId) {
      setToast("No active session");
      return;
    }
    if (activeSessionClosing) {
      setToast("Session is closing");
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
    if (activeSessionClosing) {
      setToast("Session is closing");
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

  async function copyTermSelection() {
    const sel = (() => {
      try {
        return String(term.current?.getSelection?.() ?? "");
      } catch {
        return "";
      }
    })();
    if (!sel.trim()) {
      setToast("Select text in the terminal to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(sel);
      setToast("Copied");
    } catch {
      setToast("Copy failed (clipboard blocked; try HTTPS or long-press)");
    }
  }

  async function pasteClipboardToTerm() {
    if (!activeId) {
      setToast("No active session");
      return;
    }
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setToast("Paste failed (clipboard blocked; try HTTPS)");
      return;
    }
    if (!text) {
      setToast("Clipboard empty");
      return;
    }

    // Send directly so we can show a specific toast.
    if (ws.current && ws.current.readyState === WebSocket.OPEN && connectedSessionId.current === activeId) {
      ws.current.send(JSON.stringify({ type: "input", text }));
      setToast("Pasted");
      return;
    }
    try {
      const r: any = await api(`/api/sessions/${encodeURIComponent(activeId)}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (r?.event && activeIdRef.current === activeId) ingestEventRaw(r.event);
      setToast("Pasted");
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
    if (activeSessionClosing) {
      setToast("Session is closing");
      return;
    }
    const isCodexNative = activeSession?.tool === "codex" && String(activeSession?.transport ?? "pty") === "codex-app-server";
    const suffix = (() => {
      const pid = activeSession?.profileId ?? "";
      const p = pid ? profiles.find((x) => x.id === pid) ?? null : null;
      return typeof p?.sendSuffix === "string" ? p.sendSuffix : "\r";
    })();
    const full = isCodexNative ? text : text + suffix;

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

  async function startSessionWith(input: {
    tool: ToolId;
    profileId: string;
    transport?: string;
    cwd?: string;
    overrides?: any;
    savePreset?: boolean;
    toolAction?: "resume" | "fork";
    toolSessionId?: string;
  }) {
    try {
      const res = await api<{ id: string }>("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: input.tool,
          profileId: input.profileId,
          transport: input.transport,
          cwd: input.cwd,
          toolAction: input.toolAction,
          toolSessionId: input.toolSessionId,
          overrides: input.overrides ?? {},
          savePreset: typeof input.savePreset === "boolean" ? input.savePreset : false,
        }),
      });
      setToast("Session started");
      const rows = await refreshSessions();
      await refreshRecentWorkspaces();
      await refreshWorkspaces();
      openSession(res.id);
      void autoPinSession(res.id, rows);
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
      transport: tool === "codex" ? String((codexOpt as any).transport ?? "pty") : undefined,
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

  async function openToolChat(tool: ToolSessionTool, sessionId: string, opts?: { refresh?: boolean; limit?: number; keep?: boolean }) {
    setToolChatMsg(null);
    setToolChatLoading(true);
    const limit = Number.isFinite(Number(opts?.limit)) ? Math.floor(Number(opts?.limit)) : 240;
    const lim = Math.min(5000, Math.max(60, limit));
    setToolChatLimit(lim);
    if (!opts?.keep) {
      setToolChatMessages([]);
      setToolChatSession(null);
    }
    setShowToolChat(true);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(lim));
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

  async function loadCodexNativeThread(threadId: string) {
    if (!threadId) return;
    setCodexNativeMsg(null);
    setCodexNativeLoading(true);
    try {
      const r = await api<{ ok: true; thread: any }>(`/api/codex-native/threads/${encodeURIComponent(threadId)}`);
      setCodexNativeThread((r as any)?.thread ?? null);
    } catch (e: any) {
      setCodexNativeThread(null);
      setCodexNativeMsg(typeof e?.message === "string" ? e.message : "failed to load Codex thread");
    } finally {
      setCodexNativeLoading(false);
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
        transport: ts.tool === "codex" ? String((codexOpt as any).transport ?? "pty") : undefined,
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

  async function autoPinSession(sessionId: string, rows?: SessionRow[] | null) {
    if (!autoPinNew) return;
    const list = Array.isArray(rows) && rows.length ? rows : sessions;
    const sess = list.find((s) => s.id === sessionId) ?? null;
    if (!sess) return;
    const already = typeof sess.pinnedSlot === "number" ? sess.pinnedSlot : null;
    if (already && already >= 1 && already <= 6) return;

    const groupKey = String(sess.workspaceKey ?? (sess.cwd ? `dir:${sess.cwd}` : `dir:${sess.id}`));
    const used = new Set<number>();
    for (const s of list) {
      const g = String(s.workspaceKey ?? (s.cwd ? `dir:${s.cwd}` : `dir:${s.id}`));
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

    // Optimistic update: clear any other session in this group already in the chosen slot.
    setSessions((prev) =>
      prev.map((s) => {
        const g = String(s.workspaceKey ?? (s.cwd ? `dir:${s.cwd}` : `dir:${s.id}`));
        if (g !== groupKey) return s;
        if (s.id === sessionId) return { ...s, pinnedSlot: chosen };
        if (s.pinnedSlot === chosen) return { ...s, pinnedSlot: null };
        return s;
      }),
    );

    try {
      await setSessionMeta(sessionId, { pinnedSlot: chosen });
    } catch {
      // If pin fails (e.g. server rejected), re-sync.
      refreshSessions();
      refreshWorkspaces();
    }
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

  const codexNativeMessages = useMemo(() => {
    const thread = codexNativeThread;
    if (!thread) return [] as { id: string; role: "user" | "assistant"; kind: string; text: string; tone?: "default" | "thinking" | "toolUse" | "toolResult" }[];

    const out: { id: string; role: "user" | "assistant"; kind: string; text: string; tone?: "default" | "thinking" | "toolUse" | "toolResult" }[] = [];
    const seen = new Set<string>();

    const formatValue = (v: any): string => {
      if (v == null) return "";
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      try {
        return JSON.stringify(v, null, 2);
      } catch {
        return "";
      }
    };

    const textFrom = (v: any, depth = 0): string => {
      if (depth > 5) return "";
      if (v == null) return "";
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      if (Array.isArray(v)) return v.map((x) => textFrom(x, depth + 1)).filter(Boolean).join("\n");
      if (typeof v !== "object") return "";
      if (typeof (v as any).text === "string") return String((v as any).text);
      if (typeof (v as any).thinking === "string") return String((v as any).thinking);
      if (typeof (v as any).delta === "string") return String((v as any).delta);
      const te = (v as any).text_elements;
      if (Array.isArray(te)) return te.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join("");
      const summary = (v as any).summary;
      if (Array.isArray(summary)) return summary.map((x: any) => textFrom(x, depth + 1)).filter(Boolean).join("\n");
      if (typeof summary === "string") return summary;
      const content = (v as any).content;
      if (Array.isArray(content)) return content.map((x: any) => textFrom(x, depth + 1)).filter(Boolean).join("\n");
      if (typeof content === "string") return content;
      if (content && typeof content === "object") {
        const nested = textFrom(content, depth + 1);
        if (nested) return nested;
      }
      const output = (v as any).output;
      if (output != null) {
        const nested = textFrom(output, depth + 1);
        if (nested) return nested;
      }
      const result = (v as any).result;
      if (result != null) {
        const nested = textFrom(result, depth + 1);
        if (nested) return nested;
      }
      return "";
    };

    const normalizeText = (v: string): string => {
      const t = String(v ?? "").replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
      if (!t) return "";
      if (t.length <= 14000) return t;
      return `${t.slice(0, 13985)}\n...[truncated]`;
    };

    const push = (m: {
      id: string;
      role: "user" | "assistant";
      kind: string;
      text: string;
      tone?: "default" | "thinking" | "toolUse" | "toolResult";
    }) => {
      const text = normalizeText(m.text);
      if (!text) return;
      const sig = `${m.role}|${m.kind}|${m.id}|${text.slice(0, 180)}`;
      if (seen.has(sig)) return;
      seen.add(sig);
      out.push({ ...m, text });
    };

    const toolCallText = (item: any): string => {
      const name =
        typeof item?.name === "string"
          ? item.name
          : typeof item?.toolName === "string"
            ? item.toolName
            : typeof item?.functionName === "string"
              ? item.functionName
              : "";
      const args = item?.input ?? item?.arguments ?? item?.args ?? item?.payload ?? null;
      const head = name ? `Tool: ${name}` : "Tool call";
      const body = normalizeText(textFrom(args) || formatValue(args));
      return body ? `${head}\n${body}` : head;
    };

    const toolResultText = (item: any): string => {
      const raw = item?.result ?? item?.output ?? item?.response ?? item?.content ?? null;
      const body = normalizeText(textFrom(raw) || formatValue(raw));
      const errRaw = item?.error ?? (item?.is_error ? raw : null);
      const err = normalizeText(textFrom(errRaw) || formatValue(errRaw));
      if (err) return body ? `[error]\n${err}\n\n${body}` : `[error]\n${err}`;
      return body;
    };

    const turns = Array.isArray((thread as any).turns) ? ((thread as any).turns as any[]) : [];
    for (const turn of turns) {
      const turnId = typeof turn?.id === "string" ? String(turn.id) : "";

      const input = Array.isArray(turn?.input) ? (turn.input as any[]) : [];
      for (let i = 0; i < input.length; i++) {
        const it = input[i];
        if (it && typeof it === "object" && it.type === "text" && typeof it.text === "string") {
          push({ id: `${turnId}:in:${i}`, role: "user", kind: "input", text: String(it.text) });
        }
      }

      const items = Array.isArray(turn?.items)
        ? (turn.items as any[])
        : Array.isArray(turn?.output)
          ? (turn.output as any[])
          : Array.isArray(turn?.messages)
            ? (turn.messages as any[])
            : [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || typeof item !== "object") continue;

        const type =
          typeof item.type === "string"
            ? String(item.type)
            : typeof (item as any).kind === "string"
              ? String((item as any).kind)
              : "";
        const typeNorm = type.toLowerCase();
        const itemId = typeof item.id === "string" ? String(item.id) : `${turnId || "turn"}:${i}`;

        if (typeNorm === "usermessage" || typeNorm === "user_message") {
          push({
            id: itemId,
            role: "user",
            kind: "user",
            text: textFrom((item as any).text ?? (item as any).content ?? item),
          });
          continue;
        }
        if (typeNorm === "agentmessage" || typeNorm === "assistantmessage" || typeNorm === "assistant_message") {
          push({
            id: itemId,
            role: "assistant",
            kind: "assistant",
            text: textFrom((item as any).text ?? (item as any).content ?? item),
          });
          continue;
        }
        if (typeNorm === "reasoning" || typeNorm === "thinking") {
          const summaryText = textFrom((item as any).summary);
          const contentText = textFrom((item as any).content);
          push({
            id: itemId,
            role: "assistant",
            kind: "thinking",
            tone: "thinking",
            text: summaryText || contentText || textFrom(item),
          });
          continue;
        }
        if (typeNorm === "plan") {
          push({
            id: itemId,
            role: "assistant",
            kind: "plan",
            text: textFrom((item as any).text ?? (item as any).content ?? item),
          });
          continue;
        }
        if (typeNorm === "commandexecution" || typeNorm === "command_execution") {
          const cmd = typeof (item as any).command === "string" ? String((item as any).command) : "";
          const status = typeof (item as any).status === "string" ? String((item as any).status) : "";
          const t = cmd ? `$ ${cmd}${status ? `\n[${status}]` : ""}` : textFrom(item);
          push({ id: itemId, role: "assistant", kind: "command", text: t, tone: "toolUse" });
          continue;
        }
        if (typeNorm === "filechange" || typeNorm === "file_change") {
          const pathsRaw = Array.isArray((item as any).paths)
            ? (item as any).paths
            : Array.isArray((item as any).files)
              ? (item as any).files.map((f: any) => f?.path)
              : [];
          const paths = pathsRaw.map((x: any) => String(x ?? "")).filter(Boolean);
          const t = paths.length ? `Edits:\n- ${paths.join("\n- ")}` : textFrom(item);
          push({ id: itemId, role: "assistant", kind: "edits", text: t, tone: "toolResult" });
          continue;
        }

        const looksLikeToolUse =
          /tool.*(call|use)|(?:^|_)function(?:_|$).*(call|use)|mcp.*(call|use)|call_tool/.test(typeNorm) ||
          typeNorm === "toolcall" ||
          typeNorm === "functioncall";
        if (looksLikeToolUse) {
          push({
            id: itemId,
            role: "assistant",
            kind: "tool_use",
            tone: "toolUse",
            text: toolCallText(item),
          });
          continue;
        }

        const looksLikeToolResult =
          /tool.*(result|output)|(?:^|_)function(?:_|$).*(result|output)|mcp.*(result|output)|call_result/.test(typeNorm) ||
          typeNorm === "toolresult" ||
          typeNorm === "functioncalloutput";
        if (looksLikeToolResult) {
          push({
            id: itemId,
            role: "assistant",
            kind: "tool_result",
            tone: "toolResult",
            text: toolResultText(item),
          });
          continue;
        }

        const fallback = textFrom(item);
        if (fallback) {
          push({
            id: itemId,
            role: "assistant",
            kind: type || "message",
            text: fallback,
          });
        }
      }
    }

    return out;
  }, [codexNativeThread]);

  if (authed === "unknown") return <ConnectingScreen />;

  if (authed === "no") {
    return (
      <UnlockScreen
        token={token}
        setToken={setToken}
        pairCode={pairCode}
        setPairCode={setPairCode}
        pairMsg={pairMsg}
        unlockMsg={unlockMsg}
        onUnlock={() => {
          setPairMsg(null);
          setUnlockMsg(null);
          const tok = token.trim();
          if (!tok) {
            setUnlockMsg("Paste the long token from the host terminal.");
            return;
          }
          const u = new URL(window.location.href);
          u.searchParams.set("token", tok);
          window.location.href = u.toString();
        }}
        onRetry={() => window.location.reload()}
        onPair={async () => {
          setPairMsg(null);
          setUnlockMsg(null);
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
      />
    );
  }

  return (
    <div className="shell">
      <HeaderBar
        online={online}
        globalWsState={globalWsState}
        activeSession={activeSession}
        onOpenSettings={() => setTab("settings")}
      />

      <main className="stage">
        <section className="viewRun" hidden={tab !== "run"} aria-hidden={tab !== "run"}>
          {!activeId ? (
            <div className="emptyRun">
              <div className="emptyRunIcon">
                <svg viewBox="0 0 24 24" width="40" height="40"><polyline points="4 17 10 11 4 5" stroke="var(--faint)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/><line x1="12" y1="19" x2="20" y2="19" stroke="var(--faint)" strokeWidth="1.8" strokeLinecap="round"/></svg>
              </div>
              <div className="emptyTitle">No active session</div>
              <div className="emptySub">Tap below to start</div>
              <button className="btn primary" onClick={() => setTab("new")} style={{ marginTop: 8 }}>
                New Session
              </button>
            </div>
          ) : (
            <div className="run">
              <div className="runStrip">
                <PinnedSlotsBar
                  slots={slotCfg.slots}
                  activeId={activeId}
                  pinnedBySlot={pinnedBySlot}
                  onOpenSession={openSession}
                />
                {pinnedOrder.length < 2 && workspaceSessionsSorted.length > 1 ? (
                  <div className="pinBar">
                    {workspaceSessionsSorted.slice(0, 6).map((s, idx) => {
                      const on = s.id === activeId;
                      const hasAttention = (s.attention ?? 0) > 0;
                      return (
                        <button
                          key={s.id}
                          className={`pinPill ${on ? "pinPillOn" : ""}`}
                          onClick={() => openSession(s.id)}
                          aria-label={`Session ${idx + 1}: ${s.label || s.profileId}`}
                        >
                          <span className="pinPillNum">{idx + 1}</span>
                          <span className="pinPillLabel">{s.label || s.tool}</span>
                          {hasAttention ? <span className="pinPillDot" /> : null}
                          {s.running ? <span className="pinPillRun" /> : null}
                        </button>
                      );
                    })}
                    {workspaceSessionsSorted.length > 6 ? (
                      <span className="chip mono">+{workspaceSessionsSorted.length - 6}</span>
                    ) : null}
                  </div>
                ) : null}
                <div className="runInfo">
                  <div className={`dot ${activeSession?.running ? "dotOn" : "dotOff"}`}>
                    {activeSession?.running ? "RUN" : "IDLE"}
                  </div>
                  <span className="mono runLabel">
                    {activeSession?.label || activeSession?.profileId || ""}
                  </span>
                  {activeSessionClosing ? <span className="chip mono">closing</span> : null}
                  {sessionWsState !== "open" ? (
                    <span className="chip mono">
                      {sessionWsState === "connecting" ? "..." : "off"}
                    </span>
                  ) : null}
                  {!activeIsCodexNative && (activeSession?.tool === "codex" || activeSession?.tool === "claude") && !activeToolSessionId ? (
                    <span className="chip mono">linking…</span>
                  ) : null}
                  {activeInboxCount > 0 ? (
                    <button className="runAlert" onClick={() => { refreshInbox({ workspaceKey: activeWorkspaceKey }); setTab("inbox"); }}>
                      {activeInboxCount}
                    </button>
                  ) : null}
                  <div className="spacer" />
                  <button
                    className="runBtn"
                    onClick={() => switchSessionRelative(-1, "button")}
                    aria-label="Previous session"
                    disabled={sessionSwitchOrder.length < 2}
                    title="Previous session"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14">
                      <polyline points="10 3 5 8 10 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  </button>
                  <button
                    className="runBtn"
                    onClick={() => switchSessionRelative(1, "button")}
                    aria-label="Next session"
                    disabled={sessionSwitchOrder.length < 2}
                    title="Next session"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14">
                      <polyline points="6 3 11 8 6 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  </button>
                  <button className="runBtn" onClick={() => sendControl("interrupt")} aria-label="Ctrl+C">
                    <svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zM5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"/></svg>
                  </button>
                  {!activeIsCodexNative && (activeSession?.tool === "codex" || activeSession?.tool === "claude") ? (
                    <button
                      className="runBtn"
                      onClick={() => {
                        if (!activeCanOpenChatHistory) return;
                        const toolId = activeSession?.tool as any;
                        openToolChat(toolId, activeToolSessionId, { refresh: true, limit: toolChatLimit });
                      }}
                      aria-label="Chat history"
                      title={activeCanOpenChatHistory ? "Chat history" : "Chat history (linking...)"}
                      disabled={!activeCanOpenChatHistory}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14">
                        <path
                          d="M3 3.5h10v6H6.5L4 12V9.5H3v-6z"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                    </button>
                  ) : null}
                  <button className="runBtn" onClick={() => setShowControls(true)} aria-label="More">
                    <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="3" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="13" cy="8" r="1.3" fill="currentColor"/></svg>
                  </button>
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

              <div
                className={`termPanel ${activeIsCodexNative ? "termPanelNative" : "termPanelPty"}`}
                ref={runSurfaceRef}
              >
                {activeIsCodexNative ? (
                  <CodexNativeThreadView
                    threadId={String(activeSession?.toolSessionId ?? "")}
                    loading={codexNativeLoading}
                    error={codexNativeMsg}
                    messages={codexNativeMessages}
                    live={codexNativeLive}
                    diff={codexNativeDiff}
                    innerRef={nativeChatRef}
                  />
                ) : (
                  <>
                    <div className="term" ref={termRef} />
                    {activeIsRawTerminal && !activeAttention && tuiAssist ? (
                      <TerminalAssistOverlay
                        assist={tuiAssist}
                        onHide={() => {
                          dismissedAssistSig.current = String(tuiAssist.signature ?? "");
                          setTuiAssist(null);
                        }}
                        onSend={(send) => sendRaw(send)}
                      />
                    ) : null}
                  </>
                )}
              </div>

              <div
                className="compose"
                onClick={() => {
                  try {
                    composerRef.current?.focus();
                  } catch {
                    // ignore
                  }
                }}
              >
                <textarea
                  ref={composerRef}
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  placeholder="Message..."
                  disabled={!activeId || activeSessionClosing}
                  autoCapitalize="sentences"
                  autoCorrect="on"
                  spellCheck={false}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                  }}
                  onTouchStart={(e) => {
                    e.stopPropagation();
                  }}
                  onFocus={() => {
                    try {
                      (term.current as any)?.blur?.();
                    } catch {
                      // ignore
                    }
                  }}
                  rows={1}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendText();
                    }
                  }}
                />
                <button
                  className="composeSend"
                  onClick={sendText}
                  aria-label="Send"
                  disabled={!activeId || activeSessionClosing || !composer.trim()}
                >
                  <svg viewBox="0 0 20 20" width="18" height="18"><path d="M3 10l14-7-7 14v-7H3z" fill="currentColor"/></svg>
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
                </div>
                <button className="btn ghost" onClick={refreshWorkspaces}>
                  Refresh
                </button>
              </div>
              <div className="row">
                <input
                  value={workspaceQuery}
                  onChange={(e) => setWorkspaceQuery(e.target.value)}
                  placeholder="Search workspaces..."
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="searchInput"
                />
              </div>
              <div className="row" style={{ padding: 0 }}>
                <div className="list listScrollWorkspace">
                  {filteredWorkspaces.length === 0 ? (
                    <div className="row">
                      <div className="help">No matching workspaces yet. Start a session in New.</div>
                    </div>
                  ) : null}
	                  {filteredWorkspaces.map((w) => {
	                    const waiting = (w.sessions ?? []).reduce((acc, s) => acc + (s.attention ?? 0), 0);
	                    const on = selectedWorkspaceKey === w.key;
	                    const rootLabel = String(w.root || "").trim() || "(unknown)";
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
	                            <div className="listTitle mono">{rootLabel}</div>
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
	              {(() => {
	                const w = selectedWorkspaceKey ? mergedWorkspaces.find((x) => x.key === selectedWorkspaceKey) ?? null : null;
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
		                            const base = String(selectedTreePath || w.root || "").trim();
		                            if (!base || base === "(unknown)") {
		                              setToast("Workspace path unknown (legacy session). Pick a real path in New.");
		                              setTab("new");
		                              return;
		                            }
		                            if (base) {
		                              setCwd(base);
		                              setTab("new");
		                              setToast("Workspace loaded into New Session");
		                            }
		                          }}
		                        >
	                          New Session Here
	                        </button>
	                      </div>
	                    </div>

	                      {(() => {
	                        const base = String(selectedTreePath || w.root || "").trim();
	                        const have = new Set(profiles.map((p) => p.id));
	                        if (!base || base === "(unknown)") return null;
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
                                      onClick={() =>
                                        startSessionWith({
                                          tool: tp.tool,
                                          profileId: p.id,
                                          transport: tp.tool === "codex" ? String((codexOpt as any).transport ?? "pty") : undefined,
                                          cwd: base,
                                          savePreset: false,
                                        })
                                      }
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
	                      <div className="list listScrollSessions">
	                        {(() => {
	                          const groups = groupByRecent(
	                            w.sessions ?? [],
	                            (s) => String(s.treePath || s.cwd || w.root || "unknown"),
	                            (s) => Number(s.updatedAt ?? 0),
	                          );
	                          const labelForTree = (treePath: string): string =>
	                            treeLabel({ isGit: w.isGit, root: String(w.root || ""), trees }, treePath);

	                          return groups.map((g) => (
	                            <div key={g.key}>
	                              <div className="groupHdr">
	                                <span className="chip">{labelForTree(g.key)}</span>
	                                <span className="mono groupPath">{g.key}</span>
	                              </div>
	                              {g.items.map((s) => {
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
                                        {s.preview ? <div className="preview mono">{cleanPreviewLine(s.preview)}</div> : null}
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
                        const filtered = items.filter((ts) => {
                          if (!ts?.cwd) return false;
                          if (wsRoot && !isUnder(ts.cwd, wsRoot)) return false;
                          return true;
                        });
                        const groups = groupByRecent(
                          filtered,
                          (ts) => pickTreeRoot(String(ts.cwd)),
                          (ts) => Number(ts.updatedAt ?? 0),
                        );
                        const labelForTree = (treePath: string): string =>
                          treeLabel({ isGit: w.isGit, root: String(w.root || ""), trees }, treePath);

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
                              <div className="list listScrollToolSessions">
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
                                    {g.items.map((ts) => (
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
                                            {ts.preview ? <div className="preview mono">{cleanPreviewLine(ts.preview)}</div> : null}
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
                </div>
                <button className="btn ghost" onClick={() => refreshInbox({ workspaceKey: selectedWorkspaceKey })}>
                  Refresh
                </button>
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
                </div>
                <button className="btn ghost" onClick={() => setAdvanced((v) => !v)}>
                  {advanced ? "Less" : "More"}
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

              {tool === "codex" ? (
                <div className="row">
                  <div className="field">
                    <label>Codex Mode</label>
                    <div className="seg" role="group" aria-label="Codex mode">
                      <button
                        className={`segBtn ${String((codexOpt as any).transport ?? "pty") === "codex-app-server" ? "segOn" : ""}`}
                        onClick={() => setCodexOpt((p) => ({ ...p, transport: "codex-app-server" }))}
                      >
                        Native
                      </button>
                      <button
                        className={`segBtn ${String((codexOpt as any).transport ?? "pty") !== "codex-app-server" ? "segOn" : ""}`}
                        onClick={() => setCodexOpt((p) => ({ ...p, transport: "pty" }))}
                      >
                        Terminal
                      </button>
                    </div>
                    <div className="help">Native uses Codex App Server (chat-first). Terminal streams the real Codex TUI (compatibility mode).</div>
                  </div>
                </div>
              ) : null}

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
                  {advanced ? (
                    <>
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
                          Apply
                        </button>
                      </div>
                      {presetMsg ? <div className="help mono">{presetMsg}</div> : null}
                    </>
                  ) : null}
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
                  <div className="cardTitle">This Device</div>
                  <div className="cardSub">Clear the saved cookie and re-auth.</div>
                </div>
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      await api("/api/auth/logout", { method: "POST" });
                    } catch {
                      // ignore
                    } finally {
                      window.location.reload();
                    }
                  }}
                >
                  Forget
                </button>
              </div>
              <div className="row">
                <div className="help">Useful when the phone “never asks for token” because it’s already paired.</div>
              </div>
            </div>
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
	                <label className="toggle" style={{ margin: 0 }}>
	                  <input type="checkbox" checked={autoPinNew} onChange={(e) => setAutoPinNew(e.target.checked)} />
	                  <span className="muted">Auto-pin new sessions</span>
	                </label>
	              </div>
	              <div className="row">
	                <div className="help">
	                  Pin/unpin from Workspace. Swipe left/right in Run to switch sessions (pinned first; otherwise recent sessions in this workspace).
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
                </div>
                <div className="doctorBox">
                  <div className="doctorTitle">claude</div>
                  <div className="mono muted">{doctor?.tools.claude.version ?? ""}</div>
                </div>
                <div className="doctorBox">
                  <div className="doctorTitle">opencode</div>
                  <div className="mono muted">{doctor?.tools.opencode.version ?? ""}</div>
                </div>
              </div>
              {doctor?.app?.version ? (
                <div className="help mono" style={{ wordBreak: "break-all" }}>
                  App: {doctor.app.name ?? "fromyourphone"}@{doctor.app.version} · node {doctor.process?.node ?? ""} · pid {doctor.process?.pid ?? ""}
                </div>
              ) : null}
              {doctor?.app?.webRoot ? (
                <div className="help mono" style={{ wordBreak: "break-all" }}>
                  Web: {doctor.app.webRoot}
                </div>
              ) : null}
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

      <BottomNav
        tab={tab}
        inboxCount={workspaceInboxCount}
        onSetTab={setTab}
        onOpenInbox={() => {
          refreshInbox({ workspaceKey: selectedWorkspaceKey });
          setTab("inbox");
        }}
      />

      <PickerModal
        open={showPicker}
        path={pickPath}
        parent={pickParent}
        entries={pickEntries}
        showHidden={pickShowHidden}
        onClose={() => setShowPicker(false)}
        onUse={(p) => {
          setCwd(p);
          setShowPicker(false);
          setToast("Workspace selected");
        }}
        onSetPath={setPickPath}
        onGo={(p) => loadPicker(p)}
        onUp={(p) => loadPicker(p)}
        onToggleHidden={async (next) => {
          setPickShowHidden(next);
          await loadPicker(pickPath, { showHidden: next });
        }}
      />

      <ConfigModal
        open={showConfig}
        toml={configToml}
        msg={configMsg}
        onChange={setConfigToml}
        onClose={() => setShowConfig(false)}
        onSave={saveConfig}
      />
      <ModelPickerModal
        open={showModelPicker}
        providers={modelProviders}
        provider={modelProvider}
        query={modelQuery}
        models={modelList}
        loading={modelLoading}
        msg={modelListMsg}
        selectedModel={String(opencodeOpt.model || "").trim()}
        onClose={() => setShowModelPicker(false)}
        onProviderChange={setModelProvider}
        onQueryChange={setModelQuery}
        onReload={async () => {
          await loadOpenCodeModels({ provider: "" });
          setToast("Loaded models");
        }}
        onRefresh={async () => {
          await loadOpenCodeModels({ provider: "", refresh: true });
          setToast("Refreshed models");
        }}
        onClear={() => {
          setOpenCodeOpt((p) => ({ ...p, model: "" }));
          setToast("Model cleared");
          setShowModelPicker(false);
        }}
        onSelect={(s) => {
          setOpenCodeOpt((p) => ({ ...p, model: s }));
          setToast(`Selected: ${s}`);
          setShowModelPicker(false);
        }}
      />

      <ToolChatModal
        open={showToolChat}
        session={toolChatSession}
        messages={toolChatMessages}
        loading={toolChatLoading}
        msg={toolChatMsg}
        limit={toolChatLimit}
        onClose={() => setShowToolChat(false)}
        onOlder={() => {
          if (!toolChatSession) return;
          return openToolChat(toolChatSession.tool, toolChatSession.id, { limit: Math.min(5000, toolChatLimit * 2), keep: true });
        }}
        onAll={() => {
          if (!toolChatSession) return;
          return openToolChat(toolChatSession.tool, toolChatSession.id, { limit: 5000, keep: true });
        }}
        onRefresh={() => {
          if (!toolChatSession) return;
          return openToolChat(toolChatSession.tool, toolChatSession.id, { refresh: true, limit: toolChatLimit, keep: true });
        }}
        onResume={() => {
          if (!toolChatSession) return;
          return startFromToolSession(toolChatSession, "resume");
        }}
        onFork={() => {
          if (!toolChatSession) return;
          return startFromToolSession(toolChatSession, "fork");
        }}
      />

      <LogModal open={showLog} events={events} onClose={() => setShowLog(false)} />

      <ControlsModal
        open={showControls}
        activeSession={activeSession}
        labelDraft={labelDraft}
        setLabelDraft={setLabelDraft}
        fontSize={fontSize}
        setFontSize={setFontSize}
        lineHeight={lineHeight}
        setLineHeight={setLineHeight}
        onClose={() => setShowControls(false)}
        onOpenLog={() => {
          setShowControls(false);
          setShowLog(true);
        }}
        onOpenChat={() => {
          const t = activeSession?.tool ?? null;
          const sid = String(activeSession?.toolSessionId ?? "");
          if ((t !== "codex" && t !== "claude") || !sid) {
            setToast("Chat history not linked yet");
            return;
          }
          setShowControls(false);
          openToolChat(t, sid);
        }}
        onSaveLabel={async () => {
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
        onClearLabel={() => setLabelDraft("")}
        onFit={() => fit.current?.fit()}
        onCopy={copyTermSelection}
        onPaste={pasteClipboardToTerm}
        onSendRaw={sendRaw}
        onRemoveSession={() => {
          if (!activeSession?.id) return;
          removeSession(activeSession.id);
        }}
        onKill={() => {
          sendControl("kill");
          setShowControls(false);
        }}
      />

      {toast ? <div className="toast mono">{toast}</div> : null}
    </div>
  );
}
