import { describe, expect, test } from "vitest";
import os from "node:os";
import { isUnderRoot, normalizeRoots } from "../src/workspaces";

describe("workspaces", () => {
  test("normalizeRoots resolves and dedupes", () => {
    const roots = normalizeRoots(["/tmp", "/tmp/", "/var/../tmp"]);
    expect(roots.length).toBe(1);
  });

  test("normalizeRoots expands ~", () => {
    const roots = normalizeRoots(["~", os.homedir()]);
    expect(roots.length).toBe(1);
  });

  test("isUnderRoot rejects traversal outside", () => {
    expect(isUnderRoot("/a/b", "/a")).toBe(true);
    expect(isUnderRoot("/a/../etc", "/a")).toBe(false);
  });
});
