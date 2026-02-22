import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

type HarnessExecutionMode = "worker.dispatch" | "worker.send_task" | "orchestrator.input" | "system.sync" | "system.review";
type HarnessPriority = "HIGH" | "NORMAL" | "LOW";
type CommandGroup = "all" | "coordination" | "quality" | "security" | "reliability" | "frontend";

type HarnessCommand = {
  id: string;
  title: string;
  summary: string;
  whenToUse: string;
  payloadTemplate: string;
  execution?: {
    mode?: HarnessExecutionMode;
    defaultTarget?: string;
    includeBootstrapIfPresent?: boolean;
    defaultPriority?: HarnessPriority;
  };
  policy?: {
    tier?: "low" | "medium" | "high";
    requirements?: string[];
  };
};

type CommandResponse = {
  ok?: boolean;
  replayed?: boolean;
  commandId?: string;
  mode?: HarnessExecutionMode;
  count?: { sent?: number; failed?: number };
  sync?: { reason?: string; delivered?: boolean };
  review?: { reason?: string; sent?: boolean };
  dispatched?: boolean;
};

type CommandRunRecord = {
  ts: number;
  commandId: string;
  title: string;
  ok: boolean;
  summary: string;
  detail: string;
};

const GROUP_ORDER: CommandGroup[] = ["all", "coordination", "quality", "security", "reliability", "frontend"];
const PRIORITY_OPTIONS: HarnessPriority[] = ["HIGH", "NORMAL", "LOW"];

function normalizeListInput(raw: string): string[] {
  return String(raw ?? "")
    .split(/\r?\n|,/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function commandGroup(command: HarnessCommand): Exclude<CommandGroup, "all"> {
  const text = `${command.id} ${command.title} ${command.summary}`.toLowerCase();
  if (/(frontend|mobile|accessibility|motion|design|parity|responsive)/.test(text)) return "frontend";
  if (/(security|threat|sast|vuln|auth|mitigation|dependency-risk)/.test(text)) return "security";
  if (/(backend|resilience|perf|rollback|incident|integrity|observability|error-path)/.test(text)) return "reliability";
  if (/(verify|review|test|contract|integration|flake|gate|diag)/.test(text)) return "quality";
  return "coordination";
}

function modeLabel(mode: HarnessExecutionMode | undefined): string {
  if (!mode) return "dispatch";
  switch (mode) {
    case "worker.send_task":
      return "send task";
    case "worker.dispatch":
      return "dispatch";
    case "orchestrator.input":
      return "orchestrator";
    case "system.sync":
      return "sync";
    case "system.review":
      return "review";
    default:
      return "dispatch";
  }
}

function summarizeResponse(resp: CommandResponse): { summary: string; detail: string } {
  const mode = String(resp?.mode ?? "").trim();
  if (mode === "system.sync") {
    const delivered = resp?.sync?.delivered ? "delivered" : "not delivered";
    const reason = String(resp?.sync?.reason ?? "no reason");
    return { summary: `Sync ${delivered}`, detail: `Reason: ${reason}` };
  }
  if (mode === "system.review") {
    const sent = resp?.review?.sent ? "dispatched" : "skipped";
    const reason = String(resp?.review?.reason ?? "no reason");
    return { summary: `Review ${sent}`, detail: `Reason: ${reason}` };
  }
  const sent = Number(resp?.count?.sent ?? 0);
  const failed = Number(resp?.count?.failed ?? 0);
  if (sent > 0 || failed > 0) {
    return { summary: `Sent ${sent} · Failed ${failed}`, detail: failed > 0 ? "One or more targets failed." : "Command routed successfully." };
  }
  if (resp?.dispatched) {
    return { summary: "Dispatched to orchestrator", detail: "Command was injected directly into orchestrator session." };
  }
  return { summary: "Command executed", detail: "Execution completed." };
}

export function OrchestrationCommandPanel(props: {
  orchestrationId: string | null;
  open: boolean;
  onToggle: () => void;
  workers: Array<{ name: string; sessionId: string; running?: boolean; attention?: number }>;
  onExecuted?: () => void | Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commands, setCommands] = useState<HarnessCommand[]>([]);
  const [group, setGroup] = useState<CommandGroup>("all");
  const [search, setSearch] = useState("");
  const [selectedCommandId, setSelectedCommandId] = useState<string>("");
  const [target, setTarget] = useState("all");
  const [task, setTask] = useState("");
  const [scope, setScope] = useState("");
  const [verify, setVerify] = useState("");
  const [priority, setPriority] = useState<HarnessPriority>("NORMAL");
  const [interrupt, setInterrupt] = useState(false);
  const [initialize, setInitialize] = useState(false);
  const [force, setForce] = useState(false);
  const [deliverToOrchestrator, setDeliverToOrchestrator] = useState(true);
  const [policyAck, setPolicyAck] = useState(false);
  const [policyReason, setPolicyReason] = useState("");
  const [policyApprovedBy, setPolicyApprovedBy] = useState("");
  const [policyAuthorizedScope, setPolicyAuthorizedScope] = useState("");
  const [rollbackPlan, setRollbackPlan] = useState("");
  const [policyOverride, setPolicyOverride] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<CommandRunRecord | null>(null);

  const loadCommands = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api<{ ok?: boolean; commands?: HarnessCommand[] }>("/api/harness/commands");
      const next = Array.isArray(res?.commands) ? res.commands : [];
      setCommands(next);
      if (!selectedCommandId && next.length > 0) {
        const preferred = next.find((c) => c.id === "coord-task") ?? next.find((c) => c.id === "sync-status") ?? next[0];
        setSelectedCommandId(String(preferred?.id ?? ""));
      }
    } catch (e: any) {
      setLoadError(typeof e?.message === "string" ? e.message : "Failed to load commands.");
    } finally {
      setLoading(false);
    }
  }, [loading, selectedCommandId]);

  useEffect(() => {
    if (!props.open) return;
    if (commands.length > 0) return;
    void loadCommands();
  }, [props.open, commands.length, loadCommands]);

  const selected = useMemo(
    () => commands.find((c) => c.id === selectedCommandId) ?? null,
    [commands, selectedCommandId],
  );

  const selectedMode = (selected?.execution?.mode ?? "worker.dispatch") as HarnessExecutionMode;
  const supportsTarget = selectedMode === "worker.dispatch" || selectedMode === "worker.send_task";
  const supportsPrompt = selectedMode !== "system.sync" && selectedMode !== "system.review";
  const supportsScopeVerify = supportsPrompt;
  const supportsPriority = selectedMode === "worker.dispatch" || selectedMode === "worker.send_task";
  const supportsInterrupt = selectedMode === "worker.dispatch" || selectedMode === "worker.send_task";
  const supportsInitialize = selectedMode === "worker.send_task";
  const supportsForce = selectedMode === "system.sync" || selectedMode === "system.review";
  const supportsDeliver = selectedMode === "system.sync";
  const selectedPolicyTier = (selected?.policy?.tier ?? "low") as "low" | "medium" | "high";
  const supportsPolicyReason = selectedPolicyTier === "medium" || selectedPolicyTier === "high";
  const supportsHighRiskPolicy = selectedPolicyTier === "high";
  const policyRequirements = Array.isArray(selected?.policy?.requirements) ? selected!.policy!.requirements! : [];

  useEffect(() => {
    if (!selected) return;
    setTarget(String(selected.execution?.defaultTarget || "all"));
    setPriority((selected.execution?.defaultPriority || "NORMAL") as HarnessPriority);
    setInitialize(Boolean(selected.execution?.includeBootstrapIfPresent));
    setForce(false);
    setInterrupt(false);
    setDeliverToOrchestrator(true);
    setPolicyAck(false);
    setPolicyReason("");
    setPolicyApprovedBy("");
    setPolicyAuthorizedScope("");
    setRollbackPlan("");
    setPolicyOverride(false);
    setRunError(null);
  }, [selected?.id]);

  const filteredCommands = useMemo(() => {
    const q = search.trim().toLowerCase();
    return commands
      .filter((cmd) => (group === "all" ? true : commandGroup(cmd) === group))
      .filter((cmd) => {
        if (!q) return true;
        return `${cmd.id} ${cmd.title} ${cmd.summary} ${cmd.whenToUse}`.toLowerCase().includes(q);
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [commands, group, search]);

  const targetOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [{ value: "all", label: "All workers" }];
    for (const w of props.workers) {
      const name = String(w.name ?? "").trim();
      const sid = String(w.sessionId ?? "").trim();
      if (name) options.push({ value: `worker:${name}`, label: `${name}${w.running ? " · live" : ""}` });
      if (sid) options.push({ value: `session:${sid}`, label: `session:${sid.slice(0, 8)}${sid.length > 8 ? "…" : ""}` });
    }
    return options;
  }, [props.workers]);

  const runCommand = useCallback(async () => {
    const orchestrationId = String(props.orchestrationId ?? "").trim();
    if (!orchestrationId || !selected) return;
    setRunning(true);
    setRunError(null);
    try {
      if (supportsPolicyReason && force && policyReason.trim().length < 8) {
        throw new Error("Policy reason must be at least 8 characters when force is enabled.");
      }
      if (supportsHighRiskPolicy && !policyOverride) {
        if (!policyAck) throw new Error("High-risk command requires policy acknowledgment.");
        if (policyReason.trim().length < 12) throw new Error("High-risk command requires a policy reason (>=12 chars).");
        if (policyApprovedBy.trim().length < 2) throw new Error("High-risk command requires 'Approved By'.");
        if (rollbackPlan.trim().length < 12) throw new Error("High-risk command requires a rollback plan (>=12 chars).");
        if (selected.id === "security-vuln-repro" && policyAuthorizedScope.trim().length < 6) {
          throw new Error("security-vuln-repro requires explicit authorized scope.");
        }
      }

      const body: Record<string, any> = {
        commandId: selected.id,
      };
      if (supportsTarget && target.trim()) body.target = target.trim();
      if (supportsPrompt && task.trim()) body.task = task.trim();
      if (supportsScopeVerify) {
        const scopeParts = normalizeListInput(scope);
        const verifyParts = normalizeListInput(verify);
        if (scopeParts.length > 0) body.scope = scopeParts;
        if (verifyParts.length > 0) body.verify = verifyParts;
      }
      if (supportsPriority) body.priority = priority;
      if (supportsInterrupt && interrupt) body.interrupt = true;
      if (supportsInitialize && initialize) body.initialize = true;
      if (supportsForce && force) body.force = true;
      if (supportsDeliver) body.deliverToOrchestrator = deliverToOrchestrator;
      if (supportsPolicyReason && policyReason.trim()) body.policyReason = policyReason.trim();
      if (supportsHighRiskPolicy) {
        if (policyAck) body.policyAck = true;
        if (policyApprovedBy.trim()) body.policyApprovedBy = policyApprovedBy.trim();
        if (policyAuthorizedScope.trim()) body.policyAuthorizedScope = policyAuthorizedScope.trim();
        if (rollbackPlan.trim()) body.rollbackPlan = rollbackPlan.trim();
        if (policyOverride) body.policyOverride = true;
      }

      const response = await api<CommandResponse>(
        `/api/orchestrations/${encodeURIComponent(orchestrationId)}/commands/execute`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const summary = summarizeResponse(response);
      const replaySuffix = response?.replayed ? " · replayed" : "";
      setLastRun({
        ts: Date.now(),
        commandId: selected.id,
        title: selected.title,
        ok: true,
        summary: `${summary.summary}${replaySuffix}`,
        detail: summary.detail,
      });
      await props.onExecuted?.();
    } catch (e: any) {
      const message = typeof e?.message === "string" ? e.message : "Command execution failed.";
      setRunError(message);
      setLastRun({
        ts: Date.now(),
        commandId: selected.id,
        title: selected.title,
        ok: false,
        summary: "Execution failed",
        detail: message,
      });
    } finally {
      setRunning(false);
    }
  }, [
    props.orchestrationId,
    selected,
    supportsTarget,
    target,
    supportsPrompt,
    task,
    supportsScopeVerify,
    scope,
    verify,
    supportsPriority,
    priority,
    supportsInterrupt,
    interrupt,
    supportsInitialize,
    initialize,
    supportsForce,
    force,
    supportsDeliver,
    deliverToOrchestrator,
    supportsPolicyReason,
    policyReason,
    supportsHighRiskPolicy,
    policyAck,
    policyApprovedBy,
    policyAuthorizedScope,
    rollbackPlan,
    policyOverride,
    props.onExecuted,
  ]);

  if (!props.orchestrationId) return null;

  return (
    <section className={`orchCommandPanel ${props.open ? "orchCommandPanelOpen" : ""}`}>
      <button className="orchCommandToggle" onClick={props.onToggle} aria-expanded={props.open}>
        <span className="orchCommandToggleLeft">
          <span className="orchCommandToggleLabel mono">Command Deck</span>
          <span className="orchCommandToggleId mono">{props.orchestrationId}</span>
        </span>
        <span className="orchCommandToggleRight mono">{props.open ? "Hide" : "Show"}</span>
      </button>

      {props.open ? (
        <div className="orchCommandBody">
          <div className="orchCommandHeader">
            <div className="orchCommandPills">
              {GROUP_ORDER.map((g) => (
                <button
                  key={g}
                  className={`orchCommandPill ${group === g ? "orchCommandPillOn" : ""}`}
                  onClick={() => setGroup(g)}
                >
                  {g === "all" ? "All" : g}
                </button>
              ))}
            </div>
            <button className="orchCommandReload mono" onClick={() => void loadCommands()} disabled={loading}>
              {loading ? "Loading…" : "Reload"}
            </button>
          </div>

          <input
            className="orchCommandSearch"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search commands (id, title, summary)"
          />

          {loadError ? <div className="orchCommandError">{loadError}</div> : null}

          <div className="orchCommandList" role="listbox" aria-label="Harness commands">
            {filteredCommands.map((cmd) => {
              const mode = (cmd.execution?.mode ?? "worker.dispatch") as HarnessExecutionMode;
              const isOn = selectedCommandId === cmd.id;
              return (
                <button
                  key={cmd.id}
                  className={`orchCommandItem ${isOn ? "orchCommandItemOn" : ""}`}
                  onClick={() => setSelectedCommandId(cmd.id)}
                >
                  <div className="orchCommandItemTop">
                    <span className="orchCommandItemTitle">{cmd.title}</span>
                    <span className="orchCommandItemMode mono">
                      {modeLabel(mode)}
                      {(cmd.policy?.tier ?? "low") !== "low" ? ` · ${String(cmd.policy?.tier ?? "").toUpperCase()}` : ""}
                    </span>
                  </div>
                  <div className="orchCommandItemSummary">{cmd.summary}</div>
                  <div className="orchCommandItemId mono">{cmd.id}</div>
                </button>
              );
            })}
            {filteredCommands.length === 0 ? (
              <div className="orchCommandEmpty">No commands match this filter.</div>
            ) : null}
          </div>

          {selected ? (
            <div className="orchCommandSelected">
              <div className="orchCommandSelectedTop">
                <div className="orchCommandSelectedTitle">{selected.title}</div>
                <span className="orchCommandSelectedMode mono">
                  {modeLabel(selectedMode)}
                  {selectedPolicyTier !== "low" ? ` · ${selectedPolicyTier.toUpperCase()}` : ""}
                </span>
              </div>
              <div className="orchCommandSelectedSummary">{selected.summary}</div>
              <div className="orchCommandSelectedWhen">{selected.whenToUse}</div>

              {supportsPolicyReason || supportsHighRiskPolicy ? (
                <div className="orchFieldRow">
                  {supportsPolicyReason ? (
                    <label className="orchField">
                      <span className="orchFieldLabel mono">Policy Reason</span>
                      <textarea
                        className="orchFieldInput orchFieldTextarea"
                        rows={2}
                        value={policyReason}
                        onChange={(e) => setPolicyReason(e.target.value)}
                        placeholder="Why this risk is justified and safe right now."
                      />
                    </label>
                  ) : null}
                  {supportsHighRiskPolicy ? (
                    <label className="orchField">
                      <span className="orchFieldLabel mono">Approved By</span>
                      <input
                        className="orchFieldInput"
                        value={policyApprovedBy}
                        onChange={(e) => setPolicyApprovedBy(e.target.value)}
                        placeholder="owner/security reviewer"
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}

              {supportsHighRiskPolicy ? (
                <div className="orchFieldRow">
                  <label className="orchField">
                    <span className="orchFieldLabel mono">Authorized Scope</span>
                    <input
                      className="orchFieldInput"
                      value={policyAuthorizedScope}
                      onChange={(e) => setPolicyAuthorizedScope(e.target.value)}
                      placeholder="explicit system/env/repo scope authorized for this command"
                    />
                  </label>
                  <label className="orchField">
                    <span className="orchFieldLabel mono">Rollback Plan</span>
                    <textarea
                      className="orchFieldInput orchFieldTextarea"
                      rows={2}
                      value={rollbackPlan}
                      onChange={(e) => setRollbackPlan(e.target.value)}
                      placeholder="How to undo safely if this causes risk."
                    />
                  </label>
                </div>
              ) : null}

              {supportsHighRiskPolicy || supportsPolicyReason ? (
                <div className="orchToggles">
                  {supportsHighRiskPolicy ? (
                    <label className="orchSwitch">
                      <input type="checkbox" checked={policyAck} onChange={(e) => setPolicyAck(e.target.checked)} />
                      <span className="orchSwitchText">Acknowledge policy requirements</span>
                    </label>
                  ) : null}
                  {supportsHighRiskPolicy ? (
                    <label className="orchSwitch">
                      <input type="checkbox" checked={policyOverride} onChange={(e) => setPolicyOverride(e.target.checked)} />
                      <span className="orchSwitchText">Emergency override (env-gated)</span>
                    </label>
                  ) : null}
                </div>
              ) : null}

              {policyRequirements.length > 0 ? (
                <div className="orchCommandSelectedWhen">
                  {policyRequirements.join(" ")}
                </div>
              ) : null}

              {supportsTarget ? (
                <label className="orchField">
                  <span className="orchFieldLabel mono">Target</span>
                  <select className="orchFieldInput" value={target} onChange={(e) => setTarget(e.target.value)}>
                    {targetOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {supportsPrompt ? (
                <label className="orchField">
                  <span className="orchFieldLabel mono">Task / Prompt</span>
                  <textarea
                    className="orchFieldInput orchFieldTextarea"
                    rows={2}
                    value={task}
                    onChange={(e) => setTask(e.target.value)}
                    placeholder={selected.payloadTemplate}
                  />
                </label>
              ) : null}

              {supportsScopeVerify ? (
                <div className="orchFieldRow">
                  <label className="orchField">
                    <span className="orchFieldLabel mono">Scope</span>
                    <textarea
                      className="orchFieldInput orchFieldTextarea"
                      rows={2}
                      value={scope}
                      onChange={(e) => setScope(e.target.value)}
                      placeholder="server/src/app.ts, web/src/ui/App.tsx"
                    />
                  </label>
                  <label className="orchField">
                    <span className="orchFieldLabel mono">Verify</span>
                    <textarea
                      className="orchFieldInput orchFieldTextarea"
                      rows={2}
                      value={verify}
                      onChange={(e) => setVerify(e.target.value)}
                      placeholder="npm run test -- server/test/harness_commands.test.ts"
                    />
                  </label>
                </div>
              ) : null}

              <div className="orchToggles">
                {supportsPriority ? (
                  <label className="orchField orchFieldCompact">
                    <span className="orchFieldLabel mono">Priority</span>
                    <select className="orchFieldInput" value={priority} onChange={(e) => setPriority(e.target.value as HarnessPriority)}>
                      {PRIORITY_OPTIONS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {supportsInterrupt ? (
                  <label className="orchSwitch">
                    <input type="checkbox" checked={interrupt} onChange={(e) => setInterrupt(e.target.checked)} />
                    <span className="orchSwitchText">Interrupt current worker loop</span>
                  </label>
                ) : null}

                {supportsInitialize ? (
                  <label className="orchSwitch">
                    <input type="checkbox" checked={initialize} onChange={(e) => setInitialize(e.target.checked)} />
                    <span className="orchSwitchText">Include bootstrap if available</span>
                  </label>
                ) : null}

                {supportsForce ? (
                  <label className="orchSwitch">
                    <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                    <span className="orchSwitchText">Force execution</span>
                  </label>
                ) : null}

                {supportsDeliver ? (
                  <label className="orchSwitch">
                    <input
                      type="checkbox"
                      checked={deliverToOrchestrator}
                      onChange={(e) => setDeliverToOrchestrator(e.target.checked)}
                    />
                    <span className="orchSwitchText">Deliver digest to orchestrator</span>
                  </label>
                ) : null}
              </div>

              {runError ? <div className="orchCommandError">{runError}</div> : null}

              <div className="orchRunRow">
                <button className="orchRunBtn" onClick={() => void runCommand()} disabled={running || !selected}>
                  {running ? "Running…" : `Run ${selected.title}`}
                </button>
              </div>
            </div>
          ) : null}

          {lastRun ? (
            <div className={`orchRunResult ${lastRun.ok ? "orchRunResultOk" : "orchRunResultErr"}`}>
              <div className="orchRunResultTop">
                <span className="orchRunResultTitle">{lastRun.title}</span>
                <span className="orchRunResultTime mono">{new Date(lastRun.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <div className="orchRunResultSummary">{lastRun.summary}</div>
              <div className="orchRunResultDetail">{lastRun.detail}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
