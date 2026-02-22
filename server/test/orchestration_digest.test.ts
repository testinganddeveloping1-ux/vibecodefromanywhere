import { describe, expect, test } from "vitest";
import { buildOrchestrationDigest } from "../src/orchestration_digest";

describe("orchestration digest model", () => {
  test("tracks worker changes using snapshots and event watermarks", () => {
    const base = {
      orchestrationId: "orch_1",
      name: "demo",
      trigger: "manual",
      generatedAt: 1_700_000_000_000,
      workers: [
        {
          idx: 0,
          name: "api",
          sessionId: "s_api",
          running: true,
          attention: 0,
          preview: "building routes",
          previewTs: 1_700_000_000_100,
          branch: "feature/api",
          lastEvent: { id: 10, kind: "input", ts: 1_700_000_000_050 },
        },
        {
          idx: 1,
          name: "ui",
          sessionId: "s_ui",
          running: false,
          attention: 1,
          preview: "needs approval",
          previewTs: 1_700_000_000_120,
          branch: "feature/ui",
          lastEvent: { id: 11, kind: "inbox.respond", ts: 1_700_000_000_090 },
        },
      ],
      previousSnapshots: {},
    } as const;

    const d1 = buildOrchestrationDigest(base);
    expect(d1.workerCount).toBe(2);
    expect(d1.changedWorkerCount).toBe(2);
    expect(d1.changedSessionIds).toEqual(["s_api", "s_ui"]);
    expect(d1.text).toContain("Changes since last digest:");

    const d2 = buildOrchestrationDigest({
      ...base,
      generatedAt: base.generatedAt + 1000,
      previousSnapshots: d1.snapshots,
    });
    expect(d2.changedWorkerCount).toBe(0);
    expect(d2.hash).toBe(d1.hash);

    const d3 = buildOrchestrationDigest({
      ...base,
      generatedAt: base.generatedAt + 2000,
      previousSnapshots: d2.snapshots,
      workers: base.workers.map((w) =>
        w.sessionId === "s_api"
          ? { ...w, lastEvent: { id: 12, kind: "tool_result", ts: 1_700_000_002_000 } }
          : w,
      ),
    });
    // Generic runtime events should not churn orchestration digests.
    expect(d3.changedWorkerCount).toBe(0);
    expect(d3.hash).toBe(d2.hash);

    const d3b = buildOrchestrationDigest({
      ...base,
      generatedAt: base.generatedAt + 2500,
      previousSnapshots: d3.snapshots,
      workers: base.workers.map((w) =>
        w.sessionId === "s_api"
          ? {
              ...w,
              checklistDone: 2,
              checklistTotal: 4,
              progressUpdatedAt: 1_700_000_002_500,
              progressRelPath: ".agents/tasks/worker-1-api.md",
            }
          : w,
      ),
    });
    expect(d3b.changedWorkerCount).toBe(1);
    expect(d3b.hash).not.toBe(d3.hash);
    expect(d3b.text).toContain("checklist 0/0→2/4");

    const d4 = buildOrchestrationDigest({
      ...base,
      generatedAt: base.generatedAt + 3000,
      previousSnapshots: d3b.snapshots,
      workers: base.workers.map((w) =>
        w.sessionId === "s_api"
          ? { ...w, lastEvent: { id: 13, kind: "codex.native.user_input", ts: 1_700_000_003_000 } }
          : w,
      ),
    });
    expect(d4.changedWorkerCount).toBe(1);
    expect(d4.hash).not.toBe(d3.hash);
    expect(d4.text).toContain("codex.native.user_input #13");
  });
});
