import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => boolean, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
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

describe("websockets", () => {
  test("rejects websocket without auth", async () => {
    const { app, dir } = await testApp();
    await expect((app as any).injectWS("/ws/global")).rejects.toThrow("Unexpected server response: 401");
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("global websocket emits initial sync", async () => {
    const { app, dir } = await testApp();
    const seen = new Set<string>();
    const ws = await (app as any).injectWS(
      "/ws/global",
      { headers: { authorization: "Bearer t123" } },
      {
        onInit: (sock: any) => {
          sock.on("message", (raw: any) => {
            try {
              const msg = JSON.parse(raw.toString());
              if (msg?.type) seen.add(String(msg.type));
            } catch {
              // ignore
            }
          });
        },
      },
    );
    await waitFor(() => seen.has("sessions.changed") && seen.has("workspaces.changed") && seen.has("inbox.changed"));
    ws.close();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("session websocket streams output and persists input events", async () => {
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

    let out = "";
    let sawAssist = false;
    const ws = await (app as any).injectWS(
      `/ws/sessions/${encodeURIComponent(id)}`,
      { headers: { authorization: "Bearer t123" } },
      {
        onInit: (sock: any) => {
          sock.on("message", (raw: any) => {
            try {
              const msg = JSON.parse(raw.toString());
              if (msg?.type === "output" && typeof msg.chunk === "string") out += msg.chunk;
              if (msg?.type === "assist") sawAssist = true;
            } catch {
              // ignore
            }
          });
        },
      },
    );

    ws.send(JSON.stringify({ type: "input", text: "hello\r" }));
    await waitFor(() => out.includes("hello"));
    await waitFor(() => sawAssist);

    const ev = await app.inject({
      method: "GET",
      url: `/api/sessions/${encodeURIComponent(id)}/events?limit=200`,
      headers: { authorization: "Bearer t123" },
    });
    expect(ev.statusCode).toBe(200);
    const items = JSON.parse(ev.payload).items as any[];
    expect(items.some((e) => e && e.kind === "input")).toBe(true);

    ws.close();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  test("websockets respond to ping with pong", async () => {
    const { app, dir } = await testApp();

    // Global
    const global = await (app as any).injectWS(
      "/ws/global",
      { headers: { authorization: "Bearer t123" } },
      {
        onInit: (sock: any) => {
          // no-op
        },
      },
    );
    let sawGlobalPong = false;
    global.on("message", (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === "pong") sawGlobalPong = true;
      } catch {
        // ignore
      }
    });
    global.send(JSON.stringify({ type: "ping", ts: 123 }));
    await waitFor(() => sawGlobalPong);
    global.close();

    // Session
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { authorization: "Bearer t123", "content-type": "application/json" },
      payload: JSON.stringify({ tool: "codex", profileId: "codex.default", savePreset: false }),
    });
    const id = JSON.parse(created.payload).id as string;
    const ws = await (app as any).injectWS(`/ws/sessions/${encodeURIComponent(id)}`, { headers: { authorization: "Bearer t123" } });
    let sawPong = false;
    ws.on("message", (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === "pong") sawPong = true;
      } catch {
        // ignore
      }
    });
    ws.send(JSON.stringify({ type: "ping", ts: 456 }));
    await waitFor(() => sawPong);
    ws.close();

    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("session delete emits closing and closed before websocket closes", async () => {
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

    const types: string[] = [];
    let wsClosed = false;
    const ws = await (app as any).injectWS(`/ws/sessions/${encodeURIComponent(id)}`, { headers: { authorization: "Bearer t123" } });
    ws.on("message", (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type) types.push(String(msg.type));
      } catch {
        // ignore
      }
    });
    ws.on("close", () => {
      wsClosed = true;
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${encodeURIComponent(id)}?force=1`,
      headers: { authorization: "Bearer t123" },
    });
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.payload)?.ok).toBe(true);

    await waitFor(() => types.includes("session.closing"), 5000);
    await waitFor(() => types.includes("session.closed"), 5000);
    await waitFor(() => wsClosed, 5000);

    const after = await app.inject({
      method: "GET",
      url: `/api/sessions/${encodeURIComponent(id)}`,
      headers: { authorization: "Bearer t123" },
    });
    expect(after.statusCode).toBe(404);

    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});
