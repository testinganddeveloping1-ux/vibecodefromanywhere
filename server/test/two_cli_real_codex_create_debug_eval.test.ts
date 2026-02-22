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

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(180);
  }
  throw new Error("timeout waiting for condition");
}

function resolveCodexBinary(): string | null {
  const fromEnv = String(process.env.FYP_REAL_CODEX_BIN || "").trim();
  const candidate = fromEnv || "codex";
  const r = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  return r.status === 0 ? candidate : null;
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

async function readEvents(app: any, sessionId: string, limit = 600): Promise<any[]> {
  const t = await app.inject({
    method: "GET",
    url: `/api/sessions/${encodeURIComponent(sessionId)}/events?limit=${limit}`,
    headers: { authorization: "Bearer t123" },
  });
  const b = JSON.parse(t.payload) as any;
  return Array.isArray(b?.items) ? b.items : [];
}

function dispatchIncludesSession(events: any[], targetSessionId: string): boolean {
  return events.some((e: any) => {
    if (String(e?.kind) !== "orchestration.dispatch") return false;
    const sent = Array.isArray(e?.data?.sent) ? e.data.sent.map((v: any) => String(v)) : [];
    return sent.includes(String(targetSessionId));
  });
}

describe("two-cli real codex create/debug/eval scenario", () => {
  const enabled = process.env.FYP_REAL_CODEX_SCENARIO_TEST === "1";
  const codexBin = resolveCodexBinary();
  const run = enabled && codexBin ? test : test.skip;

  run(
    "runs two workers in sandbox folder: create bug, debug/fix, and verify output",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-real-codex-scenario-root-"));
      const project = path.join(root, "project");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, "README.md"), "real codex scenario sandbox\n", "utf8");

      const here = path.dirname(fileURLToPath(import.meta.url));
      const fake = path.join(here, "fixtures", "fake_tool.mjs");
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-real-codex-scenario-db-"));
      const startedAt = Date.now();

      const app = await buildApp({
        token: "t123",
        dataDir,
        tools: {
          codex: { command: String(codexBin), args: [] },
          claude: { command: process.execPath, args: [fake] },
          opencode: { command: process.execPath, args: [fake] },
        },
        workspaces: { roots: [root] },
        profiles: {
          "codex.default": {
            tool: "codex",
            title: "Codex: Real Scenario",
            codex: {
              sandbox: "workspace-write",
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
            name: "real-codex-create-debug-eval",
            projectPath: project,
            autoWorktrees: false,
            dispatchMode: "orchestrator-first",
            autoDispatchInitialPrompts: false,
            automation: {
              questionMode: "orchestrator",
              steeringMode: "passive_review",
              yoloMode: false,
            },
            orchestrator: {
              tool: "codex",
              profileId: "codex.default",
              prompt:
                "Coordinate Worker A then Worker B. Avoid interruptions while active. Review only on question or completion cues.",
            },
            workers: [
              {
                name: "Worker A",
                tool: "codex",
                profileId: "codex.default",
                taskPrompt: "Wait for orchestrator release.",
              },
              {
                name: "Worker B",
                tool: "codex",
                profileId: "codex.default",
                taskPrompt: "Wait for orchestrator release.",
              },
            ],
          }),
        });

        expect(create.statusCode).toBe(200);
        const created = JSON.parse(create.payload) as any;
        const orchestrationId = String(created?.id ?? "");
        const orchestratorSessionId = String(created?.orchestratorSessionId ?? "");
        const workerASessionId = String(created?.workers?.[0]?.sessionId ?? "");
        const workerBSessionId = String(created?.workers?.[1]?.sessionId ?? "");
        expect(orchestrationId).toBeTruthy();
        expect(orchestratorSessionId).toBeTruthy();
        expect(workerASessionId).toBeTruthy();
        expect(workerBSessionId).toBeTruthy();

        await waitFor(async () => {
          const ev = await readEvents(app, workerASessionId, 360);
          return ev.some((e: any) => String(e?.kind) === "input" && String(e?.data?.text ?? "").includes("WAIT MODE"));
        }, 160_000);
        await waitFor(async () => {
          const ev = await readEvents(app, workerBSessionId, 360);
          return ev.some((e: any) => String(e?.kind) === "input" && String(e?.data?.text ?? "").includes("WAIT MODE"));
        }, 160_000);

        const workerATask = [
          "Task A: create buggy sandbox file and report completion.",
          "1) Create `sandbox-demo/calculator.js` with EXACT content:",
          "module.exports = { add: (a, b) => a - b };",
          "2) Run: node -e \"const c=require('./sandbox-demo/calculator.js'); console.log('before', c.add(2,3))\"",
          "3) Update `.agents/tasks/worker-1-worker-a.md` and `.fyp/task.md` with BUG|ROOT|FIX|TEST|RESULT notes.",
          "4) Final line EXACTLY: WORKER_A_DONE",
        ].join("\n");
        const dispatchA = `FYP_DISPATCH_JSON: ${JSON.stringify({
          target: "worker:Worker A",
          text: workerATask,
        })}`;
        const sendA = await app.inject({
          method: "POST",
          url: `/api/sessions/${encodeURIComponent(orchestratorSessionId)}/input`,
          headers: { authorization: "Bearer t123", "content-type": "application/json" },
          payload: JSON.stringify({ text: `${dispatchA}\r` }),
        });
        expect(sendA.statusCode).toBe(200);

        const calcPath = path.join(project, "sandbox-demo", "calculator.js");
        let workerADispatchObserved = false;
        try {
          await waitFor(async () => {
            const ev = await readEvents(app, orchestratorSessionId, 900);
            return dispatchIncludesSession(ev, workerASessionId);
          }, 90_000);
          workerADispatchObserved = true;
        } catch {
          workerADispatchObserved = false;
        }
        if (!workerADispatchObserved) {
          const fallbackA = await app.inject({
            method: "POST",
            url: `/api/orchestrations/${encodeURIComponent(orchestrationId)}/dispatch`,
            headers: { authorization: "Bearer t123", "content-type": "application/json" },
            payload: JSON.stringify({ target: "worker:Worker A", text: workerATask }),
          });
          expect(fallbackA.statusCode).toBe(200);
        }
        await waitFor(() => fs.existsSync(calcPath), 300_000);
        const workerATaskFile = path.join(project, ".agents", "tasks", "worker-1-worker-a.md");
        await waitFor(() => fs.existsSync(workerATaskFile), 300_000);

        const workerBTask = [
          "Task B: debug and fix Worker A output, then verify.",
          "1) Inspect `sandbox-demo/calculator.js` and fix `add` so 2+3 returns 5.",
          "2) Run: node -e \"const c=require('./sandbox-demo/calculator.js'); console.log('after', c.add(2,3))\"",
          "3) Update `.agents/tasks/worker-2-worker-b.md` and `.fyp/task.md` with BUG|ROOT|FIX|TEST|RESULT notes.",
          "4) If blocked ask one QUESTION packet. If not blocked, final line EXACTLY: WORKER_B_DONE",
        ].join("\n");
        const dispatchB = `FYP_DISPATCH_JSON: ${JSON.stringify({
          target: "worker:Worker B",
          text: workerBTask,
        })}`;
        const sendB = await app.inject({
          method: "POST",
          url: `/api/sessions/${encodeURIComponent(orchestratorSessionId)}/input`,
          headers: { authorization: "Bearer t123", "content-type": "application/json" },
          payload: JSON.stringify({ text: `${dispatchB}\r` }),
        });
        expect(sendB.statusCode).toBe(200);

        let workerBDispatchObserved = false;
        try {
          await waitFor(async () => {
            const ev = await readEvents(app, orchestratorSessionId, 900);
            return dispatchIncludesSession(ev, workerBSessionId);
          }, 90_000);
          workerBDispatchObserved = true;
        } catch {
          workerBDispatchObserved = false;
        }
        if (!workerBDispatchObserved) {
          const fallbackB = await app.inject({
            method: "POST",
            url: `/api/orchestrations/${encodeURIComponent(orchestrationId)}/dispatch`,
            headers: { authorization: "Bearer t123", "content-type": "application/json" },
            payload: JSON.stringify({ target: "worker:Worker B", text: workerBTask }),
          });
          expect(fallbackB.statusCode).toBe(200);
        }

        await waitFor(() => {
          if (!fs.existsSync(calcPath)) return false;
          const evalRun = spawnSync(
            process.execPath,
            [
              "-e",
              `const c=require(${JSON.stringify(calcPath)}); process.stdout.write(String(c.add(2,3)));`,
            ],
            { encoding: "utf8" },
          );
          return evalRun.status === 0 && String(evalRun.stdout || "").trim() === "5";
        }, 300_000);

        expect(fs.existsSync(calcPath)).toBe(true);
        const evalRun = spawnSync(
          process.execPath,
          [
            "-e",
            `const c=require(${JSON.stringify(calcPath)}); process.stdout.write(String(c.add(2,3)));`,
          ],
          { encoding: "utf8" },
        );
        expect(evalRun.status).toBe(0);
        expect(String(evalRun.stdout || "").trim()).toBe("5");

        const workerBTaskFile = path.join(project, ".agents", "tasks", "worker-2-worker-b.md");
        const sharedTaskFile = path.join(project, ".fyp", "task.md");
        expect(fs.existsSync(workerATaskFile)).toBe(true);
        expect(fs.existsSync(workerBTaskFile)).toBe(true);
        expect(fs.existsSync(sharedTaskFile)).toBe(true);
        expect(Math.floor(fs.statSync(workerATaskFile).mtimeMs)).toBeGreaterThanOrEqual(startedAt);
        expect(Math.floor(fs.statSync(workerBTaskFile).mtimeMs)).toBeGreaterThanOrEqual(startedAt);
        expect(Math.floor(fs.statSync(sharedTaskFile).mtimeMs)).toBeGreaterThanOrEqual(startedAt);

        const progressResp = await app.inject({
          method: "GET",
          url: `/api/orchestrations/${encodeURIComponent(orchestrationId)}/progress`,
          headers: { authorization: "Bearer t123" },
        });
        expect(progressResp.statusCode).toBe(200);
        const progress = JSON.parse(progressResp.payload) as any;
        const workers = Array.isArray(progress?.item?.workers) ? progress.item.workers : [];
        expect(workers.length).toBe(2);

        const orchestratorTranscript = await readTranscriptText(app, orchestratorSessionId);
        const dispatchEvents = (await readEvents(app, orchestratorSessionId, 800)).filter(
          (e: any) => String(e?.kind) === "orchestration.dispatch",
        );
        expect(dispatchEvents.length).toBeGreaterThanOrEqual(2);

        const summary = {
          orchestrationId,
          workers: {
            a: workerASessionId,
            b: workerBSessionId,
          },
          checks: {
            workerACreatedBuggyFile: true,
            workerBFixedResult: true,
            calculatorAddResult: "5",
            workerTaskFilesUpdated: true,
            sharedTaskFileUpdated: true,
            dispatchEvents: dispatchEvents.length,
            orchestratorSawSyncCue: /ORCHESTRATION SYNC|PERIODIC ORCHESTRATOR REVIEW/i.test(orchestratorTranscript),
          },
          files: {
            calcPath,
            workerATaskFile,
            workerBTaskFile,
            sharedTaskFile,
          },
        };
        const summaryPath = path.join(os.tmpdir(), `fyp-real-codex-create-debug-eval-${orchestrationId}.json`);
        fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
        console.log(`[scenario] summary: ${summaryPath}`);
        console.log(JSON.stringify(summary, null, 2));
      } finally {
        await app.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    540_000,
  );
});
