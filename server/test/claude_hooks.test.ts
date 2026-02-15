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

describe("Claude hooks bridge", () => {
  test("PermissionRequest hook creates an inbox item and returns a decision", async () => {
    const { app, dir } = await testApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { authorization: "Bearer t123", "content-type": "application/json" },
      payload: JSON.stringify({ tool: "claude", profileId: "claude.default", savePreset: false }),
    });
    expect(created.statusCode).toBe(200);
    const sessionId = JSON.parse(created.payload).id as string;
    expect(typeof sessionId).toBe("string");

    const hookReq = await app.inject({
      method: "POST",
      url: "/hooks/claude/permission-request",
      headers: { authorization: "Bearer t123", "content-type": "application/json" },
      payload: JSON.stringify({
        sessionId,
        payload: {
          tool_name: "Bash",
          tool_input: { command: "echo hi" },
          permission_suggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
        },
      }),
    });
    expect(hookReq.statusCode).toBe(200);
    const hookBody = JSON.parse(hookReq.payload) as any;
    expect(hookBody.ok).toBe(true);
    const signature = String(hookBody.signature ?? "");
    expect(signature.includes(sessionId)).toBe(true);

    const inboxRes = await app.inject({
      method: "GET",
      url: `/api/inbox?sessionId=${encodeURIComponent(sessionId)}&limit=50`,
      headers: { authorization: "Bearer t123" },
    });
    expect(inboxRes.statusCode).toBe(200);
    const inboxItems = (JSON.parse(inboxRes.payload).items ?? []) as any[];
    expect(inboxItems.length).toBeGreaterThan(0);
    const item = inboxItems.find((x) => String(x.signature ?? "") === signature) ?? inboxItems[0]!;
    expect(item && typeof item.id === "number").toBe(true);

    const responded = await app.inject({
      method: "POST",
      url: `/api/inbox/${encodeURIComponent(String(item.id))}/respond`,
      headers: { authorization: "Bearer t123", "content-type": "application/json" },
      payload: JSON.stringify({ optionId: "y" }),
    });
    expect(responded.statusCode).toBe(200);

    const decisionRes = await app.inject({
      method: "GET",
      url:
        `/hooks/claude/permission-decision?sessionId=${encodeURIComponent(sessionId)}` +
        `&signature=${encodeURIComponent(signature)}`,
      headers: { authorization: "Bearer t123" },
    });
    expect(decisionRes.statusCode).toBe(200);
    const d = JSON.parse(decisionRes.payload) as any;
    expect(d.ok).toBe(true);
    expect(d.decision).toMatchObject({ behavior: "allow" });

    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

