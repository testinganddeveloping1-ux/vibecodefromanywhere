# FromYourPhone

Self-hosted phone UI that lets you run **OpenCode**, **Codex CLI**, or **Claude Code** on a computer/VPS and control it from your phone:

- Send messages cleanly
- Interrupt and continue
- Switch tool/profile presets (tool-native flags; startup macros optional)
- See full terminal rendering (ANSI) + input/action history
- Browse tool-native sessions (Codex/Claude) with chat history + resume/fork

## Quick Start (Local)

### Option A: No Git (Fastest)

```bash
curl -fsSL https://raw.githubusercontent.com/testinganddeveloping1-ux/vibecodefromanywhere/main/quick-install.sh | bash
fromyourphone start
```

If your shell can’t find `fromyourphone`:

```bash
export PATH="$(npm config get prefix)/bin:$PATH"
```

### Option B: Git Clone

```bash
git clone https://github.com/testinganddeveloping1-ux/vibecodefromanywhere.git
cd vibecodefromanywhere
./install.sh --global
fromyourphone start
```

By default it binds to `127.0.0.1` (local-only) and prints a local admin link (token).

For phone access on the same WiFi/LAN, start with:

```bash
fromyourphone start --lan
```

In `--lan` mode it prints:
- A **pair** QR/link (recommended, no token) that sets an `httpOnly` cookie on the phone after you scan it.
- A **token** admin link (fallback, long).

If you want a token QR too, set `FYP_SHOW_TOKEN_QR=1` before starting.

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

## Tool Sessions (Chat History)

In **Projects**, each workspace shows **Tool Sessions** discovered from the host:
- Codex: `~/.codex/sessions/**/*.jsonl`
- Claude: `~/.claude/projects/*/sessions-index.json` + session logs

You can tap a tool session to view a chat-style history and resume or fork it into a live terminal session.

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
- Phone/host UI (backend-served, production-like): `http://127.0.0.1:7337`

`npm run dev` now watches and rebuilds `dist/web` continuously, so the backend-served UI always reflects your latest frontend changes.

If you also want Vite's standalone dev server:

```bash
npm run dev:web
```

- Vite UI: `http://127.0.0.1:5173`

## CLI (Optional)

If you want a dedicated command, after `npm run build` you can run:

```bash
node dist/cli.js start
```

## Security

- Access is protected by a high-entropy token.
- The first request with `?token=...` upgrades to an `httpOnly` cookie, so assets + websockets work cleanly.
- For “best encryption with least hassle,” use Tailscale.
