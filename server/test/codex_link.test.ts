import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("codex tool session linking", () => {
  test("links by recent updatedAt even if tool session createdAt is old", async () => {
    const prevHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-home-"));
    process.env.HOME = home;

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-"));

    const workspace = path.join(home, "proj");
    fs.mkdirSync(workspace, { recursive: true });

    // Fake Codex session log (first line = session_meta). Make the createdAt old but file mtime recent.
    const toolSessionId = "019c0000-0000-7000-8000-000000000001";
    const codexDir = path.join(home, ".codex", "sessions", "2026", "02", "15");
    fs.mkdirSync(codexDir, { recursive: true });
    const fp = path.join(codexDir, `rollout-2026-02-15T00-00-00-${toolSessionId}.jsonl`);
    const oldIso = "2025-01-01T00:00:00.000Z";
    fs.writeFileSync(
      fp,
      JSON.stringify({
        timestamp: oldIso,
        type: "session_meta",
        payload: {
          id: toolSessionId,
          timestamp: oldIso,
          cwd: workspace,
          originator: "codex_cli_rs",
          cli_version: "0.101.0",
          source: "cli",
          model_provider: "openai",
        },
      }) + "\n",
      "utf8",
    );
    const now = new Date();
    fs.utimesSync(fp, now, now);

    const here = path.dirname(fileURLToPath(import.meta.url));
    const fake = path.join(here, "fixtures", "fake_tool.mjs");
    const tool = { command: process.execPath, args: [fake] };

    const app = await buildApp({
      token: "t123",
      dataDir,
      tools: { codex: tool, claude: tool, opencode: tool },
      workspaces: { roots: [home] },
      profiles: {
        "codex.default": { tool: "codex", title: "Codex: Default", startup: [], sendSuffix: "\r" },
        "claude.default": { tool: "claude", title: "Claude: Default", startup: [], sendSuffix: "\r" },
        "opencode.default": { tool: "opencode", title: "OpenCode: Default", startup: [], sendSuffix: "\r" },
      },
    });
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { authorization: "Bearer t123", "content-type": "application/json" },
      payload: JSON.stringify({ tool: "codex", profileId: "codex.default", cwd: workspace, savePreset: false }),
    });
    expect(created.statusCode).toBe(200);
    const id = JSON.parse(created.payload).id as string;
    expect(typeof id).toBe("string");

    // Wait for the async linker to populate toolSessionId.
    const deadline = Date.now() + 6000;
    let linked: any = null;
    while (Date.now() < deadline) {
      const r = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(id)}`,
        headers: { authorization: "Bearer t123" },
      });
      const j = JSON.parse(r.payload) as any;
      if (j?.toolSessionId === toolSessionId) {
        linked = j;
        break;
      }
      await sleep(60);
    }
    expect(linked?.toolSessionId).toBe(toolSessionId);

    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    if (prevHome != null) process.env.HOME = prevHome;
    else delete (process.env as any).HOME;
  }, 15_000);
});

