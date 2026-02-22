import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type WorkspaceRoots = {
  roots: string[];
};

export function normalizeRoots(roots: string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    if (!r || typeof r !== "string") continue;
    const rr = path.resolve(expandHome(r));
    if (!out.includes(rr)) out.push(rr);
  }
  return out;
}

function expandHome(p: string): string {
  // Support common "~" usage in paths entered from phones.
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function isUnderRoot(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function validateCwd(input: string, roots: string[]): { ok: true; cwd: string } | { ok: false; reason: string } {
  if (!input || typeof input !== "string") return { ok: false, reason: "cwd is empty" };
  const cwd = path.resolve(expandHome(input));
  let st: fs.Stats;
  try {
    st = fs.statSync(cwd);
  } catch {
    return { ok: false, reason: "cwd does not exist" };
  }
  if (!st.isDirectory()) return { ok: false, reason: "cwd is not a directory" };

  const normRoots = normalizeRoots(roots);
  if (normRoots.length === 0) return { ok: true, cwd };
  if (!normRoots.some((r) => isUnderRoot(cwd, r))) return { ok: false, reason: "cwd is outside allowed roots" };
  return { ok: true, cwd };
}

export type DirEntry = { name: string; path: string; kind: "dir" | "file" };

export function createDir(
  parentDir: string,
  name: string,
  roots: string[],
): { ok: true; path: string; created: boolean } | { ok: false; reason: string } {
  const parent = validateCwd(parentDir, roots);
  if (!parent.ok) return parent;

  const raw = typeof name === "string" ? name.trim() : "";
  if (!raw) return { ok: false, reason: "folder name is empty" };
  if (raw === "." || raw === "..") return { ok: false, reason: "invalid folder name" };
  if (raw.includes("/") || raw.includes("\\")) return { ok: false, reason: "folder name cannot include path separators" };
  if (raw.includes("\u0000")) return { ok: false, reason: "folder name contains invalid characters" };

  const target = path.resolve(parent.cwd, raw);
  const normRoots = normalizeRoots(roots);
  if (normRoots.length > 0 && !normRoots.some((r) => isUnderRoot(target, r))) {
    return { ok: false, reason: "target is outside allowed roots" };
  }

  try {
    const st = fs.statSync(target);
    if (!st.isDirectory()) return { ok: false, reason: "a non-directory already exists with that name" };
    return { ok: true, path: target, created: false };
  } catch {
    // does not exist yet
  }

  try {
    fs.mkdirSync(target, { recursive: false });
  } catch {
    return { ok: false, reason: "cannot create directory" };
  }
  return { ok: true, path: target, created: true };
}

export function listDir(
  dir: string,
  roots: string[],
  opts?: { showHidden?: boolean },
): { ok: true; dir: string; parent: string | null; entries: DirEntry[] } | { ok: false; reason: string } {
  const v = validateCwd(dir, roots);
  if (!v.ok) return v;
  const cwd = v.cwd;
  let names: string[] = [];
  try {
    names = fs.readdirSync(cwd);
  } catch {
    return { ok: false, reason: "cannot read directory" };
  }

  const entries: DirEntry[] = [];
  for (const name of names) {
    if (!opts?.showHidden && name.startsWith(".")) continue;
    const p = path.join(cwd, name);
    try {
      const st = fs.statSync(p);
      entries.push({ name, path: p, kind: st.isDirectory() ? "dir" : "file" });
    } catch {
      // ignore
    }
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));

  // parent is only useful if it stays inside roots
  const parent = path.dirname(cwd);
  const normRoots = normalizeRoots(roots);
  const parentOk = normRoots.length === 0 ? true : normRoots.some((r) => isUnderRoot(parent, r));
  return { ok: true, dir: cwd, parent: parentOk ? parent : null, entries };
}
