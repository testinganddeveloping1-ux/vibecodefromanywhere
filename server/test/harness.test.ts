import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app";

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim();
    throw new Error(`${cmd} ${args.join(" ")} failed: ${msg}`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 3500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(45);
  }
  throw new Error("timeout waiting for condition");
}

async function testApp(root: string) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fake = path.join(here, "fixtures", "fake_tool.mjs");
  const tool = { command: process.execPath, args: [fake] };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-db-"));
  const app = await buildApp({
    token: "t123",
    dataDir: dir,
    tools: { codex: tool, claude: tool, opencode: tool },
    workspaces: { roots: [root] },
    profiles: {
      "codex.default": { tool: "codex", title: "Codex: Default", codex: { noAltScreen: true }, startup: [], sendSuffix: "\r" },
      "claude.default": { tool: "claude", title: "Claude: Default", startup: [], sendSuffix: "\r" },
      "opencode.default": { tool: "opencode", title: "OpenCode: Default", startup: [], sendSuffix: "\r" },
      "opencode.minimax_free": { tool: "opencode", title: "OpenCode: Minimax M2.5 (Free)", opencode: { model: "opencode/minimax-m2.5-free" }, startup: [], sendSuffix: "\r" },
      "opencode.kimi_free": { tool: "opencode", title: "OpenCode: Kimi K2.5 (Free)", opencode: { model: "opencode/kimi-k2.5-free" }, startup: [], sendSuffix: "\r" },
    },
  });
  await app.ready();
  return { app, dir };
}

describe("harness APIs", () => {
  test("creator recommendation returns prompt packs and worker plan", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-root-"));
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "index.ts"), "export const x = 1;\n", "utf8");
    fs.writeFileSync(path.join(repo, "src", "index.test.ts"), "describe('x', ()=>{});\n", "utf8");

    const { app, dir } = await testApp(root);
    try {
      const prompts = await app.inject({
        method: "GET",
        url: "/api/harness/prompts",
        headers: { authorization: "Bearer t123" },
      });
      expect(prompts.statusCode).toBe(200);
      const p = JSON.parse(prompts.payload) as any;
      expect(p?.ok).toBe(true);
      expect(typeof p?.prompts?.creatorSystem).toBe("string");
      expect(Array.isArray(p?.commandCatalog)).toBe(true);
      expect(p.commandCatalog.length).toBeGreaterThan(0);

      const rec = await app.inject({
        method: "POST",
        url: "/api/harness/creator/recommend",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          objective: "Understand this workspace and fix as many backend bugs as possible.",
          projectPath: repo,
          prefs: { budget: "low", priority: "quality", maxWorkers: 4, allowWorkspaceScan: true },
        }),
      });
      expect(rec.statusCode).toBe(200);
      const r = JSON.parse(rec.payload) as any;
      expect(r?.ok).toBe(true);
      expect(r?.recommendation?.creator?.profileId).toBe("opencode.minimax_free");
      expect(r?.recommendation?.orchestrator?.dispatchMode).toBe("orchestrator-first");
      expect(Array.isArray(r?.recommendation?.workers)).toBe(true);
      expect(r.recommendation.workers.length).toBeGreaterThan(0);
      expect(typeof r?.context?.scan?.fileCount).toBe("number");

      const badBuild = await app.inject({
        method: "POST",
        url: "/api/harness/creator/build",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          objective: "build me a plan",
        }),
      });
      expect(badBuild.statusCode).toBe(400);
      expect(JSON.parse(badBuild.payload)?.error).toBe("missing_projectPath");

      const build = await app.inject({
        method: "POST",
        url: "/api/harness/creator/build",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          objective: "Understand this workspace and fix as many backend bugs as possible.",
          projectPath: repo,
          prefs: { budget: "low", priority: "quality", maxWorkers: 4, allowWorkspaceScan: true },
          behavior: {
            coordinationStyle: "strict",
            approvalPolicy: "guarded-auto",
            interruptPolicy: "on-blocker",
            enforceFileOwnership: true,
            allowWorkerSubagents: true,
            maxWorkerSubagents: 2,
            sync: { mode: "interval", intervalMs: 120000, deliverToOrchestrator: true, minDeliveryGapMs: 45000 },
          },
        }),
      });
      expect(build.statusCode).toBe(200);
      const built = JSON.parse(build.payload) as any;
      expect(built?.ok).toBe(true);
      expect(built?.orchestrationSpec?.projectPath).toBe(repo);
      expect(built?.orchestrationSpec?.dispatchMode).toBe("orchestrator-first");
      expect(built?.orchestrationSpec?.harness?.useDefaultPrompts).toBe(false);
      expect(String(built?.orchestrationSpec?.harness?.orchestratorSystemPrompt ?? "")).toContain("RUNTIME BEHAVIOR CONTROLS");
      expect(String(built?.orchestrationSpec?.workers?.[0]?.taskPrompt ?? "")).toContain("FILE OWNERSHIP");
      expect(Array.isArray(built?.postCreateActions)).toBe(true);
      expect(String(built?.postCreateActions?.[0]?.routeTemplate ?? "")).toContain("/api/orchestrations/{id}/sync-policy");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("orchestrator-first mode defers worker initial prompt and supports dispatch endpoint", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-orch-root-"));
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });

    run("git", ["init"], repo);
    run("git", ["config", "user.email", "test@example.com"], repo);
    run("git", ["config", "user.name", "Test User"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "seed\n", "utf8");
    run("git", ["add", "README.md"], repo);
    run("git", ["commit", "-m", "init"], repo);

    const { app, dir } = await testApp(root);
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/orchestrations",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          name: "orch-first",
          projectPath: repo,
          dispatchMode: "orchestrator-first",
          autoDispatchInitialPrompts: false,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Coordinate workers tightly and dispatch first prompts yourself.",
          },
          workers: [{ name: "api", taskPrompt: "Implement API changes." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const body = JSON.parse(create.payload) as any;
      const id = String(body?.id ?? "");
      const workerSessionId = String(body?.workers?.[0]?.sessionId ?? "");
      expect(id).toBeTruthy();
      expect(workerSessionId).toBeTruthy();
      expect(body?.dispatchMode).toBe("orchestrator-first");

      const one = await app.inject({
        method: "GET",
        url: `/api/orchestrations/${encodeURIComponent(id)}`,
        headers: { authorization: "Bearer t123" },
      });
      expect(one.statusCode).toBe(200);
      const oneBody = JSON.parse(one.payload) as any;
      expect(oneBody?.item?.dispatchMode).toBe("orchestrator-first");
      expect(Array.isArray(oneBody?.item?.deferredInitialDispatch)).toBe(true);
      expect(oneBody.item.deferredInitialDispatch.includes(workerSessionId)).toBe(true);

      const beforeProgress = await app.inject({
        method: "GET",
        url: `/api/orchestrations/${encodeURIComponent(id)}/progress`,
        headers: { authorization: "Bearer t123" },
      });
      expect(beforeProgress.statusCode).toBe(200);
      const beforeProgressBody = JSON.parse(beforeProgress.payload) as any;
      expect(beforeProgressBody?.item?.startup?.state).toBe("waiting-first-dispatch");
      expect(Array.isArray(beforeProgressBody?.item?.startup?.pendingSessionIds)).toBe(true);
      expect(beforeProgressBody.item.startup.pendingSessionIds.includes(workerSessionId)).toBe(true);

      await waitFor(async () => {
        const t = await app.inject({
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(workerSessionId)}/transcript`,
          headers: { authorization: "Bearer t123" },
        });
        const tb = JSON.parse(t.payload) as any;
        const txt = String((tb?.items ?? []).map((it: any) => String(it?.chunk ?? "")).join(""));
        return txt.includes("WAIT MODE");
      });
      const firstTranscript = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(workerSessionId)}/transcript`,
        headers: { authorization: "Bearer t123" },
      });
      expect(firstTranscript.statusCode).toBe(200);
      const firstBody = JSON.parse(firstTranscript.payload) as any;
      const before = String((firstBody?.items ?? []).map((it: any) => String(it?.chunk ?? "")).join(""));
      expect(before.includes("Implement API changes.")).toBe(true);

      const dispatch = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/dispatch`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ target: "all", text: "Run quick analysis now." }),
      });
      expect(dispatch.statusCode).toBe(200);
      const dispatchBody = JSON.parse(dispatch.payload) as any;
      expect(dispatchBody?.count?.sent).toBe(1);

      await waitFor(async () => {
        const t = await app.inject({
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(workerSessionId)}/transcript`,
          headers: { authorization: "Bearer t123" },
        });
        const tb = JSON.parse(t.payload) as any;
        const after = String((tb?.items ?? []).map((it: any) => String(it?.chunk ?? "")).join(""));
        return after.includes("Run quick analysis now.");
      });

      const afterProgress = await app.inject({
        method: "GET",
        url: `/api/orchestrations/${encodeURIComponent(id)}/progress`,
        headers: { authorization: "Bearer t123" },
      });
      expect(afterProgress.statusCode).toBe(200);
      const afterProgressBody = JSON.parse(afterProgress.payload) as any;
      expect(afterProgressBody?.item?.startup?.state).toBe("running");
      expect(Array.isArray(afterProgressBody?.item?.startup?.pendingSessionIds)).toBe(true);
      expect(afterProgressBody.item.startup.pendingSessionIds.includes(workerSessionId)).toBe(false);
      expect(Array.isArray(afterProgressBody?.item?.startup?.dispatchedSessionIds)).toBe(true);
      expect(afterProgressBody.item.startup.dispatchedSessionIds.includes(workerSessionId)).toBe(true);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  test("dispatch supports worker aliases and session targets", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-dispatch-root-"));
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });

    run("git", ["init"], repo);
    run("git", ["config", "user.email", "test@example.com"], repo);
    run("git", ["config", "user.name", "Test User"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "seed\n", "utf8");
    run("git", ["add", "README.md"], repo);
    run("git", ["commit", "-m", "init"], repo);

    const { app, dir } = await testApp(root);
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/orchestrations",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          name: "dispatch-aliases",
          projectPath: repo,
          dispatchMode: "orchestrator-first",
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Coordinate workers tightly.",
          },
          workers: [{ name: "Worker A", taskPrompt: "Handle backend fix flow." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const body = JSON.parse(create.payload) as any;
      const id = String(body?.id ?? "");
      const workerSessionId = String(body?.workers?.[0]?.sessionId ?? "");
      expect(id).toBeTruthy();
      expect(workerSessionId).toBeTruthy();

      const d1 = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/dispatch`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ target: "worker:worker-a", text: "Alias dispatch one." }),
      });
      expect(d1.statusCode).toBe(200);
      expect(JSON.parse(d1.payload)?.count?.sent).toBe(1);

      const d2 = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/dispatch`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ target: `session:${workerSessionId}`, text: "Session dispatch two." }),
      });
      expect(d2.statusCode).toBe(200);
      expect(JSON.parse(d2.payload)?.count?.sent).toBe(1);

      const d3 = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/dispatch`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ target: "1", text: "Index dispatch three." }),
      });
      expect(d3.statusCode).toBe(200);
      expect(JSON.parse(d3.payload)?.count?.sent).toBe(1);

      await waitFor(async () => {
        const t = await app.inject({
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(workerSessionId)}/transcript`,
          headers: { authorization: "Bearer t123" },
        });
        const tb = JSON.parse(t.payload) as any;
        const txt = String((tb?.items ?? []).map((it: any) => String(it?.chunk ?? "")).join(""));
        return txt.includes("Alias dispatch one.") && txt.includes("Session dispatch two.") && txt.includes("Index dispatch three.");
      }, 8_000);

      const bad = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/dispatch`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ target: "worker:not-real", text: "x" }),
      });
      expect(bad.statusCode).toBe(400);
      const badBody = JSON.parse(bad.payload) as any;
      expect(badBody?.error).toBe("no_targets");
      expect(Array.isArray(badBody?.availableTargets)).toBe(true);
      expect(String(badBody?.availableTargets?.[0]?.name ?? "")).toBe("Worker A");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  test("orchestrator inline FYP_DISPATCH_JSON directives dispatch repeatedly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-inline-dispatch-root-"));
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });

    run("git", ["init"], repo);
    run("git", ["config", "user.email", "test@example.com"], repo);
    run("git", ["config", "user.name", "Test User"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "seed\n", "utf8");
    run("git", ["add", "README.md"], repo);
    run("git", ["commit", "-m", "init"], repo);

    const { app, dir } = await testApp(root);
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/orchestrations",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          name: "inline-dispatch",
          projectPath: repo,
          dispatchMode: "orchestrator-first",
          autoDispatchInitialPrompts: false,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Dispatch worker prompts from inline directives.",
          },
          workers: [{ name: "Worker A", taskPrompt: "Handle backend fix flow." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const body = JSON.parse(create.payload) as any;
      const orchestratorSessionId = String(body?.orchestratorSessionId ?? "");
      const workerSessionId = String(body?.workers?.[0]?.sessionId ?? "");
      expect(orchestratorSessionId).toBeTruthy();
      expect(workerSessionId).toBeTruthy();

      await waitFor(async () => {
        const t = await app.inject({
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(workerSessionId)}/transcript`,
          headers: { authorization: "Bearer t123" },
        });
        const tb = JSON.parse(t.payload) as any;
        const txt = String((tb?.items ?? []).map((it: any) => String(it?.chunk ?? "")).join(""));
        return txt.includes("WAIT MODE");
      });

      const sendInline = async () =>
        app.inject({
          method: "POST",
          url: `/api/sessions/${encodeURIComponent(orchestratorSessionId)}/input`,
          headers: { authorization: "Bearer t123", "content-type": "application/json" },
          payload: JSON.stringify({
            text: '- FYP_DISPATCH_JSON: {"target":"worker:worker-a","text":"Inline directive ping."}\r',
          }),
        });

      const first = await sendInline();
      expect(first.statusCode).toBe(200);
      await waitFor(async () => {
        const t = await app.inject({
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(workerSessionId)}/transcript`,
          headers: { authorization: "Bearer t123" },
        });
        const tb = JSON.parse(t.payload) as any;
        const txt = String((tb?.items ?? []).map((it: any) => String(it?.chunk ?? "")).join(""));
        return txt.includes("Inline directive ping.");
      }, 10_000);

      await sleep(1900);
      const second = await sendInline();
      expect(second.statusCode).toBe(200);
      await waitFor(async () => {
        const t = await app.inject({
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(workerSessionId)}/transcript`,
          headers: { authorization: "Bearer t123" },
        });
        const tb = JSON.parse(t.payload) as any;
        const txt = String((tb?.items ?? []).map((it: any) => String(it?.chunk ?? "")).join(""));
        const count = (txt.match(/Inline directive ping\./g) ?? []).length;
        return count >= 2;
      }, 12_000);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("orchestrator inline multiline send-task directives route to workers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-inline-multiline-root-"));
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });

    run("git", ["init"], repo);
    run("git", ["config", "user.email", "test@example.com"], repo);
    run("git", ["config", "user.name", "Test User"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "seed\n", "utf8");
    run("git", ["add", "README.md"], repo);
    run("git", ["commit", "-m", "init"], repo);

    const { app, dir } = await testApp(root);
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/orchestrations",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          name: "inline-multiline-dispatch",
          projectPath: repo,
          dispatchMode: "orchestrator-first",
          autoDispatchInitialPrompts: false,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Dispatch worker prompts from fragmented multiline directives.",
          },
          workers: [{ name: "Worker A", taskPrompt: "Handle backend fix flow." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const body = JSON.parse(create.payload) as any;
      const orchestratorSessionId = String(body?.orchestratorSessionId ?? "");
      const workerSessionId = String(body?.workers?.[0]?.sessionId ?? "");
      expect(orchestratorSessionId).toBeTruthy();
      expect(workerSessionId).toBeTruthy();

      await waitFor(async () => {
        const t = await app.inject({
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(workerSessionId)}/transcript`,
          headers: { authorization: "Bearer t123" },
        });
        const tb = JSON.parse(t.payload) as any;
        const txt = String((tb?.items ?? []).map((it: any) => String(it?.chunk ?? "")).join(""));
        return txt.includes("WAIT MODE");
      });

      const dispatch = await app.inject({
        method: "POST",
        url: `/api/sessions/${encodeURIComponent(orchestratorSessionId)}/input`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          text:
            "FYP_SEND_TASK_JSON:\n" +
            "{\n" +
            '  "target":"worker:Worker A",\n' +
            '  "task":"MULTILINE-DIRECTIVE-PAYLOAD",\n' +
            '  "initialize":true,\n' +
            '  "interrupt":false\n' +
            "}\r",
        }),
      });
      expect(dispatch.statusCode).toBe(200);

      await waitFor(async () => {
        const t = await app.inject({
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(workerSessionId)}/transcript`,
          headers: { authorization: "Bearer t123" },
        });
        const tb = JSON.parse(t.payload) as any;
        const txt = String((tb?.items ?? []).map((it: any) => String(it?.chunk ?? "")).join(""));
        return txt.includes("MULTILINE-DIRECTIVE-PAYLOAD");
      }, 12_000);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
