import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app";

describe("model overrides", () => {
  test("passes codex and claude model overrides to spawned session args", async () => {
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

      const codexCreate = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          tool: "codex",
          profileId: "codex.default",
          savePreset: false,
          overrides: { codex: { model: "gpt-5.3-codex-high" } },
        }),
      });
      expect(codexCreate.statusCode).toBe(200);
      const codexId = JSON.parse(codexCreate.payload).id as string;

      const codexEvents = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(codexId)}/events?limit=40`,
        headers: { authorization: "Bearer t123" },
      });
      expect(codexEvents.statusCode).toBe(200);
      const codexItems = JSON.parse(codexEvents.payload).items as Array<{ kind: string; data?: any }>;
      const codexCreated = codexItems.find((e) => e.kind === "session.created");
      expect(Array.isArray(codexCreated?.data?.args)).toBe(true);
      expect(codexCreated?.data?.args).toContain("--model");
      expect(codexCreated?.data?.args).toContain("gpt-5.3-codex-high");

      const claudeCreate = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          tool: "claude",
          profileId: "claude.default",
          savePreset: false,
          overrides: { claude: { model: "claude-opus-4-6-thinking" } },
        }),
      });
      expect(claudeCreate.statusCode).toBe(200);
      const claudeId = JSON.parse(claudeCreate.payload).id as string;

      const claudeEvents = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(claudeId)}/events?limit=40`,
        headers: { authorization: "Bearer t123" },
      });
      expect(claudeEvents.statusCode).toBe(200);
      const claudeItems = JSON.parse(claudeEvents.payload).items as Array<{ kind: string; data?: any }>;
      const claudeCreated = claudeItems.find((e) => e.kind === "session.created");
      expect(Array.isArray(claudeCreated?.data?.args)).toBe(true);
      expect(claudeCreated?.data?.args).toContain("--model");
      expect(claudeCreated?.data?.args).toContain("claude-opus-4-6-thinking");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

