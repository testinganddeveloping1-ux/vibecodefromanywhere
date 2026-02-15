import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app";

async function testApp() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fake = path.join(here, "fixtures", "fake_tool.mjs");
  const tool = { command: process.execPath, args: [fake] };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-"));
  const app = await buildApp({
    token: "t123",
    dataDir: dir,
    tools: { codex: tool, claude: tool, opencode: tool },
    profiles: {
      "codex.default": { tool: "codex", title: "Codex: Default", codex: { noAltScreen: true }, startup: [], sendSuffix: "\r" },
      "claude.default": { tool: "claude", title: "Claude: Default", startup: [], sendSuffix: "\r" },
      "opencode.default": { tool: "opencode", title: "OpenCode: Default", startup: [], sendSuffix: "\r" },
    },
  });
  await app.ready();
  return { app, dir };
}

describe("OpenCode models", () => {
  test("lists models via opencode models", async () => {
    const { app, dir } = await testApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/opencode/models",
      headers: { authorization: "Bearer t123" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as any;
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toContain("opencode/kimi-k2.5-free");
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

