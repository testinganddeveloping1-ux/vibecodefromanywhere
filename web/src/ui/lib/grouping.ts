import type { WorktreeInfo } from "../types";

export type RecentGroup<T> = {
  key: string;
  last: number;
  items: T[];
};

export function groupByRecent<T>(
  items: T[],
  keyOf: (item: T) => string,
  updatedAtOf: (item: T) => number,
): RecentGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = String(keyOf(it) ?? "").trim();
    if (!k) continue;
    const arr = map.get(k);
    if (arr) arr.push(it);
    else map.set(k, [it]);
  }

  const groups: RecentGroup<T>[] = Array.from(map.entries()).map(([key, arr]) => ({
    key,
    last: Math.max(0, ...arr.map((x) => Number(updatedAtOf(x) ?? 0))),
    items: arr.sort((a, b) => Number(updatedAtOf(b) ?? 0) - Number(updatedAtOf(a) ?? 0)),
  }));
  groups.sort((a, b) => b.last - a.last);
  return groups;
}

export function treeLabel(opts: { isGit: boolean; root: string; trees: WorktreeInfo[] }, treePath: string): string {
  if (!opts.isGit) return "dir";
  if (treePath === opts.root) return "main";
  const wt = opts.trees.find((t) => t.path === treePath) ?? null;
  if (wt?.branch) return wt.branch.replace(/^refs\/heads\//, "");
  if (wt?.detached) return "detached";
  return "tree";
}
