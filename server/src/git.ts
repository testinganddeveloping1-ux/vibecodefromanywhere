import path from "node:path";
import { execCapture } from "./tools/exec.js";

export type GitResolveResult =
  | {
      ok: true;
      // Root of the current worktree (what `git rev-parse --show-toplevel` returns).
      treeRoot: string;
      // Absolute .git directory for the current worktree (`git rev-parse --absolute-git-dir`).
      absGitDir: string;
      // Stable key across worktrees (derived from absGitDir).
      workspaceKey: string;
      // Best-effort workspace root for display/grouping.
      workspaceRoot: string;
      // True if this cwd is a linked worktree (not the main checkout).
      isLinkedWorktree: boolean;
    }
  | { ok: false; reason: string };

function isAbs(p: string): boolean {
  // We only target Linux/macOS in this repo currently; keep it simple.
  return p.startsWith("/") || /^[a-zA-Z]:\\/.test(p);
}

function commonDirFromAbsGitDir(absGitDir: string): { workspaceKey: string; isLinkedWorktree: boolean } {
  // Worktree gitdir looks like: /repo/.git/worktrees/<name>
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const idx = absGitDir.indexOf(marker);
  if (idx >= 0) return { workspaceKey: absGitDir.slice(0, idx + `${path.sep}.git`.length), isLinkedWorktree: true };
  return { workspaceKey: absGitDir, isLinkedWorktree: false };
}

function workspaceRootFromKey(workspaceKey: string, treeRoot: string): string {
  // Typical case: workspaceKey ends in "/.git"
  const base = path.basename(workspaceKey);
  if (base === ".git") return path.dirname(workspaceKey);
  return treeRoot;
}

export async function resolveGitForPath(cwd: string): Promise<GitResolveResult> {
  // 1) Find worktree root
  const top = await execCapture("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 1200 });
  if (!top.ok) return { ok: false, reason: "not_a_git_repo" };
  const treeRoot = top.stdout.trim();
  if (!treeRoot || !isAbs(treeRoot)) return { ok: false, reason: "bad_show_toplevel" };

  // 2) Find absolute git dir
  const gd = await execCapture("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"], { timeoutMs: 1200 });
  if (!gd.ok) return { ok: false, reason: "bad_git_dir" };
  const absGitDir = gd.stdout.trim();
  if (!absGitDir || !isAbs(absGitDir)) return { ok: false, reason: "bad_abs_git_dir" };

  const { workspaceKey, isLinkedWorktree } = commonDirFromAbsGitDir(absGitDir);
  const workspaceRoot = workspaceRootFromKey(workspaceKey, treeRoot);
  return { ok: true, treeRoot, absGitDir, workspaceKey, workspaceRoot, isLinkedWorktree };
}

export type GitWorktreeInfo = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
};

export async function listGitWorktrees(anyWorktreeRoot: string): Promise<{ ok: true; items: GitWorktreeInfo[] } | { ok: false; reason: string }> {
  const r = await execCapture("git", ["-C", anyWorktreeRoot, "worktree", "list", "--porcelain"], { timeoutMs: 1800 });
  if (!r.ok) return { ok: false, reason: "worktree_list_failed" };

  const items: GitWorktreeInfo[] = [];
  let cur: Partial<GitWorktreeInfo> | null = null;
  const flush = () => {
    if (!cur?.path) return;
    items.push({
      path: String(cur.path),
      head: cur.head ?? null,
      branch: cur.branch ?? null,
      detached: Boolean(cur.detached),
      locked: Boolean(cur.locked),
      prunable: Boolean(cur.prunable),
    });
    cur = null;
  };

  const lines = r.stdout.split("\n");
  for (const raw of lines) {
    const ln = raw.trimEnd();
    if (!ln) {
      flush();
      continue;
    }
    if (ln.startsWith("worktree ")) {
      flush();
      cur = { path: ln.slice("worktree ".length).trim(), detached: false, locked: false, prunable: false };
      continue;
    }
    if (!cur) continue;

    if (ln.startsWith("HEAD ")) cur.head = ln.slice("HEAD ".length).trim();
    else if (ln.startsWith("branch ")) cur.branch = ln.slice("branch ".length).trim();
    else if (ln === "detached") cur.detached = true;
    else if (ln === "locked") cur.locked = true;
    else if (ln === "prunable") cur.prunable = true;
  }
  flush();

  return { ok: true, items };
}

export function pickTreeRootForPath(cwd: string, trees: GitWorktreeInfo[]): string | null {
  const norm = path.resolve(cwd);
  let best: string | null = null;
  for (const t of trees) {
    const tp = path.resolve(t.path);
    const rel = path.relative(tp, norm);
    const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (!inside) continue;
    if (!best || tp.length > best.length) best = tp;
  }
  return best;
}

