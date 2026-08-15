import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { acquireOwnedStoreLock } from "./store-lock.mjs";

const STORE_SCHEMA_VERSION = 1;
const POLICY_FIELDS = new Set(["concise", "maxTokens"]);
export const DEFAULT_OUTPUT_POLICY = Object.freeze({ concise: false });

export class OutputPolicyStoreValidationError extends Error {}

function assertPlainObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

export function resolveOutputPolicy(value, field = "Odai output policy") {
  const policy = assertPlainObject(value, field);
  const unknown = Object.keys(policy).filter((name) => !POLICY_FIELDS.has(name));
  if (unknown.length > 0) throw new TypeError(`${field} has unknown fields: ${unknown.join(", ")}`);
  if (!Object.hasOwn(policy, "concise") || typeof policy.concise !== "boolean") {
    throw new TypeError(`${field}.concise must be an own boolean property`);
  }
  if (policy.maxTokens !== undefined
    && (!Number.isSafeInteger(policy.maxTokens) || policy.maxTokens <= 0)) {
    throw new TypeError(`${field}.maxTokens must be a positive integer`);
  }
  if (!policy.concise && policy.maxTokens === undefined) {
    throw new TypeError(`${field} would have no effect; remove the override instead`);
  }
  return Object.freeze({
    concise: policy.concise,
    ...(policy.maxTokens === undefined ? {} : { maxTokens: policy.maxTokens }),
  });
}

export function resolveOutputConfigPath(configuredPath, env = process.env) {
  if (configuredPath !== undefined) {
    if (typeof configuredPath !== "string" || configuredPath.trim() === "") {
      throw new TypeError("config.output.configPath must be a non-empty string");
    }
    return resolve(configuredPath.trim());
  }
  const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== ""
    ? resolve(env.DSH_HOME.trim())
    : resolve(homedir(), ".dsh");
  return resolve(dshHome, "odai", "output.json");
}

export function readOutputPolicyStore(configPath) {
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ schemaVersion: STORE_SCHEMA_VERSION });
    throw new Error(`cannot read Odai output configuration ${configPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new OutputPolicyStoreValidationError(`Odai output configuration ${configPath} is not valid JSON`, { cause: error });
  }
  try {
    const store = assertPlainObject(parsed, `Odai output configuration ${configPath}`);
    const unknown = Object.keys(store).filter((field) => !["schemaVersion", "policy"].includes(field));
    if (unknown.length > 0) {
      throw new TypeError(`Odai output configuration ${configPath} has unknown fields: ${unknown.join(", ")}`);
    }
    if (store.schemaVersion !== STORE_SCHEMA_VERSION) {
      throw new TypeError(`Odai output configuration ${configPath} has unsupported schemaVersion ${String(store.schemaVersion)}`);
    }
    if (store.policy === undefined) return Object.freeze({ schemaVersion: STORE_SCHEMA_VERSION });
    return Object.freeze({
      schemaVersion: STORE_SCHEMA_VERSION,
      policy: resolveOutputPolicy(store.policy, `Odai output configuration ${configPath}.policy`),
    });
  } catch (error) {
    if (error instanceof OutputPolicyStoreValidationError) throw error;
    throw new OutputPolicyStoreValidationError(
      `Odai output configuration ${configPath} failed validation: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function effectiveOutputPolicy(configPath) {
  const stored = readOutputPolicyStore(configPath);
  return Object.freeze({
    policy: stored.policy ?? DEFAULT_OUTPUT_POLICY,
    source: stored.policy ? "persisted" : "default",
  });
}

function writeOutputPolicyStore(configPath, policy) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  const value = `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, policy }, null, 2)}\n`;
  try {
    writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, configPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function preserveInvalidStore(configPath) {
  try {
    renameSync(configPath, `${configPath}.invalid-${Date.now()}-${randomUUID()}`);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function resultFor(configPath, action, selection, recoveredInvalidStore = false) {
  return {
    action,
    configPath,
    policy: selection.policy,
    source: selection.source,
    requiresNextTurn: action !== "show",
    ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
  };
}

export function renderOutputPolicyPrompt(policy) {
  if (!policy.concise && policy.maxTokens === undefined) return "";
  return [
    "## Odai controller output policy",
    ...(policy.concise ? [
      "Keep the final user-facing response concise. Include only the result, decisive evidence, unresolved items, and necessary next action; omit routine process narration and repeated context unless the user explicitly asks for detail.",
    ] : []),
    ...(policy.maxTokens === undefined ? [] : [
      `Each controller model request carries a provider output ceiling request of ${policy.maxTokens} tokens, which may include reasoning. Provider enforcement is not guaranteed; prioritize completion and finish before the requested ceiling.`,
    ]),
    "This policy applies only to controller requests and the final user-facing response. It never reduces child-agent, compaction, checkpoint, or other internal context budgets.",
    "The policy changes presentation and the requested controller budget only; it never permits omitting required results, evidence, risks, blockers, or verification.",
  ].join("\n");
}

export function createOutputConfigTool(configPath, options = {}) {
  const onConfigured = typeof options.onConfigured === "function" ? options.onConfigured : () => {};
  const isChild = typeof options.isChild === "function"
    ? options.isChild
    : (agent) => {
      const header = agent?.session?.header;
      return header?.origin === "subagent"
        || (Number.isSafeInteger(header?.delegationDepth) && header.delegationDepth > 0);
    };
  return {
    name: "odai_output_config",
    description: [
      "Inspect, set, or remove the shared, default-off Odai controller output policy.",
      "Use only when the user explicitly requests concise responses or supplies maxTokens; never choose values.",
      "Changes start next user turn. maxTokens is a provider request ceiling, not locally enforced; providers may include reasoning, exceed or ignore it, or truncate responses. Child-agent and compaction budgets stay unchanged.",
    ].join(" "),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["show", "set", "remove"],
        },
        concise: {
          type: "boolean",
          description: "Required for set; must be user-selected.",
        },
        maxTokens: {
          type: "integer",
          description: "Optional positive user-supplied provider request ceiling for controller output.",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "configPath", "policy", "source", "requiresNextTurn"],
        properties: {
          action: { type: "string", enum: ["show", "set", "remove"] },
          configPath: { type: "string" },
          policy: {
            type: "object",
            additionalProperties: false,
            required: ["concise"],
            properties: {
              concise: { type: "boolean" },
              maxTokens: { type: "integer" },
            },
          },
          source: { type: "string", enum: ["default", "persisted"] },
          requiresNextTurn: { type: "boolean" },
          recoveredInvalidStore: { type: "boolean" },
        },
      },
      render(_args, value) {
        const settings = [
          `concise=${value.policy.concise ? "on" : "off"}`,
          ...(value.policy.maxTokens === undefined ? [] : [`maxTokens=${value.policy.maxTokens}`]),
        ].join(", ");
        return [{
          type: "text",
          text: [
            `${value.action === "show" ? "Current" : "Updated"} Odai controller output policy (${value.source}): ${settings}.`,
            ...(value.policy.maxTokens === undefined ? [] : [" maxTokens is sent as a provider request ceiling; strict provider compliance is not guaranteed and must be checked from usage."]),
            ...(value.recoveredInvalidStore ? [" An invalid prior store was preserved and replaced."] : []),
            ...(value.requiresNextTurn ? [" The change applies from the next user turn."] : []),
          ].join(""),
        }];
      },
    },
    execute(args, execution) {
      if (!execution.agent) throw new Error("odai_output_config requires an owning agent session");
      if (isChild(execution.agent)) throw new Error("child agents may not change Odai output configuration");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("arguments must be an object");
      const unknown = Object.keys(args).filter((field) => !["action", "concise", "maxTokens"].includes(field));
      if (unknown.length > 0) throw new TypeError(`unknown arguments: ${unknown.join(", ")}`);
      if (!["show", "set", "remove"].includes(args.action)) throw new TypeError("action must be show, set, or remove");
      if (args.action === "show") {
        if (args.concise !== undefined || args.maxTokens !== undefined) {
          throw new TypeError("concise and maxTokens must be omitted for show");
        }
        return Promise.resolve(resultFor(configPath, "show", effectiveOutputPolicy(configPath)));
      }
      if (args.action === "remove" && (args.concise !== undefined || args.maxTokens !== undefined)) {
        throw new TypeError("concise and maxTokens must be omitted for remove");
      }
      const proposed = args.action === "set"
        ? resolveOutputPolicy({
            concise: args.concise,
            ...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
          })
        : undefined;

      const releaseLock = acquireOwnedStoreLock(configPath, "Odai output configuration");
      try {
        let recoveredInvalidStore = false;
        try {
          readOutputPolicyStore(configPath);
        } catch (error) {
          if (!(error instanceof OutputPolicyStoreValidationError)) {
            throw new Error("Odai output configuration could not be read safely; no changes were made", { cause: error });
          }
          recoveredInvalidStore = preserveInvalidStore(configPath);
        }
        if (args.action === "set") writeOutputPolicyStore(configPath, proposed);
        else rmSync(configPath, { force: true });
        const selection = args.action === "set"
          ? Object.freeze({ policy: proposed, source: "persisted" })
          : Object.freeze({ policy: DEFAULT_OUTPUT_POLICY, source: "default" });
        onConfigured(execution.agent, {
          action: args.action,
          policy: selection.policy,
          ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
        });
        return Promise.resolve(resultFor(configPath, args.action, selection, recoveredInvalidStore));
      } finally {
        releaseLock();
      }
    },
  };
}
