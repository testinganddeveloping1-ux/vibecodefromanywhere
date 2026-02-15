#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as TOML from "@iarna/toml";
import qrcode from "qrcode-terminal";

function configDir() {
  return path.join(os.homedir(), ".fromyourphone");
}

function configPath() {
  return path.join(configDir(), "config.toml");
}

function localIp(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const items = ifaces[name] ?? [];
    for (const i of items) {
      if (!i || i.internal) continue;
      if (i.family === "IPv4") return i.address;
    }
  }
  return null;
}

function readConfig(): any {
  const p = configPath();
  const raw = fs.readFileSync(p, "utf8");
  return TOML.parse(raw);
}

function usage() {
  console.log(`fromyourphone

Commands:
  start        Start the server (dev-friendly)
  config       Print config path
`);
}

function findRepoRoot(startDir: string): string | null {
  // Walk upward looking for this repo layout.
  let dir = startDir;
  for (let i = 0; i < 7; i++) {
    const serverEntry = path.join(dir, "server", "src", "index.ts");
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(serverEntry) && fs.existsSync(pkg)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function main() {
  const cmd = process.argv[2] ?? "start";
  if (cmd === "config") {
    console.log(configPath());
    return;
  }
  if (cmd !== "start") {
    usage();
    process.exit(2);
  }

  // The server will create a full config if missing; keep this helper lightweight.
  if (!fs.existsSync(configPath())) {
    console.log(`Config missing; it will be created at: ${configPath()}`);
  }

  // Resolve server entry relative to the installed CLI, not the user's cwd.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const distServer = path.join(moduleDir, "server", "index.js"); // when installed: dist/cli.js -> dist/server/index.js

  const repoRoot = findRepoRoot(moduleDir) ?? findRepoRoot(process.cwd()) ?? process.cwd();
  const devServer = path.join(repoRoot, "server", "src", "index.ts");

  const runner = fs.existsSync(distServer)
    ? { bin: process.execPath, args: [distServer] }
    : { bin: "npx", args: ["tsx", devServer] };

  const child = spawn(runner.bin, runner.args, { stdio: "inherit" });

  // Best-effort: print a QR after a brief delay, once config exists.
  setTimeout(() => {
    try {
      if (!fs.existsSync(configPath())) return;
      const cfg = readConfig();
      const host = localIp() ?? "127.0.0.1";
      const url = `http://${host}:${cfg.server?.port ?? 7337}/?token=${encodeURIComponent(
        cfg.auth?.token ?? "",
      )}`;
      console.log("\nScan to open on your phone:\n" + url + "\n");
      qrcode.generate(url, { small: true });
      console.log("\nTip (encrypted, no port forwarding): use Tailscale and run:");
      console.log("  tailscale serve https / http://127.0.0.1:" + (cfg.server?.port ?? 7337));
      console.log("");
    } catch {
      // ignore
    }
  }, 1200);

  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
