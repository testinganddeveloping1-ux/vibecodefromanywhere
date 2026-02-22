import { describe, expect, test } from "vitest";
import { parseOrchestratorControlDirectives } from "../src/orchestration_control";

function runParse(input: {
  sessionId?: string;
  chunk: string;
  carryStore?: Map<string, string>;
  recentStore?: Map<string, Map<string, number>>;
  dedupeWindowMs?: number;
}) {
  return parseOrchestratorControlDirectives({
    sessionId: input.sessionId ?? "s1",
    chunk: input.chunk,
    carryStore: input.carryStore ?? new Map<string, string>(),
    recentStore: input.recentStore ?? new Map<string, Map<string, number>>(),
    dedupeWindowMs: input.dedupeWindowMs ?? 5 * 60 * 1000,
  });
}

describe("orchestrator control directive parsing", () => {
  test("parses single-line dispatch directives", () => {
    const parsed = runParse({
      chunk: 'FYP_DISPATCH_JSON: {"target":"worker:Worker A","text":"PING","interrupt":true}',
    });
    expect(parsed.dispatches.length).toBe(1);
    expect(parsed.dispatches[0]?.target).toBe("worker:Worker A");
    expect(parsed.dispatches[0]?.text).toBe("PING");
    expect(parsed.dispatches[0]?.interrupt).toBe(true);
  });

  test("parses multiline send-task JSON blocks", () => {
    const parsed = runParse({
      chunk:
        "FYP_SEND_TASK_JSON:\n" +
        "{\n" +
        '  "target":"worker:Worker A",\n' +
        '  "task":"TASK: fix startup\\nSCOPE: server/src/app.ts",\n' +
        '  "initialize": true,\n' +
        '  "interrupt": false\n' +
        "}\n",
    });
    expect(parsed.dispatches.length).toBe(1);
    expect(parsed.dispatches[0]?.target).toBe("worker:Worker A");
    expect(parsed.dispatches[0]?.includeBootstrapIfPresent).toBe(true);
    expect(String(parsed.dispatches[0]?.text ?? "")).toContain("TASK: fix startup");
    expect(String(parsed.dispatches[0]?.text ?? "")).toContain("SCOPE: server/src/app.ts");
  });

  test("supports chunked multiline directives split across parser calls", () => {
    const carryStore = new Map<string, string>();
    const recentStore = new Map<string, Map<string, number>>();

    const a = runParse({
      sessionId: "s2",
      chunk: 'FYP_DISPATCH_JSON: {"target":"worker:Worker A","text":"HEL',
      carryStore,
      recentStore,
    });
    expect(a.dispatches.length).toBe(0);

    const b = runParse({
      sessionId: "s2",
      chunk: 'LO","interrupt":false}',
      carryStore,
      recentStore,
    });
    expect(b.dispatches.length).toBe(1);
    expect(b.dispatches[0]?.text).toBe("HELLO");
  });

  test("parses question answer directives including multiline JSON", () => {
    const parsed = runParse({
      chunk:
        "FYP_ANSWER_QUESTION_JSON:\n" +
        "{\n" +
        '  "attentionId": 321,\n' +
        '  "optionId": "2",\n' +
        '  "source": "orchestrator-auto",\n' +
        '  "meta": { "reason": "safe default" }\n' +
        "}\n",
    });
    expect(parsed.questionAnswers.length).toBe(1);
    expect(parsed.questionAnswers[0]?.attentionId).toBe(321);
    expect(parsed.questionAnswers[0]?.optionId).toBe("2");
    expect(parsed.questionAnswers[0]?.source).toBe("orchestrator-auto");
    expect(parsed.questionAnswers[0]?.meta?.reason).toBe("safe default");
  });

  test("does not emit dispatch from placeholder docs examples", () => {
    const parsed = runParse({
      chunk: 'FYP_DISPATCH_JSON: {"target":"all","text":"<prompt>"}',
    });
    expect(parsed.dispatches.length).toBe(0);
  });
});
