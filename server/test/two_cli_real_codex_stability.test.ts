import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(120);
  }
  throw new Error("timeout waiting for condition");
}

function resolveCodexBinary(): string | null {
  const fromEnv = String(process.env.FYP_REAL_CODEX_BIN || "").trim();
  const candidate = fromEnv || "codex";
  const r = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  return r.status === 0 ? candidate : null;
}

async function readEvents(app: any, sessionId: string, limit = 260): Promise<any[]> {
  const t = await app.inject({
    method: "GET",
    url: `/api/sessions/${encodeURIComponent(sessionId)}/events?limit=${limit}`,
    headers: { authorization: "Bearer t123" },
  });
  const b = JSON.parse(t.payload) as any;
  return Array.isArray(b?.items) ? b.items : [];
}

describe("two-cli real codex stability", () => {
  const enabled = process.env.FYP_REAL_CODEX_TEST === "1";
  const codexBin = resolveCodexBinary();
  const run = enabled && codexBin ? test : test.skip;

  run("uses real codex process for orchestrator<->worker safe dispatch smoke", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-real-codex-two-cli-root-"));
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "README.md"), "real-codex two-cli smoke\n", "utf8");

    const here = path.dirname(fileURLToPath(import.meta.url));
    const fake = path.join(here, "fixtures", "fake_tool.mjs");
    const tools = {
      codex: { command: String(codexBin), args: [] as string[] },
      claude: { command: process.execPath, args: [fake] as string[] },
      opencode: { command: process.execPath, args: [fake] as string[] },
    };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-real-codex-two-cli-db-"));
    const app = await buildApp({
      token: "t123",
      dataDir,
      tools,
      workspaces: { roots: [root] },
      profiles: {
        "codex.default": {
          tool: "codex",
          title: "Codex: Real Safe",
          codex: {
            sandbox: "read-only",
            askForApproval: "never",
            noAltScreen: true,
          },
          startup: [],
          sendSuffix: "\r",
        },
        "claude.default": { tool: "claude", title: "Claude: Default", startup: [], sendSuffix: "\r" },
        "opencode.default": { tool: "opencode", title: "OpenCode: Default", startup: [], sendSuffix: "\r" },
      },
    });
    await app.ready();

    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/orchestrations",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          name: "real-codex-two-cli",
          projectPath: project,
          autoWorktrees: false,
          dispatchMode: "orchestrator-first",
          autoDispatchInitialPrompts: false,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt:
              "SAFETY TEST MODE. Do not edit files or run heavy commands. Dispatch short tokens to Worker A and verify delivery.",
          },
          workers: [
            {
              name: "Worker A",
              taskPrompt:
                "SAFETY TEST MODE. Do not edit files. Reply only with requested tokens from orchestrator dispatch messages.",
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

      const sessions = await app.inject({
        method: "GET",
        url: "/api/sessions?includeInternal=1",
        headers: { authorization: "Bearer t123" },
      });
      expect(sessions.statusCode).toBe(200);
      const sessionsBody = JSON.parse(sessions.payload) as any;
      const all = Array.isArray(sessionsBody) ? sessionsBody : [];
      expect(all.length).toBe(2);

      await waitFor(async () => {
        const workerEvents = await readEvents(app, workerSessionId, 360);
        return workerEvents.some(
          (e: any) => String(e?.kind) === "input" && String(e?.data?.text ?? "").includes("WAIT MODE"),
        );
      }, 95_000);
      await waitFor(async () => {
        const orchestratorEvents = await readEvents(app, orchestratorSessionId, 360);
        return orchestratorEvents.some(
          (e: any) => String(e?.kind) === "input" && String(e?.data?.text ?? "").includes("ORCHESTRATOR QUICKSTART"),
        );
      }, 95_000);

      const marker = "REAL-CODEX-PING-001";
      const inlineDispatch = `FYP_DISPATCH_JSON: {"target":"worker:Worker A","text":"${marker}. Reply exactly REAL-CODEX-PONG-001 and nothing else."}`;
      const inResp = await app.inject({
        method: "POST",
        url: `/api/sessions/${encodeURIComponent(orchestratorSessionId)}/input`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ text: `${inlineDispatch}\r` }),
      });
      expect(inResp.statusCode).toBe(200);

      await waitFor(async () => {
        const workerEvents = await readEvents(app, workerSessionId, 360);
        return workerEvents.some((e: any) => String(e?.kind) === "input" && String(e?.data?.text ?? "").includes(marker));
      }, 95_000);

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
    } finally {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
});
