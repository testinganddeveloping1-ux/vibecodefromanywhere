import { describe, expect, test, vi } from "vitest";
import { SessionManager } from "../src/sessions/session_manager";

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

describe("SessionManager (pty)", () => {
  test("spawns a pty process and streams output", async () => {
    const mgr = new SessionManager({
      token: "t",
      tools: {
        codex: { command: "bash", args: ["-lc", "cat"] },
        claude: { command: "bash", args: ["-lc", "cat"] },
        opencode: { command: "bash", args: ["-lc", "cat"] },
      },
    });

    const id = mgr.createSession({ tool: "codex", profileId: "test" });
    const chunks: string[] = [];
    mgr.onOutput(id, (d) => chunks.push(d));

    mgr.write(id, "hello\r");
    await waitFor(() => chunks.join("").includes("hello"));

    mgr.interrupt(id);
    await waitFor(() => mgr.getStatus(id)?.running === false);

    mgr.dispose();
  });

  test("close(force) while writes are in flight avoids noisy pty write errors", async () => {
    const mgr = new SessionManager({
      token: "t",
      tools: {
        codex: { command: "bash", args: ["-lc", "cat"] },
        claude: { command: "bash", args: ["-lc", "cat"] },
        opencode: { command: "bash", args: ["-lc", "cat"] },
      },
    });

    const id = mgr.createSession({ tool: "codex", profileId: "test" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 60; i += 1) mgr.write(id, `line-${i}\r`);
      await sleep(30);
      const closed = await mgr.close(id, { force: true, graceMs: 120 });
      expect(closed.existed).toBe(true);
      await sleep(80);
      const joined = errSpy.mock.calls.map((call) => call.map((v) => String(v ?? "")).join(" ")).join("\n");
      expect(joined).not.toContain("Unhandled pty write error");
    } finally {
      errSpy.mockRestore();
      mgr.dispose();
    }
  });
});
