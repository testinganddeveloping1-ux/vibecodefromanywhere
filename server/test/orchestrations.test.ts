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

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(60);
  }
  throw new Error("timeout waiting for condition");
}

async function testApp(root: string) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fake = path.join(here, "fixtures", "fake_tool.mjs");
  const tool = { command: process.execPath, args: [fake] };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-orch-db-"));
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

describe("orchestrations", () => {
  test("creates coordinator + worker sessions with isolated git worktrees", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-orch-root-"));
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
          name: "multi-feature",
          projectPath: repo,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Coordinate the worker sessions and report progress.",
          },
          workers: [
            { name: "api", taskPrompt: "Implement API changes." },
            { name: "ui", taskPrompt: "Implement UI changes." },
          ],
        }),
      });

      expect(create.statusCode).toBe(200);
      const body = JSON.parse(create.payload) as any;
      expect(typeof body?.id).toBe("string");
      expect(typeof body?.orchestratorSessionId).toBe("string");
      expect(Array.isArray(body?.workers)).toBe(true);
      expect(body.workers.length).toBe(2);
      expect(body.workers.every((w: any) => typeof w?.sessionId === "string")).toBe(true);
      expect(body.workers.every((w: any) => typeof w?.branch === "string" && w.branch.length > 0)).toBe(true);
      expect(body.workers.every((w: any) => typeof w?.worktreePath === "string" && w.worktreePath.length > 0)).toBe(true);

      const list = await app.inject({
        method: "GET",
        url: "/api/orchestrations",
        headers: { authorization: "Bearer t123" },
      });
      expect(list.statusCode).toBe(200);
      const listBody = JSON.parse(list.payload) as any;
      expect(Array.isArray(listBody?.items)).toBe(true);
      expect(listBody.items.length).toBe(1);
      expect(listBody.items[0]?.id).toBe(body.id);
      expect(listBody.items[0]?.workerCount).toBe(2);

      const one = await app.inject({
        method: "GET",
        url: `/api/orchestrations/${encodeURIComponent(body.id)}`,
        headers: { authorization: "Bearer t123" },
      });
      expect(one.statusCode).toBe(200);
      const oneBody = JSON.parse(one.payload) as any;
      expect(oneBody?.item?.id).toBe(body.id);
      expect(Array.isArray(oneBody?.item?.workers)).toBe(true);
      expect(oneBody.item.workers.length).toBe(2);
      expect(oneBody.item.workers.every((w: any) => typeof w?.session?.id === "string")).toBe(true);

      const wt = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
      expect(wt.status).toBe(0);
      const txt = wt.stdout || "";
      for (const w of body.workers) expect(txt.includes(String(w.worktreePath))).toBe(true);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  test("injects normalized objective context into worker task prompts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-orch-objective-root-"));
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
      const objective = "stabilize worker startup communication";
      const create = await app.inject({
        method: "POST",
        url: "/api/orchestrations",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          name: "objective-injection-demo",
          projectPath: repo,
          autoWorktrees: false,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: `You are coordinating a team. Goal: ${objective}`,
          },
          workers: [
            { name: "worker-a", taskPrompt: "Implement fixes in assigned scope." },
            { name: "worker-b", taskPrompt: "Run verification and report findings." },
          ],
        }),
      });
      expect(create.statusCode).toBe(200);
      const created = JSON.parse(create.payload) as any;
      const id = String(created?.id ?? "");
      expect(id).toBeTruthy();

      const one = await app.inject({
        method: "GET",
        url: `/api/orchestrations/${encodeURIComponent(id)}`,
        headers: { authorization: "Bearer t123" },
      });
      expect(one.statusCode).toBe(200);
      const body = JSON.parse(one.payload) as any;
      const workers = Array.isArray(body?.item?.workers) ? body.item.workers : [];
      expect(workers.length).toBe(2);
      for (const w of workers) {
        const taskPrompt = String(w?.taskPrompt ?? "");
        expect(taskPrompt).toContain(objective);
      }
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  test("extracts multiline objective text and avoids injecting full orchestrator boilerplate into worker task prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-orch-multiline-objective-root-"));
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
      const objective = "make orchestrator-to-worker dispatch reliable";
      const create = await app.inject({
        method: "POST",
        url: "/api/orchestrations",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          name: "multiline-objective-demo",
          projectPath: repo,
          autoWorktrees: false,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: [
              "SYSTEM PROMPT (apply strictly):",
              "ROLE: MAIN ORCHESTRATOR",
              "ORCHESTRATOR DIRECTIVE",
              `Goal: ${objective}`,
              "STARTUP SEQUENCE",
              "Dispatch tasks quickly.",
            ].join("\n"),
          },
          workers: [{ name: "worker-a", taskPrompt: "Implement fixes in assigned scope." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const created = JSON.parse(create.payload) as any;
      const id = String(created?.id ?? "");
      expect(id).toBeTruthy();

      const one = await app.inject({
        method: "GET",
        url: `/api/orchestrations/${encodeURIComponent(id)}`,
        headers: { authorization: "Bearer t123" },
      });
      expect(one.statusCode).toBe(200);
      const body = JSON.parse(one.payload) as any;
      const workers = Array.isArray(body?.item?.workers) ? body.item.workers : [];
      expect(workers.length).toBe(1);
      const taskPrompt = String(workers[0]?.taskPrompt ?? "");
      expect(taskPrompt).toContain(objective);
      expect(taskPrompt).not.toContain("SYSTEM PROMPT (apply strictly):");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  test("cleanup stops sessions, removes worktrees, and marks orchestration cleaned", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-orch-clean-root-"));
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
          name: "cleanup-demo",
          projectPath: repo,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Coordinate and report progress.",
          },
          workers: [
            { name: "api", taskPrompt: "Implement API changes." },
            { name: "ui", taskPrompt: "Implement UI changes." },
          ],
        }),
      });
      expect(create.statusCode).toBe(200);
      const created = JSON.parse(create.payload) as any;
      const id = String(created?.id ?? "");
      expect(id).toBeTruthy();

      const cleanup = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/cleanup`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ stopSessions: true, deleteSessions: false, removeWorktrees: true }),
      });
      expect(cleanup.statusCode).toBe(200);
      const cleaned = JSON.parse(cleanup.payload) as any;
      expect(cleaned?.ok).toBe(true);
      expect(Number(cleaned?.summary?.sessions?.closed ?? 0)).toBeGreaterThan(0);
      expect(Number(cleaned?.summary?.worktrees?.removed ?? 0)).toBe(2);

      const one = await app.inject({
        method: "GET",
        url: `/api/orchestrations/${encodeURIComponent(id)}`,
        headers: { authorization: "Bearer t123" },
      });
      expect(one.statusCode).toBe(200);
      const oneBody = JSON.parse(one.payload) as any;
      expect(oneBody?.item?.status).toBe("cleaned");
      expect(oneBody?.item?.runningWorkers).toBe(0);

      const wt = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
      expect(wt.status).toBe(0);
      const txt = wt.stdout || "";
      for (const w of created.workers) expect(txt.includes(String(w.worktreePath))).toBe(false);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);

  test("progress endpoint reads worker task markdown checkpoints", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-orch-progress-root-"));
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
          name: "progress-demo",
          projectPath: repo,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Coordinate and track progress.",
          },
          workers: [{ name: "api", taskPrompt: "Implement API changes." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const created = JSON.parse(create.payload) as any;
      const id = String(created?.id ?? "");
      expect(id).toBeTruthy();
      const wt = String(created?.workers?.[0]?.worktreePath ?? "");
      expect(wt).toBeTruthy();

      fs.mkdirSync(path.join(wt, ".fyp"), { recursive: true });
      fs.mkdirSync(path.join(wt, ".agents", "tasks"), { recursive: true });
      const progressText = [
        "# Task",
        "- [x] Reproduced issue",
        "- [ ] Apply patch",
        "- [ ] Verify tests",
        "",
        "Blockers: none",
      ].join("\n");
      fs.writeFileSync(
        path.join(wt, ".fyp", "task.md"),
        progressText,
        "utf8",
      );
      fs.writeFileSync(
        path.join(wt, ".agents", "tasks", "worker-1-api.md"),
        progressText,
        "utf8",
      );

      const progress = await app.inject({
        method: "GET",
        url: `/api/orchestrations/${encodeURIComponent(id)}/progress`,
        headers: { authorization: "Bearer t123" },
      });
      expect(progress.statusCode).toBe(200);
      const body = JSON.parse(progress.payload) as any;
      expect(body?.ok).toBe(true);
      expect(body?.item?.orchestrationId).toBe(id);
      expect(Array.isArray(body?.item?.workers)).toBe(true);
      expect(body.item.workers.length).toBe(1);
      const worker = body.item.workers[0];
      expect(worker?.progress?.found).toBe(true);
      expect(
        [".agents/tasks/worker-1-api.md", ".fyp/task.md"].includes(String(worker?.progress?.relPath ?? "")),
      ).toBe(true);
      expect(worker?.progress?.checklistDone).toBe(1);
      expect(worker?.progress?.checklistTotal).toBe(3);
      expect(String(worker?.progress?.preview ?? "")).toContain("Task");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  test("cleanup endpoint enforces orchestration locks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-orch-lock-root-"));
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
          name: "lock-demo",
          projectPath: repo,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Coordinate workers.",
          },
          workers: [{ name: "api", taskPrompt: "Implement API changes." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const created = JSON.parse(create.payload) as any;
      const id = String(created?.id ?? "");
      expect(id).toBeTruthy();

      const p1 = app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/cleanup`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ stopSessions: false, removeWorktrees: false, debugDelayMs: 250 }),
      });
      const p2 = app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/cleanup`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ stopSessions: false, removeWorktrees: false }),
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      const statusCodes = [r1.statusCode, r2.statusCode].sort();
      expect(statusCodes[0]).toBe(200);
      expect(statusCodes[1]).toBe(409);
      const lockResp = r1.statusCode === 409 ? JSON.parse(r1.payload) : JSON.parse(r2.payload);
      expect(lockResp?.error).toBe("orchestration_locked");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  test("manual sync builds a digest and skips unchanged syncs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-orch-sync-root-"));
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
          name: "sync-demo",
          projectPath: repo,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Coordinate workers.",
          },
          workers: [{ name: "api", taskPrompt: "Implement API changes." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const created = JSON.parse(create.payload) as any;
      const id = String(created?.id ?? "");
      expect(id).toBeTruthy();

      const sync1 = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/sync`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ force: true, reason: "manual-test" }),
      });
      expect(sync1.statusCode).toBe(200);
      const body1 = JSON.parse(sync1.payload) as any;
      expect(body1?.ok).toBe(true);
      expect(body1?.sync?.sent).toBe(true);
      expect(typeof body1?.sync?.digest?.hash).toBe("string");
      expect(String(body1?.sync?.digest?.text ?? "")).toContain("ORCHESTRATION SYNC");
      expect(String(body1?.sync?.digest?.text ?? "")).toContain("api");

      const sync2 = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/sync`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ deliverToOrchestrator: false }),
      });
      expect(sync2.statusCode).toBe(200);
      const body2 = JSON.parse(sync2.payload) as any;
      expect(body2?.ok).toBe(true);
      expect(body2?.sync?.sent).toBe(false);
      expect(["unchanged", "collect_only"]).toContain(String(body2?.sync?.reason ?? ""));

      const one = await app.inject({
        method: "GET",
        url: `/api/orchestrations/${encodeURIComponent(id)}`,
        headers: { authorization: "Bearer t123" },
      });
      expect(one.statusCode).toBe(200);
      const oneBody = JSON.parse(one.payload) as any;
      expect(oneBody?.item?.sync?.lastDigestAt).toBeTypeOf("number");
      expect(typeof oneBody?.item?.sync?.lastDigestHash).toBe("string");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  test("automation policy routes worker questions to orchestrator and tracks pending question state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-orch-auto-root-"));
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
          name: "automation-demo",
          projectPath: repo,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Coordinate workers and resolve safe questions.",
          },
          workers: [{ name: "claude-worker", tool: "claude", profileId: "claude.default", taskPrompt: "Implement API changes." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const created = JSON.parse(create.payload) as any;
      const id = String(created?.id ?? "");
      const orchestratorSessionId = String(created?.orchestratorSessionId ?? "");
      const workerSessionId = String(created?.workers?.[0]?.sessionId ?? "");
      expect(id).toBeTruthy();
      expect(orchestratorSessionId).toBeTruthy();
      expect(workerSessionId).toBeTruthy();

      const patch = await app.inject({
        method: "PATCH",
        url: `/api/orchestrations/${encodeURIComponent(id)}/automation-policy`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          questionMode: "orchestrator",
          steeringMode: "passive_review",
          questionTimeoutMs: 120_000,
          reviewIntervalMs: 180_000,
          yoloMode: false,
          runNow: true,
          force: true,
        }),
      });
      expect(patch.statusCode).toBe(200);
      const patched = JSON.parse(patch.payload) as any;
      expect(patched?.ok).toBe(true);
      expect(patched?.automation?.policy?.questionMode).toBe("orchestrator");
      expect(patched?.automation?.policy?.steeringMode).toBe("passive_review");
      expect(Number(patched?.automation?.policy?.questionTimeoutMs ?? 0)).toBe(120_000);
      expect(patched?.automation?.run?.sent).toBeTypeOf("boolean");

      const hookReq = await app.inject({
        method: "POST",
        url: "/hooks/claude/permission-request",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          sessionId: workerSessionId,
          payload: {
            tool_name: "Bash",
            tool_input: { command: "echo hi" },
            permission_suggestions: [{ type: "toolAlwaysAllow", tool: "Bash" }],
          },
        }),
      });
      expect(hookReq.statusCode).toBe(200);
      const hookBody = JSON.parse(hookReq.payload) as any;
      expect(hookBody?.ok).toBe(true);
      const signature = String(hookBody?.signature ?? "");
      expect(signature.includes(workerSessionId)).toBe(true);

      const inbox = await app.inject({
        method: "GET",
        url: `/api/inbox?sessionId=${encodeURIComponent(workerSessionId)}&status=open&limit=50`,
        headers: { authorization: "Bearer t123" },
      });
      expect(inbox.statusCode).toBe(200);
      const items = (JSON.parse(inbox.payload)?.items ?? []) as any[];
      const item = items.find((x) => String(x?.signature ?? "") === signature) ?? items[0];
      expect(item && typeof item.id === "number").toBe(true);
      const attentionId = Number(item.id);
      expect(attentionId).toBeGreaterThan(0);

      await waitFor(async () => {
        const one = await app.inject({
          method: "GET",
          url: `/api/orchestrations/${encodeURIComponent(id)}`,
          headers: { authorization: "Bearer t123" },
        });
        const body = JSON.parse(one.payload) as any;
        return Number(body?.item?.automation?.pendingQuestionCount ?? 0) >= 1;
      });

      await waitFor(async () => {
        const tr = await app.inject({
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(orchestratorSessionId)}/transcript`,
          headers: { authorization: "Bearer t123" },
        });
        const payload = JSON.parse(tr.payload) as any;
        const text = String((payload?.items ?? []).map((it: any) => String(it?.chunk ?? "")).join(""));
        return text.includes("AUTOMATION QUESTION BATCH") && text.includes(String(attentionId));
      }, 12_000);

      const respond = await app.inject({
        method: "POST",
        url: `/api/inbox/${encodeURIComponent(String(attentionId))}/respond`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          optionId: "y",
          meta: { source: "orchestrator-auto", orchestrationId: id },
          source: "orchestrator-auto",
        }),
      });
      expect(respond.statusCode).toBe(200);

      await waitFor(async () => {
        const one = await app.inject({
          method: "GET",
          url: `/api/orchestrations/${encodeURIComponent(id)}`,
          headers: { authorization: "Bearer t123" },
        });
        const body = JSON.parse(one.payload) as any;
        return Number(body?.item?.automation?.pendingQuestionCount ?? 0) === 0;
      });

      const policyGet = await app.inject({
        method: "GET",
        url: `/api/orchestrations/${encodeURIComponent(id)}/automation-policy`,
        headers: { authorization: "Bearer t123" },
      });
      expect(policyGet.statusCode).toBe(200);
      const policyBody = JSON.parse(policyGet.payload) as any;
      expect(policyBody?.ok).toBe(true);
      expect(policyBody?.automation?.policy?.questionMode).toBe("orchestrator");
      expect(Number(policyBody?.automation?.questionDispatchCount ?? 0)).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("sync policy endpoint updates mode and can trigger a run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-orch-policy-root-"));
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
          name: "policy-demo",
          projectPath: repo,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Coordinate workers.",
          },
          workers: [{ name: "api", taskPrompt: "Implement API changes." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const created = JSON.parse(create.payload) as any;
      const id = String(created?.id ?? "");
      expect(id).toBeTruthy();

      const policy = await app.inject({
        method: "PATCH",
        url: `/api/orchestrations/${encodeURIComponent(id)}/sync-policy`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          mode: "interval",
          intervalMs: 20_000,
          deliverToOrchestrator: false,
          runNow: true,
        }),
      });
      expect(policy.statusCode).toBe(200);
      const body = JSON.parse(policy.payload) as any;
      expect(body?.ok).toBe(true);
      expect(body?.sync?.policy?.mode).toBe("interval");
      expect(body?.sync?.policy?.intervalMs).toBe(20_000);
      expect(body?.sync?.policy?.deliverToOrchestrator).toBe(false);
      expect(body?.sync?.run?.sent).toBe(false);
      expect(body?.sync?.run?.reason).toBe("collect_only");

      const one = await app.inject({
        method: "GET",
        url: `/api/orchestrations/${encodeURIComponent(id)}`,
        headers: { authorization: "Bearer t123" },
      });
      expect(one.statusCode).toBe(200);
      const oneBody = JSON.parse(one.payload) as any;
      expect(oneBody?.item?.sync?.policy?.mode).toBe("interval");
      expect(oneBody?.item?.sync?.lastDigestAt).toBeTypeOf("number");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);
});
