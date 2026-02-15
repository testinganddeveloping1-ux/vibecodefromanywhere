import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(40);
  }
  throw new Error("timeout waiting for condition");
}

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

describe("sessions delete", () => {
  test("refuses deletion while running, deletes after stop", async () => {
    const { app, dir } = await testApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { authorization: "Bearer t123", "content-type": "application/json" },
      payload: JSON.stringify({ tool: "codex", profileId: "codex.default", savePreset: false }),
    });
    expect(created.statusCode).toBe(200);
    const id = JSON.parse(created.payload).id as string;
    expect(typeof id).toBe("string");

    const denied = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${encodeURIComponent(id)}`,
      headers: { authorization: "Bearer t123" },
    });
    expect(denied.statusCode).toBe(409);

    const intr = await app.inject({
      method: "POST",
      url: `/api/sessions/${encodeURIComponent(id)}/interrupt`,
      headers: { authorization: "Bearer t123" },
    });
    expect(intr.statusCode).toBe(200);

    await waitFor(async () => {
      const r = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(id)}`,
        headers: { authorization: "Bearer t123" },
      });
      if (r.statusCode !== 200) return false;
      const j = JSON.parse(r.payload);
      return Boolean(j?.status && j.status.running === false);
    }, 5000);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${encodeURIComponent(id)}`,
      headers: { authorization: "Bearer t123" },
    });
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.payload)?.ok).toBe(true);

    const after = await app.inject({
      method: "GET",
      url: `/api/sessions/${encodeURIComponent(id)}`,
      headers: { authorization: "Bearer t123" },
    });
    expect(after.statusCode).toBe(404);

    const list = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { authorization: "Bearer t123" },
    });
    expect(list.statusCode).toBe(200);
    const items = JSON.parse(list.payload) as any[];
    expect(items.some((s) => s && s.id === id)).toBe(false);

    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});

