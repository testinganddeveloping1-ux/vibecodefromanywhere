import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { sanitizeClaudeCommand } from "../src/tools/resolve.js";

function writeExecutable(filePath: string, contents: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function mkPathEnv(paths: string[]): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: paths.join(path.delimiter),
  };
}

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sanitizeClaudeCommand", () => {
  test("skips antigravity wrapper on PATH and picks clean claude binary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-claude-wrap-"));
    tempRoots.push(root);
    const first = path.join(root, "first");
    const second = path.join(root, "second");

    writeExecutable(
      path.join(first, "claude"),
      "#!/usr/bin/env bash\n# antigravity wrapper\nexec /home/me/claude-antigravity \"$@\"\n",
    );
    writeExecutable(path.join(second, "claude"), "#!/usr/bin/env bash\necho real claude\n");

    const env = mkPathEnv([first, second, String(process.env.PATH ?? "")]);
    const out = sanitizeClaudeCommand({ command: "claude", args: [] }, { env, allowWrapper: false });

    expect(out.command).toBe(path.join(second, "claude"));
    expect(out.args).toEqual([]);
    expect(out.changed).toBe(true);
    expect(out.warnings.join(" ")).toMatch(/wrapper/i);
  });

  test("drops explicit antigravity args and falls back to clean claude", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-claude-wrap-"));
    tempRoots.push(root);
    const bin = path.join(root, "bin");
    writeExecutable(path.join(bin, "claude"), "#!/usr/bin/env bash\necho real claude\n");

    const env = mkPathEnv([bin, String(process.env.PATH ?? "")]);
    const out = sanitizeClaudeCommand(
      { command: "/tmp/claude-antigravity.sh", args: ["--proxy", "antigravity"] },
      { env, allowWrapper: false },
    );

    expect(out.command).toBe(path.join(bin, "claude"));
    expect(out.args).toEqual([]);
    expect(out.changed).toBe(true);
  });

  test("respects allow-wrapper override", () => {
    const out = sanitizeClaudeCommand(
      { command: "/tmp/claude-antigravity.sh", args: ["--proxy", "antigravity"] },
      { allowWrapper: true },
    );
    expect(out.command).toBe("/tmp/claude-antigravity.sh");
    expect(out.args).toEqual(["--proxy", "antigravity"]);
    expect(out.changed).toBe(false);
  });
});

