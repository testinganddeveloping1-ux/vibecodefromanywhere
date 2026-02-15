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

function pidPath() {
  return path.join(configDir(), "server.pid");
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

async function probeExistingServer(cfg: any): Promise<boolean> {
  const port = Number(cfg?.server?.port ?? 7337);
  const token = String(cfg?.auth?.token ?? "");
  if (!Number.isFinite(port) || port <= 0 || port > 65535 || !token) return false;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 450);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/doctor`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    if (!r.ok) return false;
    const j = (await r.json().catch(() => null)) as any;
    return Boolean(j?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function getAdminUrl(cfg: any): { host: string; port: number; url: string } {
  const bind = String(cfg?.server?.bind ?? "0.0.0.0");
  const port = Number(cfg?.server?.port ?? 7337);
  const token = String(cfg?.auth?.token ?? "");
  const host = bind === "0.0.0.0" ? localIp() ?? "127.0.0.1" : bind;
  const url = `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
  return { host, port, url };
}

function usage() {
  console.log(`fromyourphone

Commands:
  start        Start the server (dev-friendly)
              Default: local-only (bind 127.0.0.1)
              Options: --lan (bind 0.0.0.0), --local (bind 127.0.0.1)
  stop         Stop the running server (best-effort)
  status       Show whether the server is running
  doctor       Print install + server diagnostics
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
  const cmdArgs = process.argv.slice(3);
  if (cmd === "config") {
    console.log(configPath());
    return;
  }
  if (cmd === "doctor") {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const distServer = path.join(moduleDir, "server", "index.js"); // dist/cli.js -> dist/server/index.js
    console.log("FromYourPhone diagnostics\n");
    console.log("CLI:      " + fileURLToPath(import.meta.url));
    console.log("Server:   " + distServer + (fs.existsSync(distServer) ? "" : " (missing)"));
    console.log("Config:   " + configPath() + (fs.existsSync(configPath()) ? "" : " (missing)"));

    if (!fs.existsSync(configPath())) return;
    const cfg = readConfig();
    const running = await probeExistingServer(cfg);
    const { host, port, url } = getAdminUrl(cfg);
    console.log("");
    console.log("Running:  " + (running ? "yes" : "no"));
    console.log("Listen:   http://" + host + ":" + port);
    console.log("Admin:    " + url);

    if (!running) return;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/doctor`, { headers: { authorization: `Bearer ${String(cfg?.auth?.token ?? "")}` } });
      const j = (await r.json().catch(() => null)) as any;
      if (j && typeof j === "object") {
        console.log("");
        console.log(JSON.stringify({ app: j.app ?? null, process: j.process ?? null, tools: j.tools ?? null, workspaceRoots: j.workspaceRoots ?? null }, null, 2));
      }
    } catch {
      // ignore
    }
    return;
  }
  if (cmd === "status") {
    if (!fs.existsSync(configPath())) {
      console.log("Not running (no config yet).");
      process.exit(1);
    }
    const cfg = readConfig();
    const running = await probeExistingServer(cfg);
    const { host, port, url } = getAdminUrl(cfg);
    if (running) {
      console.log(`Running: http://${host}:${port}`);
      console.log(url);
      process.exit(0);
    }
    console.log("Not running.");
    process.exit(1);
  }
  if (cmd === "stop") {
    if (!fs.existsSync(configPath())) {
      console.log("Nothing to stop (no config yet).");
      return;
    }
    const cfg = readConfig();
    const { port } = getAdminUrl(cfg);

    const pp = pidPath();
    if (!fs.existsSync(pp)) {
      const running = await probeExistingServer(cfg);
      if (!running) {
        console.log("Not running.");
        return;
      }
      console.error("Server appears to be running, but no pid file was found.");
      console.error(`Find the process: lsof -iTCP:${port} -sTCP:LISTEN -P`);
      console.error("Then: kill <pid>");
      process.exit(1);
    }

    let pid = 0;
    try {
      const raw = fs.readFileSync(pp, "utf8");
      const j = JSON.parse(raw) as any;
      pid = Number(j?.pid ?? 0);
    } catch {
      pid = 0;
    }
    if (!pid || !Number.isFinite(pid)) {
      console.error("Pid file is invalid; delete it and try again: " + pp);
      process.exit(1);
    }

    try {
      process.kill(pid, "SIGINT");
    } catch {
      try {
        fs.unlinkSync(pp);
      } catch {
        // ignore
      }
      console.log("Not running (stale pid file removed).");
      return;
    }

    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        try {
          fs.unlinkSync(pp);
        } catch {
          // ignore
        }
        console.log("Stopped.");
        return;
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
    console.log("Stopped (SIGKILL).");
    return;
  }
  if (cmd !== "start") {
    usage();
    process.exit(2);
  }

  const wantsLan = cmdArgs.includes("--lan");
  const wantsLocal = cmdArgs.includes("--local");
  if (wantsLan && wantsLocal) {
    console.error("Choose only one: --lan or --local");
    process.exit(2);
  }
  const envOverride: Record<string, string> = {};
  // Secure-by-default: bind locally unless user opts into LAN exposure explicitly.
  envOverride.FYP_BIND = wantsLan ? "0.0.0.0" : "127.0.0.1";

  // The server will create a full config if missing; keep this helper lightweight.
  if (!fs.existsSync(configPath())) {
    console.log(`Config missing; it will be created at: ${configPath()}`);
  }

  // If the server is already running, don't crash with EADDRINUSE.
  if (fs.existsSync(configPath())) {
    try {
      const cfg = readConfig();
      if (await probeExistingServer(cfg)) {
        const { host, port, url } = getAdminUrl(cfg);
        console.log(`Already running: http://${host}:${port}`);
        console.log(url + "\n");
        qrcode.generate(url, { small: true });
        return;
      }
    } catch {
      // ignore
    }
  }

  // Resolve server entry relative to the installed CLI, not the user's cwd.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const distServer = path.join(moduleDir, "server", "index.js"); // when installed: dist/cli.js -> dist/server/index.js

  const repoRoot = findRepoRoot(moduleDir) ?? findRepoRoot(process.cwd()) ?? process.cwd();
  const devServer = path.join(repoRoot, "server", "src", "index.ts");

  const runner = fs.existsSync(distServer)
    ? { bin: process.execPath, args: [distServer] }
    : { bin: "npx", args: ["tsx", devServer] };

  const child = spawn(runner.bin, runner.args, { stdio: "inherit", env: { ...(process.env as any), ...envOverride } });

  // Ensure Ctrl+C reliably tears down the child (and its fastify server).
  let signaled = false;
  const forward = (sig: NodeJS.Signals) => {
    if (signaled) return;
    signaled = true;
    try {
      child.kill(sig);
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 5000).unref?.();
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
