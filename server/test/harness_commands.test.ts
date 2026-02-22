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

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(45);
  }
  throw new Error("timeout waiting for condition");
}

async function buildTestApp(root: string, dir: string) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fake = path.join(here, "fixtures", "fake_tool.mjs");
  const tool = { command: process.execPath, args: [fake] };

  const app = await buildApp({
    token: "t123",
    dataDir: dir,
    tools: { codex: tool, claude: tool, opencode: tool },
    workspaces: { roots: [root] },
    profiles: {
      "codex.default": { tool: "codex", title: "Codex: Default", codex: { noAltScreen: true }, startup: [], sendSuffix: "\r" },
      "codex.full_auto": { tool: "codex", title: "Codex: Full Auto", codex: { noAltScreen: true }, startup: [], sendSuffix: "\r" },
      "claude.default": { tool: "claude", title: "Claude: Default", startup: [], sendSuffix: "\r" },
      "opencode.default": { tool: "opencode", title: "OpenCode: Default", startup: [], sendSuffix: "\r" },
    },
  });
  await app.ready();
  return app;
}

async function testApp(root: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-commands-db-"));
  const app = await buildTestApp(root, dir);
  return { app, dir };
}

describe("harness command execution", () => {
  test("returns SOTA skill audit sourced from local skills corpus roots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-sota-root-"));
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });

    const { app, dir } = await testApp(root);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/harness/sota-audit?sampleSize=12",
        headers: { authorization: "Bearer t123" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as any;
      expect(body?.ok).toBe(true);
      expect(typeof body?.audit?.generatedAt).toBe("string");
      expect(Array.isArray(body?.audit?.skillRoots)).toBe(true);
      expect(Array.isArray(body?.audit?.commandCoverage)).toBe(true);
      expect(body.audit.commandCoverage.length).toBeGreaterThanOrEqual(40);
      expect(typeof body?.audit?.averageSkillQuality).toBe("number");
      expect(typeof body?.audit?.domainQuality?.orchestration).toBe("number");
      const coord = body.audit.commandCoverage.find((c: any) => c.commandId === "coord-task");
      expect(coord).toBeTruthy();
      expect(Array.isArray(coord.requiredDomains)).toBe(true);
      expect(coord.requiredDomains).toContain("orchestration");
      expect(Array.isArray(coord.supportingSkills)).toBe(true);
      expect(typeof coord.supportScore).toBe("number");
      expect(typeof coord.confidence).toBe("string");
      expect(Array.isArray(body?.audit?.recommendations)).toBe(true);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("lists executable harness commands", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-commands-root-"));
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });

    const { app, dir } = await testApp(root);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/harness/commands",
        headers: { authorization: "Bearer t123" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as any;
      expect(body?.ok).toBe(true);
      expect(Array.isArray(body?.commands)).toBe(true);
      expect(body.commands.length).toBeGreaterThanOrEqual(40);
      expect(body.commands.some((c: any) => c.id === "diag-evidence")).toBe(true);
      expect(body.commands.some((c: any) => c.id === "review-hard")).toBe(true);
      const scopeLock = body.commands.find((c: any) => c.id === "scope-lock");
      expect(scopeLock).toBeTruthy();
      expect(scopeLock?.payloadSchema?.type).toBe("object");
      expect(Array.isArray(scopeLock?.payloadRules?.requiredNonEmpty)).toBe(true);
      expect(scopeLock.payloadRules.requiredNonEmpty).toContain("scope");
      const vulnRepro = body.commands.find((c: any) => c.id === "security-vuln-repro");
      expect(vulnRepro).toBeTruthy();
      expect(String(vulnRepro?.policy?.tier ?? "")).toBe("high");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("executes worker command packets with idempotency replay", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-commands-orch-root-"));
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
          name: "cmd-exec",
          projectPath: repo,
          dispatchMode: "orchestrator-first",
          autoDispatchInitialPrompts: false,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Coordinate workers and execute command tasks.",
          },
          workers: [{ name: "Worker A", taskPrompt: "Handle backend fix flow." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const cBody = JSON.parse(create.payload) as any;
      const id = String(cBody?.id ?? "");
      const workerSessionId = String(cBody?.workers?.[0]?.sessionId ?? "");
      expect(id).toBeTruthy();
      expect(workerSessionId).toBeTruthy();

      const exec1 = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/commands/execute`,
        headers: { authorization: "Bearer t123", "content-type": "application/json", "idempotency-key": "idem-1" },
        payload: JSON.stringify({
          commandId: "diag-evidence",
          target: "worker:worker-a",
          task: "Reproduce startup stall and capture root-cause evidence.",
          scope: ["server/src/app.ts", "server/test/harness.test.ts"],
          verify: ["npm run test -- server/test/harness.test.ts"],
          priority: "HIGH",
        }),
      });
      expect(exec1.statusCode).toBe(200);
      const e1 = JSON.parse(exec1.payload) as any;
      expect(e1?.ok).toBe(true);
      expect(e1?.replayed).toBe(false);
      expect(e1?.mode).toBe("worker.send_task");
      expect(Number(e1?.count?.sent ?? 0)).toBe(1);

      await waitFor(async () => {
        const t = await app.inject({
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(workerSessionId)}/transcript`,
          headers: { authorization: "Bearer t123" },
        });
        const tb = JSON.parse(t.payload) as any;
        const txt = String((tb?.items ?? []).map((it: any) => String(it?.chunk ?? "")).join(""));
        return txt.includes("COMMAND: diag-evidence") && txt.includes("Reproduce startup stall");
      }, 10_000);

      const exec2 = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/commands/execute`,
        headers: { authorization: "Bearer t123", "content-type": "application/json", "idempotency-key": "idem-1" },
        payload: JSON.stringify({
          commandId: "diag-evidence",
          target: "worker:worker-a",
          task: "Reproduce startup stall and capture root-cause evidence.",
        }),
      });
      expect(exec2.statusCode).toBe(200);
      const e2 = JSON.parse(exec2.payload) as any;
      expect(e2?.ok).toBe(true);
      expect(e2?.replayed).toBe(true);
      expect(e2?.mode).toBe("worker.send_task");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("replays idempotent command after app restart (sqlite-backed)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-commands-restart-root-"));
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });

    run("git", ["init"], repo);
    run("git", ["config", "user.email", "test@example.com"], repo);
    run("git", ["config", "user.name", "Test User"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "seed\n", "utf8");
    run("git", ["add", "README.md"], repo);
    run("git", ["commit", "-m", "init"], repo);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-commands-restart-db-"));
    let app = await buildTestApp(root, dir);
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/orchestrations",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          name: "cmd-restart-replay",
          projectPath: repo,
          dispatchMode: "orchestrator-first",
          autoDispatchInitialPrompts: false,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Coordinate workers and execute command tasks.",
          },
          workers: [{ name: "Worker A", taskPrompt: "Handle backend fix flow." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const cBody = JSON.parse(create.payload) as any;
      const id = String(cBody?.id ?? "");
      expect(id).toBeTruthy();

      const key = "idem-persist-1";
      const first = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/commands/execute`,
        headers: { authorization: "Bearer t123", "content-type": "application/json", "idempotency-key": key },
        payload: JSON.stringify({
          commandId: "diag-evidence",
          target: "worker:worker-a",
          task: "Collect deterministic startup evidence.",
          scope: ["server/src/app.ts"],
          verify: ["npm run test -- server/test/harness.test.ts"],
        }),
      });
      expect(first.statusCode).toBe(200);
      const f = JSON.parse(first.payload) as any;
      expect(f?.ok).toBe(true);
      expect(f?.replayed).toBe(false);

      await app.close();
      app = await buildTestApp(root, dir);

      const second = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/commands/execute`,
        headers: { authorization: "Bearer t123", "content-type": "application/json", "idempotency-key": key },
        payload: JSON.stringify({
          commandId: "diag-evidence",
          target: "worker:worker-a",
          task: "Collect deterministic startup evidence.",
          scope: ["server/src/app.ts"],
          verify: ["npm run test -- server/test/harness.test.ts"],
        }),
      });
      expect(second.statusCode).toBe(200);
      const s = JSON.parse(second.payload) as any;
      expect(s?.ok).toBe(true);
      expect(s?.replayed).toBe(true);
      expect(s?.commandId).toBe("diag-evidence");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);

  test("rejects invalid command payload types", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-commands-invalid-root-"));
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
          name: "cmd-invalid",
          projectPath: repo,
          dispatchMode: "orchestrator-first",
          autoDispatchInitialPrompts: false,
          orchestrator: { tool: "codex", profileId: "codex.default", prompt: "Coordinate and validate payloads." },
          workers: [{ name: "Worker A", taskPrompt: "Handle backend fixes." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const cBody = JSON.parse(create.payload) as any;
      const id = String(cBody?.id ?? "");
      expect(id).toBeTruthy();

      const bad = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/commands/execute`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          commandId: "sync-status",
          deliverToOrchestrator: "yes",
        }),
      });
      expect(bad.statusCode).toBe(400);
      const b = JSON.parse(bad.payload) as any;
      expect(b?.error).toBe("invalid_command_payload");
      expect(typeof b?.reason).toBe("string");

      const badScopeLock = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/commands/execute`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          commandId: "scope-lock",
          task: "Restrict worker files",
        }),
      });
      expect(badScopeLock.statusCode).toBe(400);
      const b2 = JSON.parse(badScopeLock.payload) as any;
      expect(b2?.error).toBe("invalid_command_payload");
      expect(String(b2?.reason ?? "")).toContain("scope");

      const badSyncShape = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/commands/execute`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          commandId: "sync-status",
          task: "should not be present on sync command",
        }),
      });
      expect(badSyncShape.statusCode).toBe(400);
      const b3 = JSON.parse(badSyncShape.payload) as any;
      expect(b3?.error).toBe("invalid_command_payload");
      expect(String(b3?.reason ?? "")).toContain("unknown field");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  test("enforces command policy by risk tier", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-commands-policy-root-"));
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
          name: "cmd-policy",
          projectPath: repo,
          dispatchMode: "orchestrator-first",
          autoDispatchInitialPrompts: false,
          orchestrator: { tool: "codex", profileId: "codex.default", prompt: "Coordinate and enforce policy." },
          workers: [{ name: "Worker A", taskPrompt: "Handle backend fixes." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const cBody = JSON.parse(create.payload) as any;
      const id = String(cBody?.id ?? "");
      expect(id).toBeTruthy();

      const blocked = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/commands/execute`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          commandId: "security-vuln-repro",
          target: "worker:Worker A",
          task: "Reproduce vulnerability in authorized test lab.",
          scope: ["server/src/app.ts"],
        }),
      });
      expect(blocked.statusCode).toBe(403);
      const b = JSON.parse(blocked.payload) as any;
      expect(b?.error).toBe("command_policy_blocked");
      expect(b?.tier).toBe("high");

      const mediumBlocked = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/commands/execute`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          commandId: "review-hard",
          force: true,
        }),
      });
      expect(mediumBlocked.statusCode).toBe(403);
      const mb = JSON.parse(mediumBlocked.payload) as any;
      expect(mb?.error).toBe("command_policy_blocked");
      expect(mb?.tier).toBe("medium");

      const allowed = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/commands/execute`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          commandId: "security-vuln-repro",
          target: "worker:Worker A",
          task: "Reproduce vulnerability in authorized test lab.",
          scope: ["server/src/app.ts"],
          policyAck: true,
          policyReason: "Authorized security validation for controlled environment.",
          policyApprovedBy: "security-owner",
          policyAuthorizedScope: "local test harness only",
          rollbackPlan: "Revert patch and disable repro path if unexpected behavior appears.",
        }),
      });
      expect(allowed.statusCode).toBe(200);
      const a = JSON.parse(allowed.payload) as any;
      expect(a?.ok).toBe(true);
      expect(a?.policy?.tier).toBe("high");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);

  test("executes system sync and review commands", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-harness-commands-system-root-"));
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
          name: "cmd-system",
          projectPath: repo,
          dispatchMode: "orchestrator-first",
          autoDispatchInitialPrompts: false,
          orchestrator: {
            tool: "codex",
            profileId: "codex.default",
            prompt: "Coordinate workers and run periodic reviews.",
          },
          workers: [{ name: "Worker A", taskPrompt: "Handle backend fix flow." }],
        }),
      });
      expect(create.statusCode).toBe(200);
      const cBody = JSON.parse(create.payload) as any;
      const id = String(cBody?.id ?? "");
      expect(id).toBeTruthy();

      const syncRes = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/commands/execute`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          commandId: "sync-status",
          force: true,
          deliverToOrchestrator: true,
        }),
      });
      expect(syncRes.statusCode).toBe(200);
      const syncBody = JSON.parse(syncRes.payload) as any;
      expect(syncBody?.ok).toBe(true);
      expect(syncBody?.mode).toBe("system.sync");
      expect(typeof syncBody?.sync?.reason).toBe("string");

      const reviewRes = await app.inject({
        method: "POST",
        url: `/api/orchestrations/${encodeURIComponent(id)}/commands/execute`,
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({
          commandId: "review-hard",
          force: true,
          policyReason: "Urgent review gate before risky integration step.",
        }),
      });
      expect(reviewRes.statusCode).toBe(200);
      const reviewBody = JSON.parse(reviewRes.payload) as any;
      expect(reviewBody?.ok).toBe(true);
      expect(reviewBody?.mode).toBe("system.review");
      expect(typeof reviewBody?.review?.reason).toBe("string");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);
});
