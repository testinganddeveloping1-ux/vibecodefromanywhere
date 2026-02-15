#!/usr/bin/env node
// Minimal fake "AI CLI" for tests.
// - Implements `--version` and `--help` fast
// - Ignores unknown flags (so arg builders can pass tool flags)
// - Echoes stdin to stdout to simulate an interactive TUI/REPL

function hasAny(flags) {
  return flags.some((f) => process.argv.includes(f));
}

if (hasAny(["--version", "-v", "-V"])) {
  process.stdout.write("fake-tool 0.0.0\n");
  process.exit(0);
}

if (hasAny(["--help", "-h"])) {
  // Include strings that our detector parses.
  process.stdout.write(`Fake Tool (test stub)

Override a configuration value that would otherwise be loaded from \`~/.codex/config.toml\`.

Options:
  -C, --cd <DIR>          Tell the agent to use the specified directory as its working root
  -s, --sandbox <MODE>    [possible values: read-only, workspace-write, danger-full-access]
  -a, --ask-for-approval <POLICY>
                          Possible values:
                          - untrusted
                          - on-failure
                          - on-request
                          - never
      --full-auto
      --dangerously-bypass-approvals-and-sandbox
      --search
      --add-dir <DIR>
      --no-alt-screen

  --permission-mode <mode> (choices: "acceptEdits", "bypassPermissions", "default", "delegate", "dontAsk", "plan")
  --dangerously-skip-permissions
  --settings <jsonOrPath>

  opencode serve
  opencode web
  opencode attach
  -m, --model <provider/model>
  --agent <agent>
  --hostname <hostname>
  --port <port>
`);
  process.exit(0);
}

if (process.argv.includes("models")) {
  process.stdout.write("opencode/kimi-k2.5-free\n");
  process.stdout.write("opencode/minimax-m2.5-free\n");
  process.exit(0);
}

// Best-effort: honor `--cd <dir>` in case tests pass it through.
try {
  const idx = process.argv.indexOf("--cd");
  if (idx >= 0 && process.argv[idx + 1]) process.chdir(process.argv[idx + 1]);
} catch {
  // ignore
}

process.stdout.write("READY\n");
process.stdin.on("data", (d) => {
  process.stdout.write(d);
});
