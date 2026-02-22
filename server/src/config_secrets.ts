export const REDACTED_TOML_SECRET = "__FYP_REDACTED__";

type SecretSection =
  | { kind: "none" }
  | { kind: "auth" }
  | { kind: "profileEnv"; profileId: string };

type TomlAssignment = {
  key: string;
  prefix: string;
  value: string;
  comment: string;
};

function splitPath(pathRaw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let escaped = false;
  for (const ch of pathRaw) {
    if (inQuote) {
      if (escaped) {
        cur += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inQuote = false;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      continue;
    }
    if (ch === ".") {
      const v = cur.trim();
      if (v) out.push(v);
      cur = "";
      continue;
    }
    cur += ch;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

function parseSection(line: string): string[] | null {
  const m = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
  if (!m?.[1]) return null;
  return splitPath(String(m[1]));
}

function splitValueAndComment(rest: string): { value: string; comment: string } {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i] ?? "";
    if (inDouble) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === "#") {
      return {
        value: rest.slice(0, i),
        comment: rest.slice(i),
      };
    }
  }
  return { value: rest, comment: "" };
}

function parseAssignment(line: string): TomlAssignment | null {
  const eq = line.indexOf("=");
  if (eq <= 0) return null;
  const prefix = line.slice(0, eq + 1);
  const keyRaw = line.slice(0, eq).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(keyRaw)) return null;
  const rest = line.slice(eq + 1);
  const { value, comment } = splitValueAndComment(rest);
  return {
    key: keyRaw,
    prefix,
    value: value.trim(),
    comment,
  };
}

function classifySection(parts: string[]): SecretSection {
  if (parts.length === 1 && parts[0] === "auth") return { kind: "auth" };
  if (parts.length === 3 && parts[0] === "profiles" && parts[2] === "env" && parts[1]) {
    return { kind: "profileEnv", profileId: parts[1] };
  }
  return { kind: "none" };
}

function secretSlot(section: SecretSection, key: string): string | null {
  if (section.kind === "auth" && key === "token") return "auth.token";
  if (section.kind === "profileEnv") return `profiles.${section.profileId}.env.${key}`;
  return null;
}

function normalizedLineEnding(raw: string): string {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

function isPlaceholderValue(valueRaw: string): boolean {
  const trimmed = String(valueRaw ?? "").trim();
  if (!trimmed) return false;
  let inner = trimmed;
  if (
    (inner.startsWith('"') && inner.endsWith('"')) ||
    (inner.startsWith("'") && inner.endsWith("'"))
  ) {
    inner = inner.slice(1, -1);
  }
  return inner.trim() === REDACTED_TOML_SECRET;
}

function collectSecrets(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = raw.split(/\r?\n/);
  let section: SecretSection = { kind: "none" };
  for (const line of lines) {
    const sec = parseSection(line);
    if (sec) {
      section = classifySection(sec);
      continue;
    }
    const assign = parseAssignment(line);
    if (!assign) continue;
    const slot = secretSlot(section, assign.key);
    if (!slot) continue;
    if (!assign.value) continue;
    out.set(slot, assign.value);
  }
  return out;
}

function rewriteWithSecretTransform(
  raw: string,
  mapper: (slot: string, currentValue: string) => string | null,
): string {
  const eol = normalizedLineEnding(raw);
  const lines = raw.split(/\r?\n/);
  let section: SecretSection = { kind: "none" };
  const out: string[] = [];

  for (const line of lines) {
    const sec = parseSection(line);
    if (sec) {
      section = classifySection(sec);
      out.push(line);
      continue;
    }

    const assign = parseAssignment(line);
    if (!assign) {
      out.push(line);
      continue;
    }

    const slot = secretSlot(section, assign.key);
    if (!slot) {
      out.push(line);
      continue;
    }

    const next = mapper(slot, assign.value);
    if (!next) {
      out.push(line);
      continue;
    }
    out.push(`${assign.prefix} ${next}${assign.comment}`);
  }

  return out.join(eol);
}

export function redactTomlSecrets(raw: string): string {
  const placeholder = `"${REDACTED_TOML_SECRET}"`;
  return rewriteWithSecretTransform(raw, () => placeholder);
}

export function mergeRedactedTomlSecrets(nextRaw: string, currentRaw: string): string {
  const current = collectSecrets(currentRaw);
  return rewriteWithSecretTransform(nextRaw, (slot, value) => {
    if (!isPlaceholderValue(value)) return null;
    return current.get(slot) ?? null;
  });
}
