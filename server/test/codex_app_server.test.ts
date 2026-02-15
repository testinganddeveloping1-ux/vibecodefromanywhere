import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexAppServer } from "../src/codex_app_server.js";

describe("CodexAppServer (stdio)", () => {
  it("initializes, emits server requests, and supports call/respond", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const stub = path.join(here, "fixtures", "fake_codex_app_server.mjs");

    const app = new CodexAppServer({
      codexCommand: process.execPath,
      codexArgs: [stub],
      log: () => {},
    });

    const reqP = new Promise<any>((resolve) => {
      app.on("request", (r: any) => resolve(r));
    });
    const notifP = new Promise<any>((resolve) => {
      app.on("notification", (n: any) => {
        if (n?.method === "test/responseReceived") resolve(n);
      });
    });

    await app.ensureStarted();

    const r = await app.call<any>("thread/list", { limit: 1 });
    expect(r?.method).toBe("thread/list");

    const req = await reqP;
    expect(req?.method).toBe("item/fileChange/requestApproval");
    expect(req?.id).toBe(99);

    app.respond(req.id, { decision: "accept" });

    const notif = await notifP;
    expect(notif?.params?.id).toBe(99);
    expect(notif?.params?.result).toEqual({ decision: "accept" });

    app.stop();
  });
});

