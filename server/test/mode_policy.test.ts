import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app";

type TestHarness = {
  app: Awaited<ReturnType<typeof buildApp>>;
  dir: string;
  restoreEnv: () => void;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(40);
  }
  throw new Error("timeout waiting for condition");
}

async function testApp(opts?: { terminalMode?: "enabled" | "disabled" }): Promise<TestHarness> {
  const prevMode = process.env.FYP_ENABLE_TERMINAL_MODE;
  if (opts?.terminalMode === "enabled") process.env.FYP_ENABLE_TERMINAL_MODE = "1";
  if (opts?.terminalMode === "disabled") process.env.FYP_ENABLE_TERMINAL_MODE = "0";

  const here = path.dirname(fileURLToPath(import.meta.url));
  const fake = path.join(here, "fixtures", "fake_tool.mjs");
  const tool = { command: process.execPath, args: [fake] };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-mode-"));
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

  return {
    app,
    dir,
    restoreEnv: () => {
      if (prevMode == null) delete (process.env as any).FYP_ENABLE_TERMINAL_MODE;
      else process.env.FYP_ENABLE_TERMINAL_MODE = prevMode;
    },
  };
}

describe("mode policy and active task filtering", () => {
  test("terminal mode is disabled by default and idle tasks are hidden unless requested", async () => {
    const { app, dir, restoreEnv } = await testApp({ terminalMode: "disabled" });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ tool: "codex", profileId: "codex.default", savePreset: false }),
      });
      expect(created.statusCode).toBe(200);
      const createdBody = JSON.parse(created.payload) as any;
      const id = String(createdBody?.id ?? "");
      const taskId = String(createdBody?.taskId ?? "");
      expect(id).toBeTruthy();
      expect(taskId).toBeTruthy();

      const featureResp = await app.inject({
        method: "GET",
        url: "/api/features",
        headers: { authorization: "Bearer t123" },
      });
      expect(featureResp.statusCode).toBe(200);
      expect(JSON.parse(featureResp.payload)?.features?.terminalModeEnabled).toBe(false);

      const denySessionMode = await app.inject({
        method: "PATCH",
        url: `/api/sessions/${encodeURIComponent(id)}/mode`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ mode: "terminal" }),
      });
      expect(denySessionMode.statusCode).toBe(409);
      expect(JSON.parse(denySessionMode.payload)?.error).toBe("terminal_mode_disabled");

      const denyTaskMode = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${encodeURIComponent(taskId)}/mode`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ mode: "terminal" }),
      });
      expect(denyTaskMode.statusCode).toBe(409);

      const kill = await app.inject({
        method: "POST",
        url: `/api/sessions/${encodeURIComponent(id)}/kill`,
        headers: { authorization: "Bearer t123" },
      });
      expect(kill.statusCode).toBe(200);

      await waitFor(async () => {
        const r = await app.inject({
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(id)}`,
          headers: { authorization: "Bearer t123" },
        });
        const j = JSON.parse(r.payload) as any;
        return Boolean(j?.status && j.status.running === false);
      });

      const tasksDefault = await app.inject({
        method: "GET",
        url: "/api/tasks",
        headers: { authorization: "Bearer t123" },
      });
      expect(tasksDefault.statusCode).toBe(200);
      const defaultItems = (JSON.parse(tasksDefault.payload) as any)?.items ?? [];
      expect(Array.isArray(defaultItems)).toBe(true);
      expect(defaultItems.some((t: any) => String(t?.id ?? "") === taskId)).toBe(false);

      const tasksIncludeIdle = await app.inject({
        method: "GET",
        url: "/api/tasks?includeIdle=1",
        headers: { authorization: "Bearer t123" },
      });
      expect(tasksIncludeIdle.statusCode).toBe(200);
      const idleItems = (JSON.parse(tasksIncludeIdle.payload) as any)?.items ?? [];
      expect(idleItems.some((t: any) => String(t?.id ?? "") === taskId)).toBe(true);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      restoreEnv();
    }
  }, 20_000);

  test("terminal mode can be explicitly enabled", async () => {
    const { app, dir, restoreEnv } = await testApp({ terminalMode: "enabled" });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ tool: "codex", profileId: "codex.default", savePreset: false }),
      });
      expect(created.statusCode).toBe(200);
      const createdBody = JSON.parse(created.payload) as any;
      const id = String(createdBody?.id ?? "");
      expect(id).toBeTruthy();

      const featureResp = await app.inject({
        method: "GET",
        url: "/api/features",
        headers: { authorization: "Bearer t123" },
      });
      expect(featureResp.statusCode).toBe(200);
      expect(JSON.parse(featureResp.payload)?.features?.terminalModeEnabled).toBe(true);

      const setMode = await app.inject({
        method: "PATCH",
        url: `/api/sessions/${encodeURIComponent(id)}/mode`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ mode: "terminal" }),
      });
      expect(setMode.statusCode).toBe(200);
      expect(JSON.parse(setMode.payload)?.mode).toBe("terminal");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      restoreEnv();
    }
  }, 20_000);
});
