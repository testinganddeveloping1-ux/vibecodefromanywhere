import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error("timeout waiting for condition");
}

async function readTranscriptText(app: any, sessionId: string): Promise<string> {
  const t = await app.inject({
    method: "GET",
    url: `/api/sessions/${encodeURIComponent(sessionId)}/transcript`,
    headers: { authorization: "Bearer t123" },
  });
  const b = JSON.parse(t.payload) as any;
  return String((b?.items ?? []).map((it: any) => String(it?.chunk ?? "")).join(""));
}

async function readEvents(app: any, sessionId: string, limit = 200): Promise<any[]> {
  const t = await app.inject({
    method: "GET",
    url: `/api/sessions/${encodeURIComponent(sessionId)}/events?limit=${limit}`,
    headers: { authorization: "Bearer t123" },
  });
  const b = JSON.parse(t.payload) as any;
  return Array.isArray(b?.items) ? b.items : [];
}

async function testApp(root: string) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fake = path.join(here, "fixtures", "fake_tool.mjs");
  const tool = { command: process.execPath, args: [fake] };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-two-cli-db-"));
  const app = await buildApp({
    token: "t123",
    dataDir: dir,
    tools: { codex: tool, claude: tool, opencode: tool },
    workspaces: { roots: [root] },
    profiles: {
      "codex.default": { tool: "codex", title: "Codex: Default", codex: { noAltScreen: true }, startup: [], sendSuffix: "\r" },
      "claude.default": { tool: "claude", title: "Claude: Default", startup: [], sendSuffix: "\r" },
      "opencode.default": { tool: "opencode", title: "OpenCode: Default", startup: [], sendSuffix: "\r" },
    },
  });
  await app.ready();
  return { app, dir };
}

describe("two-cli communication stability", () => {
  test("orchestrator and single worker exchange dispatch messages reliably with low load", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-two-cli-root-"));
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "README.md"), "two-cli smoke\n", "utf8");

    const { app, dir } = await testApp(root);
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/orchestrations",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          name: "two-cli-smoke",
          projectPath: project,
          autoWorktrees: false,
          dispatchMode: "orchestrator-first",
          autoDispatchInitialPrompts: false,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt:
              "SAFETY TEST MODE: do not modify files. Dispatch short prompt tokens to Worker A and verify delivery only.",
          },
          workers: [
            {
              name: "Worker A",
              taskPrompt:
                "SAFETY TEST MODE: do not edit files or run heavy commands. Accept orchestrator prompt tokens and acknowledge briefly.",
            },
          ],
        }),
      });
      expect(create.statusCode).toBe(200);
      const created = JSON.parse(create.payload) as any;
      const orchestrationId = String(created?.id ?? "");
      const orchestratorSessionId = String(created?.orchestratorSessionId ?? "");
      const workerSessionId = String(created?.workers?.[0]?.sessionId ?? "");
      expect(orchestrationId).toBeTruthy();
      expect(orchestratorSessionId).toBeTruthy();
      expect(workerSessionId).toBeTruthy();
      expect(Array.isArray(created?.workers)).toBe(true);
      expect(created.workers.length).toBe(1);

      const sessions = await app.inject({
        method: "GET",
        url: "/api/sessions?includeInternal=1",
        headers: { authorization: "Bearer t123" },
      });
      expect(sessions.statusCode).toBe(200);
      const sessionsBody = JSON.parse(sessions.payload) as any;
      const items = Array.isArray(sessionsBody) ? sessionsBody : [];
      expect(items.length).toBe(2);

      await waitFor(async () => (await readTranscriptText(app, workerSessionId)).includes("WAIT MODE"));
      await waitFor(async () => (await readTranscriptText(app, orchestratorSessionId)).includes("ORCHESTRATOR QUICKSTART"));

      const pings = ["PING-1 minimal", "PING-2 stable", "PING-3 verified"];
      for (const ping of pings) {
        const msg = `FYP_DISPATCH_JSON: {"target":"worker:Worker A","text":"${ping}"}`;
        const sent = await app.inject({
          method: "POST",
          url: `/api/sessions/${encodeURIComponent(orchestratorSessionId)}/input`,
          headers: { authorization: "Bearer t123", "content-type": "application/json" },
          payload: JSON.stringify({ text: `${msg}\r` }),
        });
        expect(sent.statusCode).toBe(200);
        await waitFor(async () => (await readTranscriptText(app, workerSessionId)).includes(ping));
      }

      const progress = await app.inject({
        method: "GET",
        url: `/api/orchestrations/${encodeURIComponent(orchestrationId)}/progress`,
        headers: { authorization: "Bearer t123" },
      });
      expect(progress.statusCode).toBe(200);
      const progressBody = JSON.parse(progress.payload) as any;
      expect(progressBody?.item?.startup?.state).toBe("running");
      expect(Array.isArray(progressBody?.item?.startup?.dispatchedSessionIds)).toBe(true);
      expect(progressBody.item.startup.dispatchedSessionIds.includes(workerSessionId)).toBe(true);

      await waitFor(async () => {
        const orchEvents = await readEvents(app, orchestratorSessionId, 320);
        const dispatchEvents = orchEvents.filter((e: any) => String(e?.kind) === "orchestration.dispatch");
        return dispatchEvents.length >= pings.length;
      });

      const workerEvents = await readEvents(app, workerSessionId, 260);
      const workerInputs = workerEvents.filter((e: any) => String(e?.kind) === "input");
      for (const ping of pings) {
        const found = workerInputs.some((e: any) => String(e?.data?.text ?? "").includes(ping));
        expect(found).toBe(true);
      }

      const inbox = await app.inject({
        method: "GET",
        url: "/api/inbox?status=open&limit=20",
        headers: { authorization: "Bearer t123" },
      });
      expect(inbox.statusCode).toBe(200);
      const inboxBody = JSON.parse(inbox.payload) as any;
      expect(Array.isArray(inboxBody?.items)).toBe(true);
      expect(inboxBody.items.length).toBe(0);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("send-task endpoint initializes first worker dispatch and supports follow-up interrupt dispatches", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-send-task-root-"));
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "README.md"), "send-task smoke\n", "utf8");

    const { app, dir } = await testApp(root);
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/orchestrations",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          name: "send-task-smoke",
          projectPath: project,
          autoWorktrees: false,
          dispatchMode: "orchestrator-first",
          autoDispatchInitialPrompts: false,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "coordinate worker dispatches safely",
          },
          workers: [
            {
              name: "Worker A",
              taskPrompt: "Do lightweight acknowledgements only.",
            },
          ],
        }),
      });
      expect(create.statusCode).toBe(200);
      const created = JSON.parse(create.payload) as any;
      const orchestrationId = String(created?.id ?? "");
      const workerSessionId = String(created?.workers?.[0]?.sessionId ?? "");
      expect(orchestrationId).toBeTruthy();
      expect(workerSessionId).toBeTruthy();

      const first = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(orchestrationId)}/send-task`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          target: `session:${workerSessionId}`,
          task: "SEND-TASK-ONE",
          initialize: true,
          interrupt: false,
        }),
      });
      expect(first.statusCode).toBe(200);
      const firstBody = JSON.parse(first.payload) as any;
      expect(firstBody?.ok).toBe(true);
      expect(firstBody?.mode).toBe("send-task");
      expect(Number(firstBody?.count?.sent ?? 0)).toBe(1);
      expect(Boolean(firstBody?.sent?.[0]?.injectedBootstrap)).toBe(true);

      await waitFor(async () => (await readTranscriptText(app, workerSessionId)).includes("SEND-TASK-ONE"));

      const second = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(orchestrationId)}/send-task`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          target: "worker:Worker A",
          task: "SEND-TASK-TWO",
          initialize: true,
          interrupt: true,
        }),
      });
      expect(second.statusCode).toBe(200);
      const secondBody = JSON.parse(second.payload) as any;
      expect(secondBody?.ok).toBe(true);
      expect(Number(secondBody?.count?.sent ?? 0)).toBe(1);
      expect(Boolean(secondBody?.sent?.[0]?.injectedBootstrap)).toBe(false);
      expect(Boolean(secondBody?.sent?.[0]?.interruptRequested)).toBe(true);

      await waitFor(async () => (await readTranscriptText(app, workerSessionId)).includes("SEND-TASK-TWO"));
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
