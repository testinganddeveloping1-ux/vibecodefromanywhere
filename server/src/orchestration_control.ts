import { createHash } from "node:crypto";

function toNonEmpty(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return s;
}

function looksLikePlaceholderMessage(msg: string): boolean {
  const s = String(msg ?? "").trim();
  if (!s) return true;
  if (/^<[^>\n]{1,80}>$/.test(s)) return true;
  if (/<\s*(?:prompt|task\s*prompt|message|text|objective|question|answer)\s*>/i.test(s)) return true;
  return false;
}

export type ParsedDispatchDirective = {
  target: any;
  text: string;
  interrupt: boolean;
  forceInterrupt: boolean;
  includeBootstrapIfPresent: boolean;
  source?: string;
};

export type ParsedQuestionAnswerDirective = {
  attentionId: number;
  optionId: string;
  source: string;
  meta: Record<string, any>;
};

export function parseForceInterruptFlag(payload: any): boolean {
  return payload?.forceInterrupt === true || toNonEmpty(payload?.interruptMode).toLowerCase() === "force";
}

function rememberRecentOrchestratorDirective(
  sessionId: string,
  sig: string,
  recentStore: Map<string, Map<string, number>>,
  dedupeWindowMs: number,
): boolean {
  const now = Date.now();
  const seen = recentStore.get(sessionId) ?? new Map<string, number>();
  recentStore.set(sessionId, seen);
  const last = Number(seen.get(sig) ?? 0);
  if (now - last < dedupeWindowMs) return false;
  seen.set(sig, now);
  if (seen.size > 320) {
    for (const [k, ts] of seen.entries()) {
      if (now - ts > dedupeWindowMs * 8) seen.delete(k);
    }
    if (seen.size > 360) {
      let drop = seen.size - 220;
      for (const k of seen.keys()) {
        seen.delete(k);
        drop -= 1;
        if (drop <= 0) break;
      }
    }
  }
  return true;
}

export function parseOrchestratorControlDirectives(input: {
  sessionId: string;
  chunk: string;
  carryStore: Map<string, string>;
  recentStore: Map<string, Map<string, number>>;
  dedupeWindowMs: number;
  normalizeChunk?: (chunk: string) => string;
}): {
  dispatches: ParsedDispatchDirective[];
  questionAnswers: ParsedQuestionAnswerDirective[];
} {
  const { sessionId, carryStore, recentStore, dedupeWindowMs } = input;
  const dispatches: ParsedDispatchDirective[] = [];
  const questionAnswers: ParsedQuestionAnswerDirective[] = [];
  const chunkNormalized = input.normalizeChunk ? input.normalizeChunk(String(input.chunk ?? "")) : String(input.chunk ?? "");
  const raw = chunkNormalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!raw) return { dispatches, questionAnswers };
  const carryPrev = carryStore.get(sessionId) ?? "";
  let merged = carryPrev + raw;
  if (merged.length > 20_000) merged = merged.slice(-20_000);
  const MARKERS = [
    "FYP_SEND_TASK_JSON:",
    "FYP_DISPATCH_JSON:",
    "FYP_ANSWER_QUESTION_JSON:",
    "FYP_QUESTION_RESPONSE_JSON:",
  ] as const;

  const findJsonEnd = (text: string, fromBraceIdx: number): number => {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = fromBraceIdx; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        escaped = false;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        continue;
      }
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  };

  const directives: Array<{ marker: string; idx: number; payload: any; payloadRaw: string }> = [];
  let firstIncompleteIdx = -1;

  for (const marker of MARKERS) {
    const markerUpper = marker.toUpperCase();
    let cursor = 0;
    const mergedUpper = merged.toUpperCase();
    while (cursor < merged.length) {
      const markerIdx = mergedUpper.indexOf(markerUpper, cursor);
      if (markerIdx === -1) break;
      const braceIdx = merged.indexOf("{", markerIdx + marker.length);
      if (braceIdx === -1) {
        if (firstIncompleteIdx === -1 || markerIdx < firstIncompleteIdx) firstIncompleteIdx = markerIdx;
        break;
      }
      const endIdx = findJsonEnd(merged, braceIdx);
      if (endIdx === -1) {
        if (firstIncompleteIdx === -1 || markerIdx < firstIncompleteIdx) firstIncompleteIdx = markerIdx;
        break;
      }
      const payloadRaw = merged.slice(braceIdx, endIdx).trim();
      if (!payloadRaw) {
        cursor = markerIdx + marker.length;
        continue;
      }
      let payload: any = null;
      try {
        payload = JSON.parse(payloadRaw);
      } catch {
        cursor = markerIdx + marker.length;
        continue;
      }
      directives.push({ marker, idx: markerIdx, payload, payloadRaw });
      cursor = endIdx;
    }
  }

  directives.sort((a, b) => a.idx - b.idx);

  for (const directive of directives) {
    if (directive.marker === "FYP_SEND_TASK_JSON:" || directive.marker === "FYP_DISPATCH_JSON:") {
      const msgRaw = toNonEmpty(directive.payload?.task || directive.payload?.text || directive.payload?.prompt || "");
      // Ignore docs/examples literals to avoid accidental dispatch from bootstrap echoes.
      if (looksLikePlaceholderMessage(msgRaw)) continue;
      const msg = msgRaw.length > 24_000 ? msgRaw.slice(0, 24_000) : msgRaw;
      const sig = createHash("sha1").update(`${directive.marker}|${directive.payloadRaw}`).digest("hex").slice(0, 24);
      if (!rememberRecentOrchestratorDirective(sessionId, sig, recentStore, dedupeWindowMs)) continue;
      dispatches.push({
        target: directive.payload?.target ?? "all",
        text: msg,
        interrupt: directive.payload?.interrupt === true,
        forceInterrupt: parseForceInterruptFlag(directive.payload),
        includeBootstrapIfPresent:
          directive.payload?.initialize === true ||
          directive.payload?.init === true ||
          directive.payload?.includeBootstrap === true ||
          directive.payload?.first === true,
        source: directive.marker === "FYP_SEND_TASK_JSON:" ? "orchestrator.send_task" : "orchestrator.directive",
      });
      continue;
    }

    const attentionId = Math.floor(Number(directive.payload?.attentionId ?? directive.payload?.id ?? NaN));
    const optionId = toNonEmpty(directive.payload?.optionId || directive.payload?.choice || directive.payload?.answer || "");
    if (!Number.isFinite(attentionId) || attentionId <= 0 || !optionId) continue;
    const sig = createHash("sha1").update(`${directive.marker}|${directive.payloadRaw}`).digest("hex").slice(0, 24);
    if (!rememberRecentOrchestratorDirective(sessionId, sig, recentStore, dedupeWindowMs)) continue;
    const source = toNonEmpty(directive.payload?.source) || "orchestrator-auto";
    const meta =
      directive.payload?.meta && typeof directive.payload.meta === "object" && !Array.isArray(directive.payload.meta)
        ? directive.payload.meta
        : {};
    questionAnswers.push({ attentionId, optionId, source, meta });
  }

  let carry = "";
  if (firstIncompleteIdx >= 0) {
    carry = merged.slice(firstIncompleteIdx);
  } else {
    const maxMarkerLen = Math.max(...MARKERS.map((m) => m.length));
    carry = merged.slice(-Math.max(200, maxMarkerLen * 2));
  }
  if (carry) carryStore.set(sessionId, carry.slice(-4000));
  else carryStore.delete(sessionId);
  return { dispatches, questionAnswers };
}
