import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("session env sanitization", () => {
  test("does not leak CODEX_THREAD_ID into spawned codex sessions", async () => {
    const prev = process.env.CODEX_THREAD_ID;
    const prevPrint = process.env.FYP_PRINT_CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = "pinned-thread-id";
    process.env.FYP_PRINT_CODEX_THREAD_ID = "1";

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-"));
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fake = path.join(here, "fixtures", "fake_tool.mjs");
    const tool = { command: process.execPath, args: [fake] };

    const app = await buildApp({
      token: "t123",
      dataDir: dir,
      tools: { codex: tool, claude: tool, opencode: tool },
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
      payload: JSON.stringify({ tool: "codex", profileId: "codex.default", savePreset: false }),
    });
    expect(created.statusCode).toBe(200);
    const id = JSON.parse(created.payload).id as string;

    // Give node-pty a moment to emit output and for the server to persist it.
    await sleep(120);
    const tr = await app.inject({
      method: "GET",
      url: `/api/sessions/${encodeURIComponent(id)}/transcript?limit=50`,
      headers: { authorization: "Bearer t123" },
    });
    expect(tr.statusCode).toBe(200);
    const items = JSON.parse(tr.payload).items as Array<{ chunk: string }>;
    const joined = items.map((x) => x.chunk).join("");
    expect(joined).toContain("CODEX_THREAD_ID=");
    expect(joined).not.toContain("CODEX_THREAD_ID=pinned-thread-id");

    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev == null) delete (process.env as any).CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = prev;
    if (prevPrint == null) delete (process.env as any).FYP_PRINT_CODEX_THREAD_ID;
    else process.env.FYP_PRINT_CODEX_THREAD_ID = prevPrint;
  }, 15_000);
});
