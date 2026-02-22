# FromYourPhone Backend + Wrapper Handoff (Frontend Redesign Input)

## What this project is
FromYourPhone is a backend-first orchestrator that controls multiple AI coding CLIs (Codex CLI, Claude Code, OpenCode) from one server and one mobile-oriented client.

Core backend responsibilities:
- Start/stop/manage many terminal sessions safely.
- Treat each session as a task member (solo, parent, child, helper).
- Expose inbox/pending-actions for approvals and intervention.
- Normalize tool-native logs into a shared message block model for wrapper UIs.
- Keep orchestrator and workers isolated by session ID, tool session ID, and working directory.

This handoff intentionally avoids prescribing visual style.

## Non-negotiable UX/flow requirements (from product direction)
- Inbox-first default tab.
- Inbox items are only app-created tasks (single terminals, groups, orchestrator groups).
- Each task shows only critical state: title, running/pending, role, and quick action.
- Tap opens task, double-tap jumps directly to pending action target.
- Orchestrator tasks must expose child sessions clearly and fast (parent/child navigation).
- Wrapper mode is the default interaction mode.
- Terminal mode is optional and controlled by backend feature flag (`terminalModeEnabled`).
- Frontend must gracefully degrade to wrapper-only when terminal mode is disabled.
- Wrapper mode has hidden/expanded levels:
  - Hidden (default): concise “what happened” cards.
  - Expanded: raw tool input/output details.
- Slash-command wrappers must map to friendly controls (settings, permission mode, plan mode, etc.).
- Queueing behavior must support: wait, interrupt, or inject at safe boundary.
- No clutter: never show thousands of unrelated external sessions.

## Backend architecture (current)
- `server/src/app.ts`: main API + WS orchestration.
- `server/src/sessions/session_manager.ts`: PTY session lifecycle.
- `server/src/store.ts`: SQLite persistence (`sessions`, `tasks`, `task_members`, `attention_items`, etc.).
- `server/src/tool_sessions.ts`: parses native tool logs/exports into normalized summaries/messages.
- `server/src/codex_app_server.ts`: Codex native app-server transport.
- `server/src/harness.ts`: Creator/Improver/Orchestrator prompt builders + recommendation planner.

## Agent-role architecture (Creator / Orchestrator / Improver)
- Creator:
  - Produces a task execution blueprint before coding starts.
  - Recommends worker count, tool/profile split, and initial prompts.
  - Exposed by `POST /api/harness/creator/recommend`.
- Orchestrator:
  - Runs as the parent session for an orchestration.
  - Receives worker registry + command bus context first.
  - In `orchestrator-first` mode (default), workers are spawned idle and only receive first prompts when dispatched.
- Improver:
  - Maintains reusable "agent commands" and system-prompt quality guidance.
  - Exposed by `GET /api/harness/prompts` (`improverSystem`).

Important backend model split:
- **FYP session**: local server-managed terminal/runtime entity (`sessions` table).
- **Tool session**: native CLI session/thread ID (Codex/Claude/OpenCode IDs).
- **Task**: product-level grouping of one or more FYP sessions.

## Critical backend behavior to preserve
- New Codex/OpenCode sessions must not auto-link to stale pre-existing native sessions.
- Linking must be cwd-aware and spawn-time-aware.
- Session cleanup must clear transient maps and run-state flags.
- Task and inbox updates must emit websocket global invalidations (`tasks.changed`, `inbox.changed`, etc.).

## API surfaces your frontend should rely on
High-value endpoints:
- `GET /api/doctor`
- `GET /api/features`
- `GET /api/harness/prompts`
- `POST /api/harness/creator/recommend`
- `POST /api/harness/creator/build`
- `GET /api/sessions`
- `POST /api/sessions`
- `DELETE /api/sessions/:id`
- `PATCH /api/sessions/:id/mode`
- `GET /api/tasks`
- `GET /api/tasks/:id`
- `POST /api/tasks/:id/open-target`
- `PATCH /api/tasks/:id/mode`
- `PATCH /api/tasks/:id/members/:sessionId/mode`
- `POST /api/tasks/:id/archive`
- `GET /api/orchestrations`
- `GET /api/orchestrations/:id`
- `POST /api/orchestrations/:id/sync`
- `PATCH /api/orchestrations/:id/sync-policy`
- `GET /api/orchestrations/:id/automation-policy`
- `PATCH /api/orchestrations/:id/automation-policy`
- `POST /api/orchestrations/:id/dispatch`
- `GET /api/inbox`
- `POST /api/inbox/:id/respond`
- `POST /api/inbox/:id/dismiss`
- `GET /api/tool-sessions`
- `GET /api/tool-sessions/:tool/:id/messages`

Key API details:
- `/api/features` returns capability flags like:
  - `features.terminalModeEnabled` (boolean)
- `/api/tasks` hides idle tasks by default.
  - Use `GET /api/tasks?includeIdle=1` to show idle tasks.
- `/api/sessions/:id/mode` and task mode routes reject terminal mode when disabled.
- `/api/orchestrations/:id/dispatch` is the orchestrator command bus for sending prompts to workers.
- `/api/orchestrations/:id/automation-policy` controls orchestrator automation:
  - `questionMode`: `off | orchestrator`
  - `steeringMode`: `off | passive_review | active_steering`
  - `questionTimeoutMs`
  - `reviewIntervalMs`
  - `yoloMode`
  - optional `runNow` to trigger immediate review after policy change
- `/api/harness/creator/build` returns a ready-to-submit orchestration payload + behavior controls + post-create sync-policy action template.
- `POST /api/orchestrations` supports `dispatchMode`:
  - `orchestrator-first` (default): workers are created idle; orchestrator dispatches first prompts.
  - `worker-first`: backend dispatches worker prompts during creation.
- `GET /api/orchestrations/:id` includes:
  - `item.sync` (digest sync engine state)
  - `item.automation` (question routing + steering state)
- `POST /api/orchestrations` emits realtime creation phases over global WS:
  - `planning`
  - `spawning_workers`
  - `spawning_orchestrator`
  - `dispatching`
  - `running`
  - `error`

## Orchestration sync engine (current behavior)
- Sync state is lock-protected and persisted in-memory per orchestration.
- Digest generation is change-aware:
  - per-worker running state
  - pending attention count
  - branch
  - latest preview line
  - latest session event watermark (`id` + `kind`)
- Digest includes:
  - changed worker count
  - changed session IDs
  - full current worker state list
- Auto-sync (`mode: interval`) is throttled by `policy.minDeliveryGapMs` and skips noisy delivery when:
  - no meaningful worker changes
  - coordinator has pending attention items
- Sync policy fields:
  - `mode`: `off | manual | interval`
  - `intervalMs`
  - `deliverToOrchestrator`
  - `minDeliveryGapMs`

## Automation engine (current behavior)
- Worker approval/question items can be auto-routed to the orchestrator session when:
  - orchestration automation policy has `questionMode=orchestrator`
  - attention kind is supported (`claude.permission`, `codex.approval`, `codex.native.approval.*`, `codex.native.user_input`)
- Backend batches open worker questions and injects an orchestrator prompt:
  - marker: `AUTOMATION QUESTION BATCH (...)`
  - includes worker name/session, attention id, kind, title/body summary, options
- Timeout guard:
  - each pending question gets a timeout (`questionTimeoutMs`)
  - on timeout, item stays open for user; action log stores `auto_timeout`
- Steering review:
  - `steeringMode=passive_review`: summarize and intervene only for blockers/safety issues
  - `steeringMode=active_steering`: orchestrator may proactively send targeted follow-ups
  - interval driven by `reviewIntervalMs`
  - `PATCH /api/orchestrations/:id/automation-policy` supports `runNow` for immediate review
- Event stream markers written to orchestrator session:
  - `orchestration.question.open`
  - `orchestration.question.batch_dispatched`
  - `orchestration.question.timeout`
  - `orchestration.question.resolved`
  - `orchestration.review.dispatched`
  - `orchestration.review.dispatch_failed`

Realtime:
- `WS /ws`
- `WS /ws/sessions/:id`
- Global WS emits orchestration creation progress:
  - `orchestration.create.progress` with `step` (`planning|spawning_workers|spawning_orchestrator|dispatching|running|error`)

## Normalized wrapper message model (frontend contract)
Produced by `server/src/tool_sessions.ts`:

```ts
ToolSessionMessage = {
  role: "user" | "assistant";
  ts: number;
  text: string;
  blocks?: ToolSessionMessageBlock[];
}

ToolSessionMessageBlock = {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text: string;
  name?: string;   // tool name
  callId?: string; // tool invocation correlation id
}
```

Wrapper UI should render blocks, not plain concatenated text, and group by `callId` for tool lifecycle continuity.

## Real CLI schemas observed (for parser + UI mapping)

### 1) Codex CLI
CLI non-interactive JSON mode (`codex exec --json`) emits JSONL events like:

```json
{"type":"thread.started","thread_id":"..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"..."}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}
{"type":"turn.completed","usage":{"input_tokens":30258,"cached_input_tokens":9600,"output_tokens":392}}
```

Codex persisted session logs (`~/.codex/sessions/...jsonl`) include top-level `type` values:
- `session_meta`
- `response_item`
- `event_msg`
- `turn_context`
- `compacted`

Most relevant `response_item.payload.type` values:
- `message`
- `reasoning`
- `function_call`
- `function_call_output`
- `web_search_call`
- `custom_tool_call`
- `custom_tool_call_output`

Parser behavior in this project:
- Generic handling for all `*_call` payloads as `tool_use` blocks.
- Generic handling for all `*_output` payloads as `tool_result` blocks.
- This covers current call families and future call families that follow the same naming pattern.

Most relevant `event_msg.payload.type` values:
- `user_message`
- `agent_reasoning`
- `agent_message`
- `task_started`
- `task_complete`
- `token_count`
- `turn_aborted`

### 2) Claude Code
Stream JSON mode init line (captured):

```json
{
  "type":"system",
  "subtype":"init",
  "cwd":"/path",
  "session_id":"uuid",
  "tools":["Bash","Read","Edit", "..."],
  "model":"claude-opus-4-5-thinking",
  "permissionMode":"default",
  "claude_code_version":"2.1.49"
}
```

Persisted logs (`~/.claude/projects/...jsonl`) commonly contain top-level `type`:
- `user`
- `assistant`
- `progress`
- `system`
- `queue-operation`
- `file-history-snapshot`

Message content block types observed:
- `text`
- `thinking`
- `tool_use`
- `tool_result`

Tool fields in content blocks:
- `tool_use`: `id`, `name`, `input`
- `tool_result`: `tool_use_id`, `content`, optional `is_error`

### 3) OpenCode
`opencode session list --format json` shape:

```json
[
  {
    "id":"ses_xxx",
    "title":"...",
    "updated":1771383856561,
    "created":1771383833755,
    "projectId":"...",
    "directory":"/path"
  }
]
```

`opencode export <sessionId>` shape:

```json
{
  "info": {
    "id":"ses_xxx",
    "directory":"/path",
    "title":"...",
    "time":{"created":1771...,"updated":1771...}
  },
  "messages": [
    {
      "info": {"role":"user"|"assistant", "time":{"created":...}},
      "parts": [
        {"type":"text","text":"..."},
        {"type":"reasoning","text":"..."},
        {
          "type":"tool",
          "callID":"call_...",
          "tool":"bash|glob|...",
          "state":{
            "status":"completed|...",
            "input":{...},
            "output":"...",
            "time":{"start":...,"end":...}
          }
        },
        {"type":"step-start"},
        {"type":"step-finish"}
      ]
    }
  ]
}
```

Parser behavior in this project:
- `reasoning` -> `thinking` block.
- `tool` -> paired `tool_use` + `tool_result` blocks.
- `step-start` / `step-finish` are preserved as textual markers to keep interleaving visible.

## Wrapper behavior rules for the new frontend
- Keep strict chronological ordering using both timestamp + append sequence.
- Show user messages immediately (optimistic append), then reconcile on stream update.
- Tool cards should always include:
  - tool name
  - command/input summary
  - status
  - output preview
  - drill-down raw payload
- Thinking should be visually distinct but lightweight.
- Do not require expanding every block just to read command text.
- Map `callId`/`tool_use_id` across request/result for continuity.

## Orchestrator command-bus behavior
- Parent orchestrator session receives runtime env:
  - `FYP_API_BASE_URL`
  - `FYP_API_TOKEN`
  - `FYP_ORCHESTRATION_ID`
- This enables a parent CLI to:
  - dispatch work to workers (`POST /api/orchestrations/:id/dispatch`)
  - poll orchestration status (`GET /api/orchestrations/:id`)
  - use existing inbox routes for approvals (`GET /api/inbox`, `POST /api/inbox/:id/respond`)
- Design implication for frontend:
  - show parent/child boundaries clearly
  - treat dispatch actions as first-class orchestration events
  - keep approval actions accessible from Inbox and session detail

## Task/session hygiene requirements
- Inbox should prioritize actionable tasks (`pending > 0` or `running > 0`).
- Idle tasks are hidden by default at API level (`/api/tasks`); reveal with `includeIdle=1`.
- Never auto-attach a new app session to unrelated old native session logs.
- Keep app-created items separated from arbitrary machine-level terminal history.

## Model selectors requirements
Selectors must allow per-session overrides for:
- Tool (`codex`, `claude`, `opencode`)
- Profile (`*.default`, specialized profiles)
- Model override (when supported by tool/profile)
- Permission/sandbox mode controls
- Agent mode / plan mode toggles

## External frontend agent prompt (copy/paste)

You are redesigning the frontend only for an existing backend API/WS system called FromYourPhone.

Goals:
1. Build a clean, uncrowded mobile-first workflow.
2. Build wrapper mode first; support terminal mode only when backend reports `terminalModeEnabled=true`.
3. Inbox-first task flow with fast pending-action triage.
4. Preserve backend contracts exactly; do not invent incompatible schemas.

Constraints:
- Do not rewrite backend.
- Consume normalized wrapper messages with block types: text, thinking, tool_use, tool_result.
- Respect call correlation via callId/tool_use_id.
- Show tool command/input summaries without forcing deep expansion.
- Provide hidden/expanded detail levels in wrapper mode.
- Keep strict event ordering and live streaming behavior.
- Avoid clutter: prioritize running/pending tasks; hide idle by default.
- Read `GET /api/features` and only expose terminal controls when `features.terminalModeEnabled === true`.
- Use `GET /api/tasks?includeIdle=1` only in explicit “show idle” surfaces.

Required screens:
- Inbox (task cards, pending-first)
- Task detail
- Session view (wrapper mode)
- Session view (terminal mode only when backend feature allows it)
- Create task/session flow
- Session settings/action sheet (permission, plan mode, agent commands)

Data contracts to implement against:
- REST: `/api/tasks`, `/api/inbox`, `/api/sessions`, `/api/tool-sessions`, and related mutation routes.
- WS: global + per-session channels for live updates.

Known native CLI payload patterns:
- Codex: `thread.started`, `turn.started`, `item.completed`, `turn.completed`; persisted `response_item` with `message`, `reasoning`, `function_call`, `function_call_output`.
- Claude: top-level `user/assistant/progress/system`; content blocks `text/thinking/tool_use/tool_result`.
- OpenCode export: message `parts` include `text`, `reasoning`, `tool`, `step-start`, `step-finish`.

Deliverables:
- Production-ready React frontend implementation.
- Stable stream ordering logic.
- Clear mobile interaction model for parent/child orchestrator sessions.
- No visual noise; minimal state shown by default with fast drill-down.

## References
- OpenAI Codex non-interactive mode: https://developers.openai.com/codex/noninteractive
- OpenAI Codex app-server protocol: https://developers.openai.com/codex/app-server
- Anthropic Claude Code docs: https://docs.anthropic.com/en/docs/claude-code
- Claude Code CLI reference: https://docs.claude.com/en/docs/claude-code/cli-reference
- OpenCode docs: https://opencode.ai/docs
- OpenCode JS SDK generated types (authoritative schema surface): https://raw.githubusercontent.com/sst/opencode/dev/packages/sdk/js/src/gen/types.gen.ts

## Sandbox Trace Evidence (2026-02-20)
Disposable workspace used: `/tmp/fyp-schema-lab`

### Codex demo trace
- Stream file: `/tmp/fyp-schema-lab/codex-stream.jsonl`
- Persisted log: `~/.codex/sessions/2026/02/20/rollout-2026-02-20T12-17-09-019c7ba0-50b7-7621-bbfe-6cb27346e0a7.jsonl`
- Observed stream event types:
  - `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`
- Observed item types:
  - `reasoning`, `agent_message`, `command_execution`, `file_change`
- Observed persisted `response_item.payload.type`:
  - `message`, `reasoning`, `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`

### Claude demo trace
- Session id: `e456a549-7ef5-4edf-8f2c-dae04a90c09f`
- Persisted file: `~/.claude/projects/-tmp-fyp-schema-lab/e456a549-7ef5-4edf-8f2c-dae04a90c09f.jsonl`
- Environment had no active Claude API key source at runtime (`apiKeySource: none`), so only queue lifecycle lines were written:
  - `queue-operation` with `enqueue` / `dequeue`
- Full tool-call trace still validated from existing local Claude project logs (see schema section above).

### OpenCode demo trace
- Stream file: `/tmp/fyp-schema-lab/opencode-run.jsonl`
- Session id: `ses_3845c48aaffevr5wjq3GeLROgH`
- Export file: `/tmp/fyp-schema-lab/opencode-export.json`
- Observed stream event types:
  - `step_start`, `tool_use`, `text`, `step_finish`
- Observed export `parts.type`:
  - `text`, `step-start`, `reasoning`, `tool`, `step-finish`
- Observed tool names in this run:
  - `bash`, `read`, `grep`, `edit`
