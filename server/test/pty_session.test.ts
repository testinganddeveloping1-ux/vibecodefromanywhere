import { describe, expect, test } from "vitest";
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
});
