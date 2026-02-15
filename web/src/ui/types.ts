export type ToolId = "codex" | "claude" | "opencode";
export type TabId = "run" | "workspace" | "inbox" | "new" | "settings";

export type Profile = { id: string; tool: ToolId; title: string; sendSuffix: string };

export type SessionRow = {
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

export type WorktreeInfo = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
};

export type WorkspaceItem = {
  key: string;
  root: string;
  isGit: boolean;
  trees: WorktreeInfo[];
  sessions: SessionRow[];
  lastUsed: number;
};

export type InboxItem = {
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

export type TuiAssist = {
  title: string;
  body: string | null;
  signature: string;
  options: { id: string; label: string; send: string }[];
};

export type ToolSessionTool = "codex" | "claude";
export type ToolSessionSummary = {
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

export type ToolSessionMessage = { role: "user" | "assistant"; ts: number; text: string };

export type Doctor = {
  tools: {
    codex: { sandboxModes: string[]; approvalPolicies: string[]; supports: any; version?: string };
    claude: { permissionModes: string[]; supports: any; version?: string };
    opencode: { supports: any; version?: string };
  };
  workspaceRoots: string[];
};

export type EventItem = { id: number; ts: number; kind: string; data: any };
export type RecentWorkspace = { path: string; lastUsed: number };

