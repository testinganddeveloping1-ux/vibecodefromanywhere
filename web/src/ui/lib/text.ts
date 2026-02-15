import type { EventItem } from "../types";

export function dirsFromText(t: string): string[] {
  return t
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack;
  return haystack.split(needle).join(replacement);
}

export function formatInputForDisplay(text: any): string {
  const raw = typeof text === "string" ? text : String(text ?? "");
  if (!raw) return "";

  // Pure key presses (common ones)
  if (/^(?:\r\n|\r|\n)+$/.test(raw)) return "[ENTER]";
  if (raw === "\t") return "[TAB]";
  if (raw === "\u001b") return "[ESC]";
  if (raw === "\u001b[Z") return "[SHIFT+TAB]";
  if (raw === "\u001b[A") return "[UP]";
  if (raw === "\u001b[B") return "[DOWN]";
  if (raw === "\u001b[C") return "[RIGHT]";
  if (raw === "\u001b[D") return "[LEFT]";

  // For normal messages, strip trailing CR/LF that we add as send suffix.
  let s = raw.replace(/[\r\n]+$/g, "");

  // Humanize common control sequences so key buttons are visible in the log/history.
  s = replaceAll(s, "\u001b[Z", "[SHIFT+TAB]");
  s = replaceAll(s, "\u001b[A", "[UP]");
  s = replaceAll(s, "\u001b[B", "[DOWN]");
  s = replaceAll(s, "\u001b[C", "[RIGHT]");
  s = replaceAll(s, "\u001b[D", "[LEFT]");
  s = s.replace(/\t/g, "[TAB]");
  s = s.replace(/\u001b/g, "[ESC]");

  // Replace any remaining control chars (keeps UI stable).
  s = s.replace(/[\u0000-\u001f\u007f]/g, (c) => {
    const code = c.charCodeAt(0).toString(16).padStart(2, "0");
    return `[0x${code}]`;
  });

  return s;
}

export function normalizeEvent(raw: any): EventItem | null {
  if (!raw || typeof raw.kind !== "string") return null;
  const id = Number.isFinite(Number(raw.id)) ? Number(raw.id) : Number(raw.ts ?? Date.now());
  const ts = Number(raw.ts ?? Date.now());
  return { id, ts, kind: String(raw.kind), data: raw.data ?? {} };
}

export function formatEventLine(e: EventItem): string {
  const k = String(e.kind ?? "");
  if (k === "input") return formatInputForDisplay(e.data?.text ?? "");
  if (k === "interrupt" || k === "stop" || k === "kill") return k.toUpperCase();
  if (k === "session.created")
    return `Started tool=${String(e.data?.tool ?? "")} profile=${String(e.data?.profileId ?? "")} cwd=${String(e.data?.cwd ?? "")}`;
  if (k === "session.exit") return `Exit code=${String(e.data?.exitCode ?? "null")} signal=${String(e.data?.signal ?? "null")}`;
  if (k === "session.tool_link") return `Linked tool session: ${String(e.data?.tool ?? "")} ${String(e.data?.toolSessionId ?? "")}`.trim();
  if (k === "session.meta") {
    const parts: string[] = [];
    if (Object.prototype.hasOwnProperty.call(e.data ?? {}, "label")) parts.push(`label=${JSON.stringify(e.data?.label ?? null)}`);
    if (Object.prototype.hasOwnProperty.call(e.data ?? {}, "pinnedSlot")) parts.push(`slot=${String(e.data?.pinnedSlot ?? null)}`);
    return parts.length ? `Meta ${parts.join(" ")}` : "Meta updated";
  }
  if (k === "session.git") return `Git workspace=${String(e.data?.workspaceKey ?? "")} tree=${String(e.data?.treePath ?? "")}`;
  if (k === "profile.startup") return `Startup macros: ${String(e.data?.profileId ?? "")}`;
  if (k === "profile.startup_failed") return `Startup macros failed: ${String(e.data?.profileId ?? "")}`;
  if (k === "inbox.respond") {
    const send = formatInputForDisplay(e.data?.send ?? "");
    const opt = String(e.data?.optionId ?? "");
    return `Inbox responded option=${opt}${send ? ` send=${send}` : ""}`;
  }
  if (k === "inbox.dismiss") return "Inbox dismissed";
  try {
    return JSON.stringify(e.data ?? {});
  } catch {
    return String(e.data ?? "");
  }
}
