# FromYourPhone

Self-hosted phone UI that lets you run **OpenCode**, **Codex CLI**, or **Claude Code** on a computer/VPS and control it from your phone:

- Send messages cleanly
- Interrupt and continue
- Switch tool/profile presets (tool-native flags; startup macros optional)
- See full terminal rendering (ANSI) + session history

## Quick Start (LAN)

```bash
git clone <this-repo-url>
cd vibecodefromanywhere
./install.sh
npm start
```

It prints:

- An **admin** QR/link that includes the token (works immediately).
- A **pair** QR/link (no token) that sets an `httpOnly` cookie on the phone after you scan it.

Open it on your phone while on the same WiFi.

## Quick Start (Encrypted, Remote)

Recommended: **Tailscale** (fast + secure).

1. Install and connect Tailscale on the host.
2. Start the server: `fromyourphone start`
3. Serve it over your tailnet:

```bash
tailscale serve https / http://127.0.0.1:7337
```

Then open the Tailscale HTTPS URL on your phone (while connected to the same tailnet).

Alternative: **Cloudflare Tunnel (quick tunnel)** (encrypted, no account, random URL):

```bash
cloudflared tunnel --url http://127.0.0.1:7337
```

## Configure Tools / Profiles

Config file:

`~/.fromyourphone/config.toml`

- `tools.codex.command` / `tools.claude.command` / `tools.opencode.command`
- Prefer `profiles.*.codex` / `profiles.*.claude` / `profiles.*.opencode` (tool-native flags)
- `profiles.*.startup` is a fallback for custom key macros (less reliable)

Notes:
- Tool flags/modes change across versions. If a macro doesn’t work, tweak it in `config.toml`.
- The UI always streams the real TUI/terminal, so you can still operate manually even if a macro is imperfect.

## Tool Capability Detection

Open `/api/doctor` (requires token) to see what this machine’s installed tools support:

- Codex CLI: `--sandbox`, `--ask-for-approval`, `--dangerously-bypass-approvals-and-sandbox`, `--cd`, etc
- Claude Code: `--permission-mode`, `--dangerously-skip-permissions`
- OpenCode: `--agent`, `serve`, `web`, `attach`

## Development

```bash
npm run dev
```

Open:
- UI: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:7337`

## CLI (Optional)

If you want a dedicated command, after `npm run build` you can run:

```bash
node dist/cli.js start
```

## Security

- Access is protected by a high-entropy token.
- The first request with `?token=...` upgrades to an `httpOnly` cookie, so assets + websockets work cleanly.
- For “best encryption with least hassle,” use Tailscale.
