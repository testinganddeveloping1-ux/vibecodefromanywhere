import type { AgentCommandDef } from "./harness.js";
import type { HarnessCommandValidationMode } from "./harness_command_schema.js";

export type HarnessCommandRiskTier = "low" | "medium" | "high";

export type HarnessCommandPolicyMeta = {
  commandId: string;
  mode: HarnessCommandValidationMode;
  tier: HarnessCommandRiskTier;
  requirements: string[];
};

export type HarnessCommandPolicyDecision =
  | {
      ok: true;
      meta: HarnessCommandPolicyMeta;
      satisfied: string[];
      bypassed: boolean;
    }
  | {
      ok: false;
      meta: HarnessCommandPolicyMeta;
      reason: string;
      unmet: string[];
    };

function toNonEmpty(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function truthy(v: unknown): boolean {
  return v === true || toNonEmpty(v).toLowerCase() === "true" || toNonEmpty(v) === "1";
}

const HIGH_RISK_COMMANDS = new Set([
  "security-vuln-repro",
  "security-remediation",
  "rollback-drill",
  "incident-drill",
  "release-readiness",
  "resilience-chaos-check",
]);

const MEDIUM_RISK_COMMANDS = new Set([
  "review-hard",
  "security-threat-model",
  "threat-model-stride",
  "attack-tree-map",
  "security-requirements",
  "mitigation-map",
  "security-sast",
  "dependency-risk-audit",
  "auth-hardening",
  "backend-hardening",
  "error-path-audit",
  "data-integrity-audit",
  "perf-regression-lab",
  "perf-budget-gate",
  "contract-audit",
  "contract-drift-check",
  "integration-gate",
  "accessibility-hard-check",
  "frontend-pass",
  "frontend-mobile-gate",
  "design-parity-matrix",
  "motion-reduced-check",
]);

export function commandRiskTier(commandId: string): HarnessCommandRiskTier {
  const id = String(commandId || "").trim().toLowerCase();
  if (HIGH_RISK_COMMANDS.has(id)) return "high";
  if (MEDIUM_RISK_COMMANDS.has(id)) return "medium";
  return "low";
}

export function buildHarnessCommandPolicyMeta(input: {
  commandId: string;
  mode: HarnessCommandValidationMode;
}): HarnessCommandPolicyMeta {
  const commandId = String(input.commandId || "").trim().toLowerCase();
  const tier = commandRiskTier(commandId);
  const requirements: string[] = [];

  if (tier === "medium") {
    requirements.push("When using force=true, include policyReason (>=8 chars).");
  } else if (tier === "high") {
    requirements.push("Require policyAck=true.");
    requirements.push("Require policyReason (>=12 chars).");
    requirements.push("Require policyApprovedBy (>=2 chars).");
    requirements.push("Require rollbackPlan (>=12 chars).");
    if (commandId === "security-vuln-repro") {
      requirements.push("Require policyAuthorizedScope (explicit authorized target/scope).");
    }
    requirements.push(
      "Optional emergency bypass: set policyOverride=true only when FYP_HARNESS_POLICY_ALLOW_HIGH_RISK=1.",
    );
  }

  return {
    commandId,
    mode: input.mode,
    tier,
    requirements,
  };
}

export function evaluateHarnessCommandPolicy(input: {
  command: AgentCommandDef;
  mode: HarnessCommandValidationMode;
  payload: any;
  env?: NodeJS.ProcessEnv;
}): HarnessCommandPolicyDecision {
  const commandId = String(input.command?.id ?? "").trim().toLowerCase();
  const meta = buildHarnessCommandPolicyMeta({ commandId, mode: input.mode });
  const payload = input.payload ?? {};
  const env = input.env ?? process.env;
  const satisfied: string[] = [];

  if (meta.tier === "low") {
    return { ok: true, meta, satisfied, bypassed: false };
  }

  const policyReason = toNonEmpty(payload?.policyReason);
  const force = payload?.force === true;

  if (meta.tier === "medium") {
    if (!force) return { ok: true, meta, satisfied, bypassed: false };
    if (policyReason.length < 8) {
      return {
        ok: false,
        meta,
        reason: "force=true requires policyReason (>=8 chars) for medium-risk commands",
        unmet: ["policyReason"],
      };
    }
    satisfied.push("policyReason");
    return { ok: true, meta, satisfied, bypassed: false };
  }

  const allowHighRiskBypass = truthy(env.FYP_HARNESS_POLICY_ALLOW_HIGH_RISK);
  const policyOverride = payload?.policyOverride === true;
  if (allowHighRiskBypass && policyOverride) {
    return {
      ok: true,
      meta,
      satisfied: ["policyOverride(env-allowed)"],
      bypassed: true,
    };
  }

  const policyAck = payload?.policyAck === true;
  const policyApprovedBy = toNonEmpty(payload?.policyApprovedBy);
  const rollbackPlan = toNonEmpty(payload?.rollbackPlan);
  const policyAuthorizedScope = toNonEmpty(payload?.policyAuthorizedScope);
  const unmet: string[] = [];

  if (!policyAck) unmet.push("policyAck");
  else satisfied.push("policyAck");
  if (policyReason.length < 12) unmet.push("policyReason");
  else satisfied.push("policyReason");
  if (policyApprovedBy.length < 2) unmet.push("policyApprovedBy");
  else satisfied.push("policyApprovedBy");
  if (rollbackPlan.length < 12) unmet.push("rollbackPlan");
  else satisfied.push("rollbackPlan");
  if (commandId === "security-vuln-repro") {
    if (policyAuthorizedScope.length < 6) unmet.push("policyAuthorizedScope");
    else satisfied.push("policyAuthorizedScope");
  }

  if (unmet.length > 0) {
    return {
      ok: false,
      meta,
      reason: `high-risk command policy unmet: ${unmet.join(", ")}`,
      unmet,
    };
  }
  return { ok: true, meta, satisfied, bypassed: false };
}

