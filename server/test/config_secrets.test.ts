import { describe, expect, test } from "vitest";
import { mergeRedactedTomlSecrets, REDACTED_TOML_SECRET, redactTomlSecrets } from "../src/config_secrets";

const rawToml = `
[server]
bind = "127.0.0.1"
port = 7337

[auth]
token = "super-secret-token"

[profiles."claude.default"]
tool = "claude"
title = "Claude: Default"

[profiles."claude.default".env]
ANTHROPIC_API_KEY = "sk-live-abc"
PUBLIC_FLAG = "1"
`.trim();

describe("config secret redaction", () => {
  test("redacts auth token and profile env values", () => {
    const redacted = redactTomlSecrets(rawToml);
    expect(redacted).toContain(`token = "${REDACTED_TOML_SECRET}"`);
    expect(redacted).toContain(`ANTHROPIC_API_KEY = "${REDACTED_TOML_SECRET}"`);
    expect(redacted).toContain(`PUBLIC_FLAG = "${REDACTED_TOML_SECRET}"`);
    expect(redacted).not.toContain("super-secret-token");
    expect(redacted).not.toContain("sk-live-abc");
  });

  test("merges placeholders back to existing secrets on save", () => {
    const edited = `
[server]
bind = "0.0.0.0"
port = 7337

[auth]
token = "${REDACTED_TOML_SECRET}"

[profiles."claude.default"]
tool = "claude"
title = "Claude: Custom"

[profiles."claude.default".env]
ANTHROPIC_API_KEY = "${REDACTED_TOML_SECRET}"
PUBLIC_FLAG = "${REDACTED_TOML_SECRET}"
`.trim();
    const merged = mergeRedactedTomlSecrets(edited, rawToml);
    expect(merged).toContain(`bind = "0.0.0.0"`);
    expect(merged).toContain(`token = "super-secret-token"`);
    expect(merged).toContain(`ANTHROPIC_API_KEY = "sk-live-abc"`);
    expect(merged).toContain(`PUBLIC_FLAG = "1"`);
    expect(merged).toContain(`title = "Claude: Custom"`);
    expect(merged).not.toContain(REDACTED_TOML_SECRET);
  });
});
