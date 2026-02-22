import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function writeExecutable(filePath: string, contents: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

describe("claude wrapper sanitization", () => {
  test("spawns canonical claude binary instead of antigravity wrapper path", async () => {
    const prevPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fyp-test-"));
    const goodBin = path.join(dir, "good-bin");
    const wrapperPath = path.join(dir, "claude-antigravity.sh");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fake = path.join(here, "fixtures", "fake_tool.mjs");

    writeExecutable(
      wrapperPath,
      "#!/usr/bin/env bash\necho WRAPPER_USED\nwhile IFS= read -r line; do echo \"$line\"; done\n",
    );
    writeExecutable(
      path.join(goodBin, "claude"),
      `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`,
    );

    process.env.PATH = `${goodBin}${path.delimiter}${String(prevPath ?? "")}`;

    const passthroughTool = { command: process.execPath, args: [fake] };
    const app = await buildApp({
      token: "t123",
      dataDir: dir,
      tools: { codex: passthroughTool, claude: { command: wrapperPath, args: [] }, opencode: passthroughTool },
      profiles: {
        "codex.default": { tool: "codex", title: "Codex: Default", startup: [], sendSuffix: "\r" },
        "claude.default": { tool: "claude", title: "Claude: Default", startup: [], sendSuffix: "\r" },
        "opencode.default": { tool: "opencode", title: "OpenCode: Default", startup: [], sendSuffix: "\r" },
      },
    });

    try {
      await app.ready();
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer t123", "content-type": "application/json" },
        payload: JSON.stringify({ tool: "claude", profileId: "claude.default", savePreset: false }),
      });
      expect(created.statusCode).toBe(200);
      const id = JSON.parse(created.payload).id as string;

      let joined = "";
      for (let i = 0; i < 25; i += 1) {
        const tr = await app.inject({
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(id)}/transcript?limit=80`,
          headers: { authorization: "Bearer t123" },
        });
        expect(tr.statusCode).toBe(200);
        joined = (JSON.parse(tr.payload).items as Array<{ chunk: string }>).map((x) => x.chunk).join("");
        if (joined.includes("READY")) break;
        await sleep(100);
      }

      expect(joined).toContain("READY");
      expect(joined).not.toContain("WRAPPER_USED");
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
      if (prevPath == null) delete (process.env as any).PATH;
      else process.env.PATH = prevPath;
    }
  }, 30_000);
});

