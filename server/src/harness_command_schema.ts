import type { AgentCommandDef } from "./harness.js";

export type HarnessCommandValidationMode =
  | "system.sync"
  | "system.review"
  | "orchestrator.input"
  | "worker.send_task"
  | "worker.dispatch";

type JsonSchemaNode = {
  type?: "object" | "string" | "boolean" | "integer" | "array";
  description?: string;
  enum?: Array<string | number | boolean>;
  const?: string | number | boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
};

export type HarnessCommandPayloadSchema = {
  commandId: string;
  mode: HarnessCommandValidationMode;
  schema: JsonSchemaNode;
  requiredNonEmpty: string[];
  requiredAnyOf: string[];
};

export type HarnessCommandSchemaValidationResult =
  | {
      ok: true;
      schema: HarnessCommandPayloadSchema;
    }
  | {
      ok: false;
      schema: HarnessCommandPayloadSchema;
      reason: string;
      errors: string[];
    };

const PROP = {
  commandId: { type: "string", minLength: 1, maxLength: 120, description: "Canonical command id." } as JsonSchemaNode,
  id: { type: "string", minLength: 1, maxLength: 120, description: "Alias for command id." } as JsonSchemaNode,
  target: { type: "string", minLength: 1, maxLength: 160 } as JsonSchemaNode,
  task: { type: "string", minLength: 1, maxLength: 5000 } as JsonSchemaNode,
  text: { type: "string", minLength: 1, maxLength: 5000 } as JsonSchemaNode,
  objective: { type: "string", minLength: 1, maxLength: 5000 } as JsonSchemaNode,
  rawPrompt: { type: "string", minLength: 1, maxLength: 8000 } as JsonSchemaNode,
  scope: {
    type: "array",
    minItems: 1,
    maxItems: 40,
    items: { type: "string", minLength: 1, maxLength: 260 },
  } as JsonSchemaNode,
  verify: {
    type: "array",
    minItems: 1,
    maxItems: 40,
    items: { type: "string", minLength: 1, maxLength: 260 },
  } as JsonSchemaNode,
  notYourJob: {
    type: "array",
    minItems: 1,
    maxItems: 30,
    items: { type: "string", minLength: 1, maxLength: 260 },
  } as JsonSchemaNode,
  doneWhen: {
    type: "array",
    minItems: 1,
    maxItems: 30,
    items: { type: "string", minLength: 1, maxLength: 260 },
  } as JsonSchemaNode,
  extra: { type: "string", minLength: 1, maxLength: 3000 } as JsonSchemaNode,
  notes: { type: "string", minLength: 1, maxLength: 3000 } as JsonSchemaNode,
  priority: { type: "string", enum: ["HIGH", "NORMAL", "LOW", "MEDIUM", "CRITICAL", "P0"] } as JsonSchemaNode,
  interrupt: { type: "boolean" } as JsonSchemaNode,
  forceInterrupt: { type: "boolean" } as JsonSchemaNode,
  interruptMode: { type: "string", enum: ["normal", "force", "NORMAL", "FORCE"] } as JsonSchemaNode,
  initialize: { type: "boolean" } as JsonSchemaNode,
  init: { type: "boolean" } as JsonSchemaNode,
  includeBootstrap: { type: "boolean" } as JsonSchemaNode,
  first: { type: "boolean" } as JsonSchemaNode,
  runNow: { type: "boolean" } as JsonSchemaNode,
  force: { type: "boolean" } as JsonSchemaNode,
  deliverToOrchestrator: { type: "boolean" } as JsonSchemaNode,
  questionMode: { type: "string", minLength: 1, maxLength: 40 } as JsonSchemaNode,
  steeringMode: { type: "string", minLength: 1, maxLength: 40 } as JsonSchemaNode,
  questionTimeoutMs: { type: "integer", minimum: 0, maximum: 86_400_000 } as JsonSchemaNode,
  reviewIntervalMs: { type: "integer", minimum: 0, maximum: 86_400_000 } as JsonSchemaNode,
  yoloMode: { type: "boolean" } as JsonSchemaNode,
  idempotencyKey: { type: "string", minLength: 1, maxLength: 180 } as JsonSchemaNode,
  policyAck: { type: "boolean" } as JsonSchemaNode,
  policyOverride: { type: "boolean" } as JsonSchemaNode,
  policyReason: { type: "string", minLength: 1, maxLength: 600 } as JsonSchemaNode,
  policyApprovedBy: { type: "string", minLength: 1, maxLength: 120 } as JsonSchemaNode,
  policyTicket: { type: "string", minLength: 1, maxLength: 160 } as JsonSchemaNode,
  policyAuthorizedScope: { type: "string", minLength: 1, maxLength: 800 } as JsonSchemaNode,
  rollbackPlan: { type: "string", minLength: 1, maxLength: 3000 } as JsonSchemaNode,
};

function pickProps(keys: Array<keyof typeof PROP>): Record<string, JsonSchemaNode> {
  const out: Record<string, JsonSchemaNode> = {};
  for (const key of keys) out[key] = PROP[key];
  return out;
}

function baseEnvelope(keys: Array<keyof typeof PROP>): JsonSchemaNode {
  return {
    type: "object",
    additionalProperties: false,
    properties: pickProps(keys),
    anyOf: [{ required: ["commandId"] }, { required: ["id"] }],
  };
}

const MODE_PROPERTY_KEYS: Record<HarnessCommandValidationMode, Array<keyof typeof PROP>> = {
  "system.sync": ["commandId", "id", "force", "deliverToOrchestrator", "runNow", "idempotencyKey"],
  "system.review": ["commandId", "id", "force", "runNow", "idempotencyKey", "policyReason"],
  "orchestrator.input": [
    "commandId",
    "id",
    "task",
    "text",
    "objective",
    "rawPrompt",
    "scope",
    "verify",
    "extra",
    "notes",
    "priority",
    "idempotencyKey",
    "policyAck",
    "policyOverride",
    "policyReason",
    "policyApprovedBy",
    "policyTicket",
    "policyAuthorizedScope",
    "rollbackPlan",
  ],
  "worker.send_task": [
    "commandId",
    "id",
    "target",
    "task",
    "text",
    "objective",
    "rawPrompt",
    "scope",
    "verify",
    "notYourJob",
    "doneWhen",
    "extra",
    "notes",
    "priority",
    "interrupt",
    "forceInterrupt",
    "interruptMode",
    "initialize",
    "init",
    "includeBootstrap",
    "first",
    "runNow",
    "questionMode",
    "steeringMode",
    "questionTimeoutMs",
    "reviewIntervalMs",
    "yoloMode",
    "idempotencyKey",
    "policyAck",
    "policyOverride",
    "policyReason",
    "policyApprovedBy",
    "policyTicket",
    "policyAuthorizedScope",
    "rollbackPlan",
  ],
  "worker.dispatch": [
    "commandId",
    "id",
    "target",
    "task",
    "text",
    "objective",
    "rawPrompt",
    "scope",
    "verify",
    "notYourJob",
    "doneWhen",
    "extra",
    "notes",
    "priority",
    "interrupt",
    "forceInterrupt",
    "interruptMode",
    "runNow",
    "questionMode",
    "steeringMode",
    "questionTimeoutMs",
    "reviewIntervalMs",
    "yoloMode",
    "idempotencyKey",
    "policyAck",
    "policyOverride",
    "policyReason",
    "policyApprovedBy",
    "policyTicket",
    "policyAuthorizedScope",
    "rollbackPlan",
  ],
};

const COMMAND_REQUIREMENTS: Record<
  string,
  {
    requiredNonEmpty?: string[];
    requiredAnyOf?: string[];
  }
> = {
  "scope-lock": { requiredNonEmpty: ["scope"] },
  "coord-task": { requiredNonEmpty: ["scope"], requiredAnyOf: ["task", "text", "objective", "rawPrompt"] },
  "verify-completion": { requiredNonEmpty: ["verify"] },
  "test-tdd": { requiredNonEmpty: ["verify"] },
  "security-vuln-repro": { requiredNonEmpty: ["scope"] },
};

export function buildHarnessCommandPayloadSchema(input: {
  commandId: string;
  mode: HarnessCommandValidationMode;
}): HarnessCommandPayloadSchema {
  const commandId = String(input.commandId || "").trim().toLowerCase();
  const mode = input.mode;
  const req = COMMAND_REQUIREMENTS[commandId] ?? {};
  return {
    commandId,
    mode,
    schema: baseEnvelope(MODE_PROPERTY_KEYS[mode]),
    requiredNonEmpty: Array.isArray(req.requiredNonEmpty) ? req.requiredNonEmpty : [],
    requiredAnyOf: Array.isArray(req.requiredAnyOf) ? req.requiredAnyOf : [],
  };
}

function validateNode(schema: JsonSchemaNode, value: unknown, path: string, errors: string[]): void {
  if (!schema) return;

  if (schema.anyOf && schema.anyOf.length > 0) {
    const branchOk = schema.anyOf.some((branch) => {
      const branchErrs: string[] = [];
      validateNode(branch, value, path, branchErrs);
      return branchErrs.length === 0;
    });
    if (!branchOk) errors.push(`${path}: does not match any allowed schema branch`);
  }

  if (schema.required && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    for (const name of schema.required) {
      if (!(name in rec)) errors.push(`${path}.${name}: is required`);
    }
  }

  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${path}: expected object`);
      return;
    }
    const rec = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(rec)) {
        if (!(key in props)) errors.push(`${path}.${key}: unknown field`);
      }
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (!(key in rec)) continue;
      validateNode(propSchema, rec[key], `${path}.${key}`, errors);
    }
    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${path}: expected string`);
      return;
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: must have at least ${schema.minLength} chars`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: must have at most ${schema.maxLength} chars`);
    }
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
  } else if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
      errors.push(`${path}: expected integer`);
      return;
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
      return;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: must have at least ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: must have at most ${schema.maxItems} items`);
    if (schema.items) {
      for (let i = 0; i < value.length; i += 1) {
        validateNode(schema.items, value[i], `${path}[${i}]`, errors);
      }
    }
  }

  if (schema.enum && schema.enum.length > 0) {
    const ok = schema.enum.some((e) => e === (value as any));
    if (!ok) errors.push(`${path}: must be one of [${schema.enum.join(", ")}]`);
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    if (value !== schema.const) errors.push(`${path}: must equal ${String(schema.const)}`);
  }
}

function isNonEmptyValue(v: unknown): boolean {
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return typeof v !== "undefined" && v !== null;
}

export function validateHarnessCommandPayloadBySchema(input: {
  command: AgentCommandDef;
  mode: HarnessCommandValidationMode;
  payload: any;
}): HarnessCommandSchemaValidationResult {
  const schema = buildHarnessCommandPayloadSchema({
    commandId: String(input.command?.id ?? "").toLowerCase(),
    mode: input.mode,
  });
  const errors: string[] = [];
  validateNode(schema.schema, input.payload, "$", errors);

  if (errors.length === 0) {
    for (const field of schema.requiredNonEmpty) {
      if (!isNonEmptyValue(input.payload?.[field])) {
        errors.push(`$.${field}: required non-empty field for command '${schema.commandId}'`);
      }
    }
    if (schema.requiredAnyOf.length > 0) {
      const okAny = schema.requiredAnyOf.some((k) => isNonEmptyValue(input.payload?.[k]));
      if (!okAny) {
        errors.push(
          `$: command '${schema.commandId}' requires at least one of [${schema.requiredAnyOf.join(", ")}]`,
        );
      }
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      schema,
      reason: errors[0] || "schema validation failed",
      errors,
    };
  }
  return { ok: true, schema };
}
