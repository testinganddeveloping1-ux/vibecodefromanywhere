#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

function isLoopbackBind(bind: string): boolean {
  const b = String(bind ?? "").trim().toLowerCase();
  return b === "127.0.0.1" || b === "::1" || b === "localhost";
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

async function startPairUrl(host: string, port: number, token: string): Promise<string> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/auth/pair/start?token=${encodeURIComponent(token)}`, { method: "POST" });
    if (!r.ok) return "";
    const j = (await r.json().catch(() => null)) as any;
    const code = typeof j?.code === "string" ? j.code : "";
    if (!code) return "";
    return `http://${host}:${port}/?pair=${encodeURIComponent(code)}`;
  } catch {
    return "";
  }
}

async function printRemoteAccess(host: string, port: number, token: string): Promise<void> {
  const adminUrl = `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
  const pairUrl = await startPairUrl(host, port, token);
  if (pairUrl) {
    console.log("\nScan on phone (recommended): Pair link");
    console.log(pairUrl + "\n");
    qrcode.generate(pairUrl, { small: true });
    console.log("\nFallback (manual): Token link");
    console.log(adminUrl + "\n");
    return;
  }
  console.log("\nPair endpoint unavailable, using token link:");
  console.log(adminUrl + "\n");
  qrcode.generate(adminUrl, { small: true });
}

function usage() {
  console.log(`fromyourphone

Commands:
  start        Start the server (dev-friendly)
              Default: local-only (bind 127.0.0.1)
              Options: --lan (bind 0.0.0.0), --local (bind 127.0.0.1)
  orchestrate  Launch a coordinator + worker orchestration from a JSON spec
              Options: --file <spec.json>  or  --json '<spec-json>'
  orchestrations
              List recent orchestrations
  orchestration <id>
              Show orchestration details/status
  orchestration-sync <id>
              Push a read-only worker digest to the coordinator
              Options: --force --no-deliver --trigger <text>
  orchestration-policy <id>
              Configure orchestration sync policy
              Options: --mode <off|manual|interval> --interval-ms <n> --deliver --no-deliver --run-now
  orchestration-cleanup <id>
              Cleanup sessions/worktrees for an orchestration
              Options: --delete-sessions --remove-record
  stop         Stop the running server (best-effort)
  status       Show whether the server is running
  doctor       Print install + server diagnostics
  config       Print config path
`);
}

function readFlag(args: string[], name: string): string {
  const i = args.indexOf(name);
  if (i < 0) return "";
  return args[i + 1] ?? "";
}

async function callServer(cfg: any, pathAndQuery: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const port = Number(cfg?.server?.port ?? 7337);
  const token = String(cfg?.auth?.token ?? "");
  const url = `http://127.0.0.1:${port}${pathAndQuery}`;
  const headers = {
    authorization: `Bearer ${token}`,
    ...(init?.headers ?? {}),
  } as Record<string, string>;
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
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

function isDevRepoRoot(dir: string): boolean {
  const pkg = path.join(dir, "package.json");
  const serverSrc = path.join(dir, "server", "src", "index.ts");
  const webSrc = path.join(dir, "web", "src", "ui", "App.tsx");
  return fs.existsSync(pkg) && fs.existsSync(serverSrc) && fs.existsSync(webSrc);
}

function runBuild(repoRoot: string): boolean {
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npmBin, ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env as any,
  });
  return Number(r?.status ?? 1) === 0;
}

async function stopRunningServerByPid(cfg: any): Promise<boolean> {
  const pp = pidPath();
  if (!fs.existsSync(pp)) return false;

  let pid = 0;
  try {
    const raw = fs.readFileSync(pp, "utf8");
    const j = JSON.parse(raw) as any;
    pid = Number(j?.pid ?? 0);
  } catch {
    pid = 0;
  }
  if (!pid || !Number.isFinite(pid)) return false;

  try {
    process.kill(pid, "SIGINT");
  } catch {
    try {
      fs.unlinkSync(pp);
    } catch {
      // ignore
    }
    return true;
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
      return true;
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(pp);
  } catch {
    // ignore
  }
  const stillRunning = await probeExistingServer(cfg);
  return !stillRunning;
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
  if (cmd === "orchestrate") {
    if (!fs.existsSync(configPath())) {
      console.error("Config missing. Start the server once first: fromyourphone start");
      process.exit(1);
    }
    const cfg = readConfig();
    const running = await probeExistingServer(cfg);
    if (!running) {
      console.error("Server is not running. Start it first: fromyourphone start");
      process.exit(1);
    }

    const file = readFlag(cmdArgs, "--file");
    const rawJson = readFlag(cmdArgs, "--json");
    if (!file && !rawJson) {
      console.error("Provide a spec via --file <spec.json> or --json '<spec-json>'");
      process.exit(2);
    }

    let spec: any = null;
    try {
      const raw = file ? fs.readFileSync(path.resolve(file), "utf8") : rawJson;
      spec = JSON.parse(String(raw || ""));
    } catch (e: any) {
      console.error(typeof e?.message === "string" ? e.message : "invalid JSON spec");
      process.exit(2);
    }

    const out = await callServer(cfg, "/api/orchestrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
    });
    if (out.status !== 200 || !out.json?.ok) {
      console.error("Failed to create orchestration:");
      console.error(JSON.stringify(out.json, null, 2));
      process.exit(1);
    }

    const id = String(out.json.id || "");
    const { url } = getAdminUrl(cfg);
    console.log(`Orchestration created: ${id}`);
    console.log(`Coordinator session: ${out.json.orchestratorSessionId}`);
    console.log(`Workers: ${Array.isArray(out.json.workers) ? out.json.workers.length : 0}`);
    console.log(`Check status: fromyourphone orchestration ${id}`);
    console.log(`Open on phone: ${url}`);
    return;
  }
  if (cmd === "orchestrations") {
    if (!fs.existsSync(configPath())) {
      console.error("Config missing. Start the server once first: fromyourphone start");
      process.exit(1);
    }
    const cfg = readConfig();
    const running = await probeExistingServer(cfg);
    if (!running) {
      console.error("Server is not running. Start it first: fromyourphone start");
      process.exit(1);
    }
    const out = await callServer(cfg, "/api/orchestrations");
    if (out.status !== 200 || !out.json?.ok) {
      console.error("Failed to list orchestrations:");
      console.error(JSON.stringify(out.json, null, 2));
      process.exit(1);
    }
    const items = Array.isArray(out.json.items) ? out.json.items : [];
    if (!items.length) {
      console.log("No orchestrations yet.");
      return;
    }
    for (const it of items) {
      const id = String(it?.id ?? "");
      const name = String(it?.name ?? "");
      const runningWorkers = Number(it?.runningWorkers ?? 0);
      const workerCount = Number(it?.workerCount ?? 0);
      const attention = Number(it?.attentionTotal ?? 0);
      console.log(`${id}  ${name}  workers:${runningWorkers}/${workerCount}  attention:${attention}`);
    }
    return;
  }
  if (cmd === "orchestration") {
    const id = String(cmdArgs[0] ?? "").trim();
    if (!id) {
      console.error("Usage: fromyourphone orchestration <id>");
      process.exit(2);
    }
    if (!fs.existsSync(configPath())) {
      console.error("Config missing. Start the server once first: fromyourphone start");
      process.exit(1);
    }
    const cfg = readConfig();
    const running = await probeExistingServer(cfg);
    if (!running) {
      console.error("Server is not running. Start it first: fromyourphone start");
      process.exit(1);
    }
    const out = await callServer(cfg, `/api/orchestrations/${encodeURIComponent(id)}`);
    if (out.status !== 200 || !out.json?.ok) {
      console.error("Failed to load orchestration:");
      console.error(JSON.stringify(out.json, null, 2));
      process.exit(1);
    }
    const it = out.json.item ?? {};
    console.log(`${it.id}  ${it.name}`);
    console.log(`Project: ${it.projectPath}`);
    console.log(`Coordinator: ${it.orchestratorSessionId}  running:${Boolean(it?.orchestrator?.running) ? "yes" : "no"}`);
    console.log(`Workers: ${Number(it?.runningWorkers ?? 0)}/${Number(it?.workerCount ?? 0)} running`);
    const sp = it?.sync?.policy ?? {};
    const smode = typeof sp?.mode === "string" ? sp.mode : "manual";
    const sint = Number(sp?.intervalMs ?? 0);
    const sdeliver = sp?.deliverToOrchestrator === false ? "no" : "yes";
    const slast = Number(it?.sync?.lastDigestAt ?? 0);
    console.log(`Sync: mode:${smode}  intervalMs:${sint || "-"}  deliver:${sdeliver}  last:${slast ? new Date(slast).toISOString() : "-"}`);
    console.log("");
    const workers = Array.isArray(it?.workers) ? it.workers : [];
    for (const w of workers) {
      const nm = String(w?.name ?? "");
      const sid = String(w?.sessionId ?? "");
      const runningW = Boolean(w?.running);
      const branch = typeof w?.branch === "string" ? w.branch : "";
      const wt = typeof w?.worktreePath === "string" ? w.worktreePath : "";
      console.log(`- ${nm}  session:${sid}  running:${runningW ? "yes" : "no"}`);
      if (branch) console.log(`  branch: ${branch}`);
      if (wt) console.log(`  worktree: ${wt}`);
    }
    return;
  }
  if (cmd === "orchestration-sync") {
    const id = String(cmdArgs[0] ?? "").trim();
    if (!id) {
      console.error("Usage: fromyourphone orchestration-sync <id> [--force] [--no-deliver] [--trigger <text>]");
      process.exit(2);
    }
    if (!fs.existsSync(configPath())) {
      console.error("Config missing. Start the server once first: fromyourphone start");
      process.exit(1);
    }
    const cfg = readConfig();
    const running = await probeExistingServer(cfg);
    if (!running) {
      console.error("Server is not running. Start it first: fromyourphone start");
      process.exit(1);
    }
    const trigger = readFlag(cmdArgs, "--trigger");
    const force = cmdArgs.includes("--force");
    const noDeliver = cmdArgs.includes("--no-deliver");
    const out = await callServer(cfg, `/api/orchestrations/${encodeURIComponent(id)}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        force,
        trigger: trigger || undefined,
        deliverToOrchestrator: noDeliver ? false : undefined,
      }),
    });
    if (out.status !== 200 || !out.json?.ok) {
      console.error("Sync failed:");
      console.error(JSON.stringify(out.json, null, 2));
      process.exit(1);
    }
    const s = out.json.sync ?? {};
    const h = String(s?.digest?.hash ?? "");
    console.log(`Sync ${s?.sent ? "sent" : "not sent"} (${String(s?.reason ?? "unknown")})`);
    if (h) console.log(`Digest: ${h}`);
    const preview = typeof s?.digest?.text === "string" ? s.digest.text.split("\n").slice(0, 10).join("\n") : "";
    if (preview) {
      console.log("");
      console.log(preview);
      if (String(s?.digest?.text ?? "").split("\n").length > 10) console.log("...");
    }
    if (!s?.sent && s?.reason !== "unchanged" && s?.reason !== "collect_only") process.exit(1);
    return;
  }
  if (cmd === "orchestration-policy") {
    const id = String(cmdArgs[0] ?? "").trim();
    if (!id) {
      console.error("Usage: fromyourphone orchestration-policy <id> --mode <off|manual|interval> [--interval-ms <n>] [--deliver|--no-deliver] [--run-now]");
      process.exit(2);
    }
    if (!fs.existsSync(configPath())) {
      console.error("Config missing. Start the server once first: fromyourphone start");
      process.exit(1);
    }
    const cfg = readConfig();
    const running = await probeExistingServer(cfg);
    if (!running) {
      console.error("Server is not running. Start it first: fromyourphone start");
      process.exit(1);
    }

    const mode = readFlag(cmdArgs, "--mode");
    const intervalRaw = readFlag(cmdArgs, "--interval-ms");
    const runNow = cmdArgs.includes("--run-now");
    const force = cmdArgs.includes("--force");
    const payload: any = {};
    if (mode) payload.mode = mode;
    if (intervalRaw) payload.intervalMs = Number(intervalRaw);
    if (cmdArgs.includes("--deliver")) payload.deliverToOrchestrator = true;
    if (cmdArgs.includes("--no-deliver")) payload.deliverToOrchestrator = false;
    if (runNow) payload.runNow = true;
    if (force) payload.force = true;

    const out = await callServer(cfg, `/api/orchestrations/${encodeURIComponent(id)}/sync-policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (out.status !== 200 || !out.json?.ok) {
      console.error("Policy update failed:");
      console.error(JSON.stringify(out.json, null, 2));
      process.exit(1);
    }
    const sp = out.json?.sync?.policy ?? {};
    const last = Number(out.json?.sync?.lastDigestAt ?? 0);
    console.log(
      `Policy updated: mode=${String(sp?.mode ?? "manual")} intervalMs=${Number(sp?.intervalMs ?? 0) || "-"} deliver=${sp?.deliverToOrchestrator === false ? "no" : "yes"}`
    );
    console.log(`Last digest: ${last ? new Date(last).toISOString() : "-"}`);
    if (out.json?.sync?.run) {
      console.log(`Run now: ${out.json.sync.run.sent ? "sent" : "not sent"} (${String(out.json.sync.run.reason ?? "unknown")})`);
    }
    return;
  }
  if (cmd === "orchestration-cleanup") {
    const id = String(cmdArgs[0] ?? "").trim();
    if (!id) {
      console.error("Usage: fromyourphone orchestration-cleanup <id> [--delete-sessions] [--remove-record]");
      process.exit(2);
    }
    if (!fs.existsSync(configPath())) {
      console.error("Config missing. Start the server once first: fromyourphone start");
      process.exit(1);
    }
    const cfg = readConfig();
    const running = await probeExistingServer(cfg);
    if (!running) {
      console.error("Server is not running. Start it first: fromyourphone start");
      process.exit(1);
    }
    const deleteSessions = cmdArgs.includes("--delete-sessions");
    const removeRecord = cmdArgs.includes("--remove-record");
    const out = await callServer(cfg, `/api/orchestrations/${encodeURIComponent(id)}/cleanup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stopSessions: true,
        deleteSessions,
        removeWorktrees: true,
        removeRecord,
      }),
    });
    if (out.status !== 200 || typeof out.json?.ok !== "boolean") {
      console.error("Cleanup failed:");
      console.error(JSON.stringify(out.json, null, 2));
      process.exit(1);
    }
    console.log(`Cleanup ${out.json.ok ? "completed" : "completed with errors"} for ${id}`);
    console.log(JSON.stringify(out.json.summary ?? {}, null, 2));
    if (!out.json.ok) process.exit(1);
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
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(moduleDir) ?? findRepoRoot(process.cwd()) ?? process.cwd();
  if (isDevRepoRoot(repoRoot)) {
    console.log("Building latest files...");
    if (!runBuild(repoRoot)) {
      console.error("Build failed. Start aborted.");
      process.exit(1);
    }
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
        console.log("Server already running. Restarting to apply latest build...");
        const stopped = await stopRunningServerByPid(cfg);
        if (!stopped) {
          const { host, port } = getAdminUrl(cfg);
          console.error(`Could not stop existing server on http://${host}:${port}.`);
          console.error("Run `fromyourphone stop` first, then `fromyourphone start`.");
          process.exit(1);
        }
      }
    } catch {
      // ignore
    }
  }

  // Resolve server entry relative to the installed CLI, not the user's cwd.
  const distServer = path.join(moduleDir, "server", "index.js"); // when installed: dist/cli.js -> dist/server/index.js
  const localDistServer = path.join(repoRoot, "dist", "server", "index.js");
  const devServer = path.join(repoRoot, "server", "src", "index.ts");
  const preferLocalDist = isDevRepoRoot(repoRoot) && fs.existsSync(localDistServer);
  const selectedDistServer = preferLocalDist ? localDistServer : distServer;

  const runner = fs.existsSync(selectedDistServer)
    ? { bin: process.execPath, args: [selectedDistServer] }
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
