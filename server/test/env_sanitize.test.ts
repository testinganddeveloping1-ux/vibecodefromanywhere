import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitTranscriptContains(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
  needle: string,
  tries = 30,
): Promise<string> {
  let joined = "";
  for (let i = 0; i < tries; i += 1) {
    const tr = await app.inject({
      method: "GET",
      url: `/api/sessions/${encodeURIComponent(sessionId)}/transcript?limit=50`,
      headers: { authorization: "Bearer t123" },
    });
    expect(tr.statusCode).toBe(200);
    const items = JSON.parse(tr.payload).items as Array<{ chunk: string }>;
    joined = items.map((x) => x.chunk).join("");
    if (joined.includes(needle)) break;
    await sleep(100);
  }
  return joined;
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

    try {
      await app.ready();

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ tool: "codex", profileId: "codex.default", savePreset: false }),
      });
      expect(created.statusCode).toBe(200);
      const id = JSON.parse(created.payload).id as string;

      const joined = await waitTranscriptContains(app, id, "CODEX_THREAD_ID=");

      expect(joined).toContain("CODEX_THREAD_ID=");
      expect(joined).not.toContain("CODEX_THREAD_ID=pinned-thread-id");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      if (prev == null) delete (process.env as any).CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = prev;
      if (prevPrint == null) delete (process.env as any).FYP_PRINT_CODEX_THREAD_ID;
      else process.env.FYP_PRINT_CODEX_THREAD_ID = prevPrint;
    }
  }, 30_000);

  test("claude subscription mode strips API key by default but keeps it in explicit api mode", async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevPrint = process.env.FYP_PRINT_ANTHROPIC_API_KEY;
    const prevMode = process.env.FYP_CLAUDE_AUTH_MODE;
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    process.env.FYP_PRINT_ANTHROPIC_API_KEY = "1";
    delete (process.env as any).FYP_CLAUDE_AUTH_MODE;

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

    try {
      await app.ready();

      const subCreated = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ tool: "claude", profileId: "claude.default", savePreset: false }),
      });
      expect(subCreated.statusCode).toBe(200);
      const subId = JSON.parse(subCreated.payload).id as string;
      const subJoined = await waitTranscriptContains(app, subId, "ANTHROPIC_API_KEY=");
      expect(subJoined).toContain("ANTHROPIC_API_KEY=");
      expect(subJoined).not.toContain("ANTHROPIC_API_KEY=anthropic-test-key");

      const apiCreated = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          tool: "claude",
          profileId: "claude.default",
          savePreset: false,
          overrides: { claude: { authMode: "api" } },
        }),
      });
      expect(apiCreated.statusCode).toBe(200);
      const apiId = JSON.parse(apiCreated.payload).id as string;
      const apiJoined = await waitTranscriptContains(app, apiId, "ANTHROPIC_API_KEY=");
      expect(apiJoined).toContain("ANTHROPIC_API_KEY=anthropic-test-key");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      if (prevKey == null) delete (process.env as any).ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevPrint == null) delete (process.env as any).FYP_PRINT_ANTHROPIC_API_KEY;
      else process.env.FYP_PRINT_ANTHROPIC_API_KEY = prevPrint;
      if (prevMode == null) delete (process.env as any).FYP_CLAUDE_AUTH_MODE;
      else process.env.FYP_CLAUDE_AUTH_MODE = prevMode;
    }
  }, 30_000);
});
