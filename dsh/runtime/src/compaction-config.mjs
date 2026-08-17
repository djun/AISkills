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
const TARGET_FIELDS = new Set(["provider", "model", "reasoningEffort"]);
const STATE_PROTOCOL_SOURCE = Object.freeze({
  kind: "plugin",
  plugin: "odai-dsh-runtime",
  form: "instructions",
});

export const COMPACTION_STATE_PROTOCOL = [
  "Additional checkpoint integrity protocol:",
  "- Treat facts explicitly marked CURRENT, corrected, or authoritative as the active state.",
  "- Facts marked SUPERSEDED, REJECTED, obsolete, or historical may be retained only as rejected history; never describe them as current, latest, selected, or pending.",
  "- Preserve opaque identifiers, paths, commands, status values, delimiters, and numeric values byte-for-byte when they determine continuation state.",
  "- Before emitting the checkpoint, self-check that no rejected fact is framed as active and that no active value conflicts with another section.",
].join("\n");

export const COMPACTION_CONFIG_PROMPT = [
  "## Odai compaction model configuration",
  "When the user naturally asks to inspect, set, change, or reset the model or reasoning effort used to summarize compacted context, use odai_compaction_config.",
  "Set a compaction target only when the user explicitly supplies both provider and model. Pass reasoningEffort only when the user explicitly supplies it. Never infer or silently choose any value. If the user changes only the effort for an existing persisted target, inspect and preserve that exact provider/model pair.",
  "The default is inherit: compaction uses the current conversation route. A configured target changes only compaction-summary requests; it does not change the controller, researcher, planner, executor, reviewer, frontend, normal conversation, summary output budget, or cache-retention policy. An optional explicit reasoning effort is likewise scoped only to compaction summaries; omitting it preserves the existing reasoning inheritance and cross-model isolation behavior.",
  "Configured targets also receive a provider-neutral checkpoint integrity protocol that keeps current facts above superseded or rejected history and preserves continuation-critical opaque values exactly.",
  "Do not ask the user to edit YAML, JSON, managed Agent files, or Plugin configuration. The tool owns persistence. Set/remove changes apply to the next compaction request.",
  "An invalid persisted store is visible through the tool while runtime requests safely inherit the conversation route. If the configured route fails or produces an incomplete summary, DSH must preserve the original history rather than landing a partial checkpoint.",
].join("\n");

export class CompactionModelStoreValidationError extends Error {}

function assertPlainObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

export function resolveCompactionTarget(value, field = "Odai compaction model target") {
  const target = assertPlainObject(value, field);
  const unknown = Object.keys(target).filter((name) => !TARGET_FIELDS.has(name));
  if (unknown.length > 0) throw new TypeError(`${field} has unknown fields: ${unknown.join(", ")}`);
  if (typeof target.provider !== "string" || target.provider.trim() === "") {
    throw new TypeError(`${field}.provider must be a non-empty string`);
  }
  if (typeof target.model !== "string" || target.model.trim() === "") {
    throw new TypeError(`${field}.model must be a non-empty string`);
  }
  if (target.reasoningEffort !== undefined
    && (typeof target.reasoningEffort !== "string" || target.reasoningEffort.trim() === "")) {
    throw new TypeError(`${field}.reasoningEffort must be a non-empty string`);
  }
  return Object.freeze({
    provider: target.provider.trim(),
    model: target.model.trim(),
    ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort.trim() }),
  });
}

export function resolveCompactionConfigPath(configuredPath, env = process.env) {
  if (configuredPath !== undefined) {
    if (typeof configuredPath !== "string" || configuredPath.trim() === "") {
      throw new TypeError("config.compaction.configPath must be a non-empty string");
    }
    return resolve(configuredPath.trim());
  }
  const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== ""
    ? resolve(env.DSH_HOME.trim())
    : resolve(homedir(), ".dsh");
  return resolve(dshHome, "odai", "compaction.json");
}

export function readCompactionModelStore(configPath) {
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ schemaVersion: STORE_SCHEMA_VERSION });
    throw new Error(`cannot read Odai compaction model configuration ${configPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CompactionModelStoreValidationError(`Odai compaction model configuration ${configPath} is not valid JSON`, { cause: error });
  }
  try {
    const store = assertPlainObject(parsed, `Odai compaction model configuration ${configPath}`);
    const unknown = Object.keys(store).filter((field) => !["schemaVersion", "target"].includes(field));
    if (unknown.length > 0) {
      throw new TypeError(`Odai compaction model configuration ${configPath} has unknown fields: ${unknown.join(", ")}`);
    }
    if (store.schemaVersion !== STORE_SCHEMA_VERSION) {
      throw new TypeError(`Odai compaction model configuration ${configPath} has unsupported schemaVersion ${String(store.schemaVersion)}`);
    }
    if (store.target === undefined) return Object.freeze({ schemaVersion: STORE_SCHEMA_VERSION });
    return Object.freeze({
      schemaVersion: STORE_SCHEMA_VERSION,
      target: resolveCompactionTarget(store.target, `Odai compaction model configuration ${configPath}.target`),
    });
  } catch (error) {
    if (error instanceof CompactionModelStoreValidationError) throw error;
    throw new CompactionModelStoreValidationError(
      `Odai compaction model configuration ${configPath} failed validation: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function effectiveCompactionTarget(configPath) {
  const stored = readCompactionModelStore(configPath);
  return Object.freeze({
    ...(stored.target === undefined ? {} : { target: stored.target }),
    source: stored.target === undefined ? "inherit" : "persisted",
  });
}

export function applyCompactionTarget(options, target, sessions) {
  if (options?.purpose !== "compaction" || target === undefined) return false;
  const currentRoute = options.sessionId === undefined
    ? undefined
    : sessions?.get?.(options.sessionId)?.requestHeader?.()?.config;
  const durableRouteKnown = typeof currentRoute?.provider === "string"
    && currentRoute.provider.length > 0
    && typeof currentRoute.model === "string"
    && currentRoute.model.length > 0;
  const targetChangesDurableRoute = durableRouteKnown
    && (currentRoute.provider !== target.provider || currentRoute.model !== target.model);
  const inheritedReasoning = targetChangesDurableRoute
    && typeof currentRoute.reasoningEffort === "string"
    && currentRoute.reasoningEffort.length > 0
    && options.reasoningEffort === currentRoute.reasoningEffort;
  const changesRoute = options.provider !== target.provider || options.model !== target.model;
  const changesReasoning = target.reasoningEffort !== undefined
    && options.reasoningEffort !== target.reasoningEffort;
  if (!changesRoute && !inheritedReasoning && !changesReasoning) return false;
  if (!Object.isExtensible(options)) {
    throw new Error("configured Odai compaction model cannot be applied to an immutable request");
  }

  if (target.reasoningEffort !== undefined) options.reasoningEffort = target.reasoningEffort;
  else if (inheritedReasoning) delete options.reasoningEffort;
  if (changesRoute) {
    options.provider = target.provider;
    options.model = target.model;
  }
  return true;
}

export function applyCompactionStateProtocol(options, target) {
  if (options?.purpose !== "compaction" || target === undefined) return false;
  if (!Array.isArray(options.messages) || !Object.isExtensible(options)) {
    throw new Error("configured Odai compaction model requires a mutable message envelope for checkpoint integrity");
  }
  const alreadyApplied = options.messages.some((message) => (
    message?.source?.kind === STATE_PROTOCOL_SOURCE.kind
    && message.source.plugin === STATE_PROTOCOL_SOURCE.plugin
    && message.source.form === STATE_PROTOCOL_SOURCE.form
    && Array.isArray(message.content)
    && message.content.some((block) => block?.type === "text" && block.text === COMPACTION_STATE_PROTOCOL)
  ));
  if (alreadyApplied) return false;
  options.messages = [...options.messages, {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: COMPACTION_STATE_PROTOCOL }],
    source: STATE_PROTOCOL_SOURCE,
  }];
  return true;
}

function writeCompactionModelStore(configPath, target) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  const value = `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, target }, null, 2)}\n`;
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
    source: selection.source,
    ...(selection.target === undefined ? {} : { target: selection.target }),
    requiresNextCompaction: action !== "show",
    ...(selection.invalidStore ? { invalidStore: true } : {}),
    ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
  };
}

export function createCompactionConfigTool(configPath, options = {}) {
  const onConfigured = typeof options.onConfigured === "function" ? options.onConfigured : () => {};
  const isChild = typeof options.isChild === "function"
    ? options.isChild
    : (agent) => {
      const header = agent?.session?.header;
      return header?.origin === "subagent"
        || (Number.isSafeInteger(header?.delegationDepth) && header.delegationDepth > 0);
    };
  return {
    name: "odai_compaction_config",
    description: [
      "Inspect, set, or remove the shared Odai compaction-summary target.",
      "Use only when the user naturally asks about the compaction model/reasoning effort or explicitly supplies the provider and model to set. Never select a provider, model, or reasoning effort on the user's behalf.",
      "The default is inherit. A persisted target changes only future compaction-summary requests; controller and responsibility routes, output budget, and cache retention stay unchanged. An optional user-specified reasoning effort applies only to those summaries.",
      "Persisted targets also receive a provider-neutral integrity protocol that keeps current facts above superseded history and preserves continuation-critical opaque values exactly.",
      "An invalid store is reported while runtime requests safely inherit. If the configured route or summary fails, DSH preserves the original history. Changes apply from the next compaction request.",
    ].join(" "),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["show", "set", "remove"],
          description: "Show the effective target, set a user-specified provider/model and optional reasoning effort, or remove it to restore inheritance.",
        },
        provider: {
          type: "string",
          description: "Provider id explicitly supplied by the user; required for set.",
        },
        model: {
          type: "string",
          description: "Model id explicitly supplied by the user; required for set.",
        },
        reasoningEffort: {
          type: "string",
          description: "Optional compaction reasoning effort explicitly supplied by the user.",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "configPath", "source", "requiresNextCompaction"],
        properties: {
          action: { type: "string", enum: ["show", "set", "remove"] },
          configPath: { type: "string" },
          source: { type: "string", enum: ["inherit", "persisted"] },
          target: {
            type: "object",
            additionalProperties: false,
            required: ["provider", "model"],
            properties: {
              provider: { type: "string" },
              model: { type: "string" },
              reasoningEffort: { type: "string" },
            },
          },
          requiresNextCompaction: { type: "boolean" },
          invalidStore: { type: "boolean" },
          recoveredInvalidStore: { type: "boolean" },
        },
      },
      render(_args, value) {
        const target = value.target
          ? `${value.target.provider}/${value.target.model} (reasoning: ${value.target.reasoningEffort ?? "not configured"})`
          : "inherit the current conversation model and reasoning";
        return [{
          type: "text",
          text: [
            `${value.action === "show" ? "Current" : "Updated"} Odai compaction target (${value.source}): ${target}.`,
            " This affects compaction summaries only; other model routes, the summary budget, and cache retention are unchanged.",
            ...(value.invalidStore ? [" The persisted store is invalid, so runtime requests currently inherit; set or remove the target to repair it."] : []),
            ...(value.recoveredInvalidStore ? [" An invalid prior store was preserved before the configuration was repaired or reset."] : []),
            ...(value.requiresNextCompaction ? [" The change applies from the next compaction request."] : []),
          ].join(""),
        }];
      },
    },
    execute(args, execution) {
      if (!execution.agent) throw new Error("odai_compaction_config requires an owning agent session");
      if (isChild(execution.agent)) throw new Error("child agents may not change Odai compaction model configuration");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("arguments must be an object");
      const unknown = Object.keys(args).filter((field) => !["action", "provider", "model", "reasoningEffort"].includes(field));
      if (unknown.length > 0) throw new TypeError(`unknown arguments: ${unknown.join(", ")}`);
      if (!["show", "set", "remove"].includes(args.action)) throw new TypeError("action must be show, set, or remove");
      if (args.action === "show") {
        if (args.provider !== undefined || args.model !== undefined || args.reasoningEffort !== undefined) {
          throw new TypeError("provider, model, and reasoningEffort must be omitted for show");
        }
        let selection;
        try {
          selection = effectiveCompactionTarget(configPath);
        } catch (error) {
          if (!(error instanceof CompactionModelStoreValidationError)) throw error;
          selection = Object.freeze({ source: "inherit", invalidStore: true });
        }
        return Promise.resolve(resultFor(configPath, "show", selection));
      }
      if (args.action === "remove"
        && (args.provider !== undefined || args.model !== undefined || args.reasoningEffort !== undefined)) {
        throw new TypeError("provider, model, and reasoningEffort must be omitted for remove");
      }
      const proposed = args.action === "set"
        ? resolveCompactionTarget({
            provider: args.provider,
            model: args.model,
            ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
          })
        : undefined;

      const releaseLock = acquireOwnedStoreLock(configPath, "Odai compaction model configuration");
      try {
        let recoveredInvalidStore = false;
        try {
          readCompactionModelStore(configPath);
        } catch (error) {
          if (!(error instanceof CompactionModelStoreValidationError)) {
            throw new Error("Odai compaction model configuration could not be read safely; no changes were made", { cause: error });
          }
          recoveredInvalidStore = preserveInvalidStore(configPath);
        }
        if (args.action === "set") writeCompactionModelStore(configPath, proposed);
        else rmSync(configPath, { force: true });
        const selection = args.action === "set"
          ? Object.freeze({ target: proposed, source: "persisted" })
          : Object.freeze({ source: "inherit" });
        onConfigured(execution.agent, {
          action: args.action,
          ...(selection.target === undefined ? {} : { target: selection.target }),
          ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
        });
        return Promise.resolve(resultFor(configPath, args.action, selection, recoveredInvalidStore));
      } finally {
        releaseLock();
      }
    },
  };
}
