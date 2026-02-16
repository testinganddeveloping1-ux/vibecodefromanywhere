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
    await sleep(25);
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

describe("multi session", () => {
  test("streams output independently for two sessions", async () => {
    const { app, dir } = await testApp();

    const mk = async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ tool: "codex", profileId: "codex.default", savePreset: false }),
      });
      expect(created.statusCode).toBe(200);
      return JSON.parse(created.payload).id as string;
    };

    const a = await mk();
    const b = await mk();
    expect(a).not.toBe(b);

    let outA = "";
    let outB = "";

    const wsA = await (app as any).injectWS(
      `/ws/sessions/${encodeURIComponent(a)}`,
      { headers: { authorization: "Bearer t123" } },
      {
        onInit: (sock: any) => {
          sock.on("message", (raw: any) => {
            try {
              const msg = JSON.parse(raw.toString());
              if (msg?.type === "output" && typeof msg.chunk === "string") outA += msg.chunk;
            } catch {
              // ignore
            }
          });
        },
      },
    );

    const wsB = await (app as any).injectWS(
      `/ws/sessions/${encodeURIComponent(b)}`,
      { headers: { authorization: "Bearer t123" } },
      {
        onInit: (sock: any) => {
          sock.on("message", (raw: any) => {
            try {
              const msg = JSON.parse(raw.toString());
              if (msg?.type === "output" && typeof msg.chunk === "string") outB += msg.chunk;
            } catch {
              // ignore
            }
          });
        },
      },
    );

    wsA.send(JSON.stringify({ type: "input", text: "AAA\r" }));
    wsB.send(JSON.stringify({ type: "input", text: "BBB\r" }));

    await waitFor(() => outA.includes("AAA"));
    await waitFor(() => outB.includes("BBB"));
    // Ensure no cross-session bleed.
    expect(outA.includes("BBB")).toBe(false);
    expect(outB.includes("AAA")).toBe(false);

    wsA.close();
    wsB.close();

    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  test("force-removing one session does not break other sessions", async () => {
    const { app, dir } = await testApp();

    const mk = async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ tool: "codex", profileId: "codex.default", savePreset: false }),
      });
      expect(created.statusCode).toBe(200);
      return JSON.parse(created.payload).id as string;
    };

    const a = await mk();
    const b = await mk();
    expect(a).not.toBe(b);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${encodeURIComponent(a)}?force=1`,
      headers: { authorization: "Bearer t123" },
    });
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.payload)?.ok).toBe(true);

    const afterA = await app.inject({
      method: "GET",
      url: `/api/sessions/${encodeURIComponent(a)}`,
      headers: { authorization: "Bearer t123" },
    });
    expect(afterA.statusCode).toBe(404);

    const afterB = await app.inject({
      method: "GET",
      url: `/api/sessions/${encodeURIComponent(b)}`,
      headers: { authorization: "Bearer t123" },
    });
    expect(afterB.statusCode).toBe(200);
    const bodyB = JSON.parse(afterB.payload) as any;
    expect(bodyB?.id).toBe(b);

    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});
