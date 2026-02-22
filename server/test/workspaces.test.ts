import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDir, isUnderRoot, normalizeRoots } from "../src/workspaces";

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

  test("createDir creates folder and is idempotent for existing dirs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-workspace-test-"));
    try {
      const first = createDir(root, "alpha", [root]);
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.created).toBe(true);
        expect(fs.existsSync(first.path)).toBe(true);
      }

      const second = createDir(root, "alpha", [root]);
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.created).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("createDir rejects invalid folder names", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-workspace-test-"));
    try {
      const bad = createDir(root, "nested/name", [root]);
      expect(bad.ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
