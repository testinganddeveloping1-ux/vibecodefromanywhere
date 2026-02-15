import { loadOrCreateConfig } from "./config.js";
import { buildApp } from "./app.js";
import os from "node:os";
import qrcode from "qrcode-terminal";

const cfg = await loadOrCreateConfig();
const hookHostRaw = cfg.server.bind === "0.0.0.0" || cfg.server.bind === "::" ? "127.0.0.1" : cfg.server.bind;
const hookHost = hookHostRaw.includes(":") && !hookHostRaw.startsWith("[") ? `[${hookHostRaw}]` : hookHostRaw;
const app = await buildApp({
  token: cfg.auth.token,
  tools: cfg.tools,
  profiles: cfg.profiles,
  workspaces: cfg.workspaces,
  hookBaseUrl: `http://${hookHost}:${cfg.server.port}`,
});

await app.listen({ host: cfg.server.bind, port: cfg.server.port });

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

console.log(`FromYourPhone listening on http://${cfg.server.bind}:${cfg.server.port}`);
console.log(`Admin link (token): ${adminUrl}\n`);
qrcode.generate(adminUrl, { small: true });

// Pairing QR: lets a new device claim the httpOnly cookie without typing/pasting the long token.
try {
  const r = await fetch(`http://127.0.0.1:${cfg.server.port}/api/auth/pair/start?token=${encodeURIComponent(cfg.auth.token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (r.ok) {
    const j = (await r.json()) as any;
    const code = typeof j?.code === "string" ? j.code : "";
    if (code) {
      const pairUrl = `http://${host}:${cfg.server.port}/?pair=${encodeURIComponent(code)}`;
      console.log(`\nPair link (no token): ${pairUrl}\n`);
      qrcode.generate(pairUrl, { small: true });
    }
  }
} catch {
  // ignore
}

console.log("\nTip (encrypted, no port forwarding):");
console.log(`  tailscale serve https / http://127.0.0.1:${cfg.server.port}`);
console.log("\nTip (encrypted, no account, random URL):");
console.log(`  cloudflared tunnel --url http://127.0.0.1:${cfg.server.port}`);
console.log("");
