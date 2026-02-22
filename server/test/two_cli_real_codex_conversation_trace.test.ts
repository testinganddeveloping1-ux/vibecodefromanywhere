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

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 120_000) {
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

function stripAnsi(s: string): string {
  return String(s ?? "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u009b[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u009d[\s\S]*?(?:\u0007|\u009c)/g, "")
    .replace(/\u001bP[\s\S]*?\u001b\\/g, "");
}

function compactLogLine(s: string): string {
  return stripAnsi(s)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 360);
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

function extractLinesContaining(text: string, needles: string[]): string[] {
  const lines = String(text || "")
    .replace(/\r/g, "\n")
    .split("\n");
  return lines
    .map((ln) => compactLogLine(ln))
    .filter((ln) => ln && needles.some((n) => ln.includes(n)))
    .slice(-24);
}

describe("two-cli real codex conversation trace", () => {
  const enabled = process.env.FYP_REAL_CODEX_TRACE_TEST === "1";
  const codexBin = resolveCodexBinary();
  const run = enabled && codexBin ? test : test.skip;

  run(
    "verifies orchestrator->worker tasking, worker response, question cue sync, and orchestrator follow-up",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-real-codex-trace-root-"));
      const project = path.join(root, "project");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, "README.md"), "real-codex conversation trace\n", "utf8");

      const here = path.dirname(fileURLToPath(import.meta.url));
      const fake = path.join(here, "fixtures", "fake_tool.mjs");
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-real-codex-trace-db-"));

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

      const markers = {
        ack: "WORKER_REPORT:ACK-STEP-001",
        q: "NEED-INPUT-Q001",
        qSent: "WORKER_REPORT:QUESTION-SENT-Q001",
        resolved: "WORKER_REPORT:RESOLVED-001",
      };

      try {
        const create = await app.inject({
          method: "POST",
          url: "/api/orchestrations",
          headers: { authorization: "Bearer t123", "content-type": "application/json" },
          payload: JSON.stringify({
            name: "real-codex-conversation-trace",
            projectPath: project,
            autoWorktrees: false,
            dispatchMode: "orchestrator-first",
            autoDispatchInitialPrompts: false,
            automation: {
              questionMode: "orchestrator",
              steeringMode: "off",
              yoloMode: false,
            },
            orchestrator: {
              tool: "codex",
              profileId: "codex.default",
              prompt: "SAFETY TEST MODE. No file edits or heavy commands. Coordinate with Worker A through short dispatches only.",
            },
            workers: [
              {
                name: "Worker A",
                tool: "codex",
                profileId: "codex.default",
                taskPrompt: "SAFETY TEST MODE. Reply with exact markers when asked.",
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

        await waitFor(async () => {
          const ev = await readEvents(app, workerSessionId, 320);
          return ev.some((e: any) => String(e?.kind) === "input" && String(e?.data?.text ?? "").includes("WAIT MODE"));
        }, 120_000);
        await waitFor(async () => {
          const ev = await readEvents(app, orchestratorSessionId, 320);
          return ev.some(
            (e: any) => String(e?.kind) === "input" && String(e?.data?.text ?? "").includes("ORCHESTRATOR QUICKSTART"),
          );
        }, 120_000);

        const dispatch1 = `FYP_DISPATCH_JSON: {"target":"worker:Worker A","text":"Step 1: reply exactly ${markers.ack} and nothing else."}`;
        const send1 = await app.inject({
          method: "POST",
          url: `/api/sessions/${encodeURIComponent(orchestratorSessionId)}/input`,
          headers: { authorization: "Bearer t123", "content-type": "application/json" },
          payload: JSON.stringify({ text: `${dispatch1}\r` }),
        });
        expect(send1.statusCode).toBe(200);

        await waitFor(async () => {
          const workerEvents = await readEvents(app, workerSessionId, 360);
          return workerEvents.some(
            (e: any) => String(e?.kind) === "input" && String(e?.data?.text ?? "").includes(markers.ack),
          );
        }, 40_000);
        try {
          await waitFor(async () => {
            const workerTranscript = await readTranscriptText(app, workerSessionId);
            return workerTranscript.includes(markers.ack);
          }, 120_000);
        } catch {
          const workerTranscript = await readTranscriptText(app, workerSessionId);
          const workerEvents = await readEvents(app, workerSessionId, 400);
          const inputTail = workerEvents
            .filter((e: any) => String(e?.kind) === "input")
            .map((e: any) => String(e?.data?.text ?? ""))
            .slice(-12);
          const outputTail = workerEvents
            .filter((e: any) => String(e?.kind) === "output")
            .map((e: any) => String(e?.data?.chunk ?? ""))
            .join("")
            .slice(-4000);
          console.log("[trace][debug] worker input tail", JSON.stringify(inputTail));
          console.log("[trace][debug] worker transcript tail", workerTranscript.slice(-4000));
          console.log("[trace][debug] worker output tail", outputTail);
          throw new Error("worker_received_dispatch_but_no_model_output");
        }

        const questionPacket = [
          `QUESTION: ${markers.q}`,
          "CONTEXT: waiting for orchestrator decision",
          "FILES: none",
          "OPTIONS: 1=Proceed A | 2=Proceed B",
          "RECOMMENDED: 1",
          "BLOCKING: true",
          markers.qSent,
        ].join("\\n");
        const dispatch2 = `FYP_DISPATCH_JSON: {"target":"worker:Worker A","text":"Step 2: output this exact blocking packet and nothing else. ${questionPacket}"}`;
        const send2 = await app.inject({
          method: "POST",
          url: `/api/sessions/${encodeURIComponent(orchestratorSessionId)}/input`,
          headers: { authorization: "Bearer t123", "content-type": "application/json" },
          payload: JSON.stringify({ text: `${dispatch2}\r` }),
        });
        expect(send2.statusCode).toBe(200);

        await waitFor(async () => {
          const workerTranscript = await readTranscriptText(app, workerSessionId);
          return (
            workerTranscript.includes(`QUESTION: ${markers.q}`) &&
            workerTranscript.includes("BLOCKING: true") &&
            workerTranscript.includes(markers.qSent)
          );
        }, 120_000);

        await waitFor(async () => {
          const orchestratorTranscript = await readTranscriptText(app, orchestratorSessionId);
          return (
            orchestratorTranscript.includes("ORCHESTRATION SYNC (worker.question.cue") ||
            orchestratorTranscript.includes("ORCHESTRATION SYNC (worker.question.cue.tail")
          );
        }, 120_000);

        const dispatch3 = `FYP_DISPATCH_JSON: {"target":"worker:Worker A","text":"Decision: choose option 1 and reply EXACTLY ${markers.resolved} only."}`;
        const send3 = await app.inject({
          method: "POST",
          url: `/api/sessions/${encodeURIComponent(orchestratorSessionId)}/input`,
          headers: { authorization: "Bearer t123", "content-type": "application/json" },
          payload: JSON.stringify({ text: `${dispatch3}\r` }),
        });
        expect(send3.statusCode).toBe(200);

        await waitFor(async () => {
          const workerTranscript = await readTranscriptText(app, workerSessionId);
          return workerTranscript.includes(markers.resolved);
        }, 120_000);

        const workerTranscript = await readTranscriptText(app, workerSessionId);
        const orchestratorTranscript = await readTranscriptText(app, orchestratorSessionId);
        const workerEvents = await readEvents(app, workerSessionId, 700);
        const orchestratorEvents = await readEvents(app, orchestratorSessionId, 700);
        const progressResp = await app.inject({
          method: "GET",
          url: `/api/orchestrations/${encodeURIComponent(orchestrationId)}/progress`,
          headers: { authorization: "Bearer t123" },
        });
        expect(progressResp.statusCode).toBe(200);
        const progress = JSON.parse(progressResp.payload) as any;

        const dispatchEvents = orchestratorEvents.filter((e: any) => String(e?.kind) === "orchestration.dispatch");
        const failedDispatches = dispatchEvents.filter((e: any) => (e?.data?.failed?.length ?? 0) > 0);

        expect(workerTranscript.includes(markers.ack)).toBe(true);
        expect(workerTranscript.includes(`QUESTION: ${markers.q}`)).toBe(true);
        expect(workerTranscript.includes(markers.resolved)).toBe(true);
        expect(dispatchEvents.length).toBeGreaterThanOrEqual(3);
        expect(failedDispatches.length).toBe(0);
        expect(String(progress?.item?.startup?.state ?? "")).toBe("running");
        expect(Array.isArray(progress?.item?.startup?.dispatchedSessionIds)).toBe(true);
        expect(progress.item.startup.dispatchedSessionIds.includes(workerSessionId)).toBe(true);

        const traceSummary = {
          orchestrationId,
          orchestratorSessionId,
          workerSessionId,
          markers,
          checks: {
            workerAck: workerTranscript.includes(markers.ack),
            workerQuestion: workerTranscript.includes(`QUESTION: ${markers.q}`),
            workerResolved: workerTranscript.includes(markers.resolved),
            orchestratorQuestionSync:
              orchestratorTranscript.includes("ORCHESTRATION SYNC (worker.question.cue") ||
              orchestratorTranscript.includes("ORCHESTRATION SYNC (worker.question.cue.tail"),
            dispatchEvents: dispatchEvents.length,
            dispatchFailed: failedDispatches.length,
          },
          highlights: {
            worker: extractLinesContaining(workerTranscript, [
              markers.ack,
              markers.q,
              "BLOCKING: true",
              markers.qSent,
              markers.resolved,
            ]),
            orchestrator: extractLinesContaining(orchestratorTranscript, [
              "ORCHESTRATION SYNC",
              "worker.question.cue",
              "AUTOMATION QUESTION BATCH",
            ]),
            workerInputs: workerEvents
              .filter((e: any) => String(e?.kind) === "input")
              .map((e: any) => String(e?.data?.text ?? ""))
              .filter((s) => s.includes("/model") || s.includes(markers.q) || s.includes(markers.resolved))
              .slice(-8),
          },
        };

        const summaryPath = path.join(os.tmpdir(), `fyp-real-codex-conversation-trace-${orchestrationId}.json`);
        fs.writeFileSync(summaryPath, JSON.stringify(traceSummary, null, 2), "utf8");
        console.log(`[trace] summary: ${summaryPath}`);
        console.log(JSON.stringify(traceSummary, null, 2));
      } finally {
        await app.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
