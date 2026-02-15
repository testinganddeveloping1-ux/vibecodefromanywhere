import { configDir, loadOrCreateConfig } from "./config.js";
import { buildApp } from "./app.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import qrcode from "qrcode-terminal";

const cfg = await loadOrCreateConfig();

async function probeExistingServer(): Promise<boolean> {
  // Avoid crashing with EADDRINUSE when a server is already running.
  // We check our own /api/doctor endpoint with the configured token.
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 450);
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.server.port}/api/doctor`, {
      headers: { authorization: `Bearer ${cfg.auth.token}` },
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

const host = cfg.server.bind === "0.0.0.0" ? localIp() ?? "127.0.0.1" : cfg.server.bind;
const adminUrl = `http://${host}:${cfg.server.port}/?token=${encodeURIComponent(cfg.auth.token)}`;

if (await probeExistingServer()) {
  console.log(`FromYourPhone already running on http://${host}:${cfg.server.port}`);
  console.log(`Admin link (token): ${adminUrl}\n`);
  qrcode.generate(adminUrl, { small: true });
  process.exit(0);
}

const hookHostRaw = cfg.server.bind === "0.0.0.0" || cfg.server.bind === "::" ? "127.0.0.1" : cfg.server.bind;
const hookHost = hookHostRaw.includes(":") && !hookHostRaw.startsWith("[") ? `[${hookHostRaw}]` : hookHostRaw;
const app = await buildApp({
  token: cfg.auth.token,
  tools: cfg.tools,
  profiles: cfg.profiles,
  workspaces: cfg.workspaces,
  hookBaseUrl: `http://${hookHost}:${cfg.server.port}`,
});

try {
  await app.listen({ host: cfg.server.bind, port: cfg.server.port });
} catch (e: any) {
  if (e?.code === "EADDRINUSE") {
    console.error(`Port already in use: ${cfg.server.bind}:${cfg.server.port}`);
    console.error(`If FromYourPhone is already running, open: http://${host}:${cfg.server.port}`);
    console.error(`To find the process: lsof -iTCP:${cfg.server.port} -sTCP:LISTEN -P`);
    process.exit(1);
  }
  throw e;
}

const pidPath = path.join(configDir(), "server.pid");
function writePidFile() {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(
      pidPath,
      JSON.stringify({ pid: process.pid, port: cfg.server.port, bind: cfg.server.bind, startedAt: Date.now() }),
      "utf8",
    );
  } catch {
    // ignore
  }
}
function clearPidFile() {
  try {
    if (!fs.existsSync(pidPath)) return;
    const raw = fs.readFileSync(pidPath, "utf8");
    const j = JSON.parse(raw) as any;
    if (Number(j?.pid ?? -1) === process.pid) fs.unlinkSync(pidPath);
  } catch {
    try {
      if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
    } catch {
      // ignore
    }
  }
}

writePidFile();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    console.log(`\nShutting down (${signal})...`);
  } catch {
    // ignore
  }
  try {
    await app.close();
  } catch {
    // ignore
  } finally {
    clearPidFile();
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`FromYourPhone listening on http://${cfg.server.bind}:${cfg.server.port}`);

// Pairing QR: lets a new device claim the httpOnly cookie without typing/pasting the long token.
let pairUrl = "";
try {
  const r = await fetch(`http://127.0.0.1:${cfg.server.port}/api/auth/pair/start?token=${encodeURIComponent(cfg.auth.token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (r.ok) {
    const j = (await r.json()) as any;
    const code = typeof j?.code === "string" ? j.code : "";
    if (code) {
      pairUrl = `http://${host}:${cfg.server.port}/?pair=${encodeURIComponent(code)}`;
    }
  }
} catch {
  // ignore
}

if (pairUrl) {
  console.log(`\nScan on phone (recommended): Pair link (no token)`);
  console.log(`${pairUrl}\n`);
  qrcode.generate(pairUrl, { small: true });
  console.log(`\nFallback: Token link (long)`);
  console.log(`${adminUrl}\n`);
  qrcode.generate(adminUrl, { small: true });
} else {
  console.log(`\nScan on phone: Token link`);
  console.log(`${adminUrl}\n`);
  qrcode.generate(adminUrl, { small: true });
}

console.log("\nTip (encrypted, no port forwarding):");
console.log(`  tailscale serve https / http://127.0.0.1:${cfg.server.port}`);
console.log("\nTip (encrypted, no account, random URL):");
console.log(`  cloudflared tunnel --url http://127.0.0.1:${cfg.server.port}`);
console.log("");
