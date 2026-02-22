# FromYourPhone

Self-hosted phone UI that lets you run **OpenCode**, **Codex CLI**, or **Claude Code** on a computer/VPS and control it from your phone:

- Send messages cleanly
- Interrupt and continue
- Switch tool/profile presets (tool-native flags; startup macros optional)
- See full terminal rendering (ANSI) + input/action history
- Browse tool-native sessions (Codex/Claude) with chat history + resume/fork

## Project Status

Last updated: 2026-02-22

- Working now:
  - User-level install flow (`quick-install.sh`, `install.sh --global` to `~/.local/bin`)
  - Local/LAN start flows
  - Multi-session terminal control from phone UI
  - Basic orchestrator + worker lifecycle (create, dispatch, sync, cleanup)
- Update in progress:
  - Orchestrator-worker workflow with stronger objective consideration
  - Auto-approve style automation paths for worker questions/dispatch policy
- Warning:
  - `NOT TESTED` for real production codebases yet
  - Do not run this on critical repos without manual review
  - For now, prefer terminal-first/manual modes and isolated sandbox repos

## Quick Start (Local)

### Option A: No Git (Fastest)

```bash
curl -fsSL https://raw.githubusercontent.com/testinganddeveloping1-ux/vibecodefromanywhere/main/quick-install.sh | bash
fromyourphone start
```

Install + start immediately in one command:

```bash
curl -fsSL https://raw.githubusercontent.com/testinganddeveloping1-ux/vibecodefromanywhere/main/quick-install.sh | bash -s -- --start
```

Install + start with LAN exposure:

```bash
curl -fsSL https://raw.githubusercontent.com/testinganddeveloping1-ux/vibecodefromanywhere/main/quick-install.sh | bash -s -- --start --lan
```

If your shell can’t find `fromyourphone`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

`quick-install.sh` also supports:
- `--method auto|git|tarball`
- `--repo <org/repo>`
- `--branch <name>`
- `--base-dir <path>`
- `--bin-dir <path>`

### Option B: Git Clone

```bash
git clone https://github.com/testinganddeveloping1-ux/vibecodefromanywhere.git
cd vibecodefromanywhere
./install.sh --global
fromyourphone start
```

## AI Agent Install Playbook

Use this when you want another CLI/agent to install this project safely and predictably.

### Guardrails

- Do not use `sudo`.
- Install for the current user only (`~/.fromyourphone`, `~/.local/bin`).
- Follow `Quick Start (Local)` exactly unless user explicitly asks for a different method.
- Print executed commands and verification output.

### One-shot command (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/testinganddeveloping1-ux/vibecodefromanywhere/main/quick-install.sh | bash -s -- --start
```

LAN mode:

```bash
curl -fsSL https://raw.githubusercontent.com/testinganddeveloping1-ux/vibecodefromanywhere/main/quick-install.sh | bash -s -- --start --lan
```

### Post-install verification

```bash
command -v fromyourphone
fromyourphone --help
```

If command not found:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v fromyourphone
```

### Copy/paste prompt for agents

```text
Read README.md in this repo and install FromYourPhone exactly as documented.

Rules:
- Do NOT use sudo.
- Use user-level install only (~/.fromyourphone, ~/.local/bin).
- Prefer quick installer:
  curl -fsSL https://raw.githubusercontent.com/testinganddeveloping1-ux/vibecodefromanywhere/main/quick-install.sh | bash -s -- --start
- If fromyourphone is not found, run:
  export PATH="$HOME/.local/bin:$PATH"

Verify with:
1) command -v fromyourphone
2) fromyourphone --help

Then print:
- commands executed
- key output
- final status: PASS or FAIL
- any PATH fix needed
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

## Orchestrate Multiple Worker CLIs

You can launch a coordinator session plus multiple worker sessions (with per-worker git worktrees/branches) from one JSON spec:

```json
{
  "name": "multi-feature",
  "projectPath": "/absolute/path/to/repo",
  "orchestrator": {
    "tool": "codex",
    "profileId": "codex.default",
    "prompt": "Coordinate workers, track status, and synthesize results."
  },
  "workers": [
    { "name": "api", "taskPrompt": "Implement API endpoint + tests." },
    { "name": "ui", "taskPrompt": "Build UI for the endpoint." }
  ]
}
```

Run:

```bash
fromyourphone orchestrate --file orchestration.json
```

Then check status:

```bash
fromyourphone orchestrations
fromyourphone orchestration <id>
fromyourphone orchestration-sync <id>
fromyourphone orchestration-policy <id> --mode interval --interval-ms 120000 --run-now
fromyourphone orchestration-cleanup <id>
```

Notes:
- By default, workers are isolated with git worktrees and branch names like `fyp/orch-.../<worker>`.
- Set `"isolated": false` per worker to run directly in the target project path.
- Workers can point at different projects with `"projectPath": "/another/project"`.
- Dispatch mode defaults to `orchestrator-first`: workers are created idle, then the orchestrator dispatches prompts.
- Set `"dispatchMode": "worker-first"` if you want backend to send worker prompts during creation.
- Cleanup is lock-protected and idempotent: it can stop worker/coordinator sessions and remove worker worktrees safely.
- Sync is non-interrupting by default (`manual` mode): workers keep running independently, and the coordinator only receives a digest when you explicitly trigger sync.
- You can switch to timed digests with `orchestration-policy --mode interval --interval-ms <ms>`.
- `orchestration-sync --no-deliver` collects an up-to-date digest without sending anything to the coordinator session.
- Orchestration automation policy is API-driven:
  - `GET /api/orchestrations/:id/automation-policy`
  - `PATCH /api/orchestrations/:id/automation-policy`
  - Fields: `questionMode`, `steeringMode`, `questionTimeoutMs`, `reviewIntervalMs`, `yoloMode`.
  - Use `runNow: true` on PATCH to trigger an immediate orchestrator review.

## Harness APIs (Creator / Improver Prompts)

Backend exposes orchestration-planning helpers:

- `GET /api/harness/prompts`
  - Returns built-in system prompts:
    - generic knowledge
    - creator system
    - improver system
  - Returns default agent command catalog.
- `POST /api/harness/creator/recommend`
  - Input: objective + optional workspace scan prefs.
  - Output: recommended creator profile, orchestrator profile/prompt, worker plan, notes, confidence.
- `POST /api/harness/creator/build`
  - Input: objective + projectPath + optional behavior controls.
  - Output: ready `POST /api/orchestrations` payload plus sync-policy/automation follow-up action templates.
- `GET /api/harness/commands`
  - Returns executable harness command catalog with default execution modes.
  - Includes per-command payload schema + command-specific required field rules.
  - Includes per-command policy metadata (`tier`, `requirements`).
- `GET /api/harness/sota-audit`
  - Audits live installed skill corpus coverage and quality against executable command contracts.
  - Returns per-domain counts/quality plus per-command support score/confidence.
- `POST /api/orchestrations/:id/commands/execute`
  - Executes a command id (`diag-evidence`, `review-hard`, `sync-status`, etc.) with dispatch/system routing.
  - Enforces per-command payload schema validation before execution.
  - Enforces command policy by risk tier and returns `command_policy_blocked` when unmet.
  - High-risk emergency bypass is env-gated: `FYP_HARNESS_POLICY_ALLOW_HIGH_RISK=1` + request `policyOverride=true`.
  - Supports `idempotency-key` header or `idempotencyKey` body field to safely replay client retries.
  - Replay cache is persisted in SQLite so idempotent replays remain valid across server restarts.

Detailed architecture notes:
- `docs/orchestrator-core.md`
- `docs/frontend-handoff.md`
- `docs/maintainer-quick-map.md`
- `docs/agent-command-library/README.md`
- `docs/agent-command-library/06-skill-crosswalk-security-orchestration.md`
- `docs/agent-command-library/07-skill-crosswalk-frontend-mobile.md`
- `docs/agent-command-library/08-command-automation-recipes.md`
- `docs/agent-command-library/09-sota-gap-matrix.md`
- `docs/agent-command-library/10-threat-modeling-and-sast-pipeline.md`
- `docs/agent-command-library/11-debug-hypothesis-lab.md`
- `docs/agent-command-library/12-testing-verification-review-gates.md`
- `docs/agent-command-library/13-auth-and-session-hardening.md`
- `docs/agent-command-library/14-error-handling-and-recovery-patterns.md`
- `docs/agent-command-library/15-team-communication-and-task-governance.md`
- `docs/agent-command-library/16-parallel-execution-and-conflict-arbitration.md`
- `docs/agent-command-library/17-release-readiness-rollback-incident.md`
- `docs/agent-command-library/18-frontend-platform-parity-motion.md`
- `docs/agent-command-library/19-observability-and-slo-ops.md`
- `docs/agent-command-library/20-expanded-command-reference.md`
- `docs/agent-command-library/21-deep-research-foundations.md`
- `docs/agent-command-library/22-sota-enforcement-loop.md`
- `docs/agent-command-library/23-live-skill-provenance-model.md`
- `docs/agent-command-library/24-manual-sota-review-2026-02-21.md`

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
