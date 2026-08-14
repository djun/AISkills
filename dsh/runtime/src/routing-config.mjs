import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const CONFIGURABLE_ROLES = Object.freeze(["planner", "executor", "reviewer"]);
export const ROUTING_CONFIG_PROMPT = [
  "## Odai responsibility model configuration",
  "When the user naturally asks to inspect, set, change, or remove the planning/planner, execution/executor, or review/acceptance/reviewer model, use odai_routing_config.",
  "Translate the user's natural responsibility wording into the tool's responsibility field. Do not require internal routing terms or a special prompt form.",
  "For set, call the tool only after the user explicitly supplies both provider and model. Pass reasoningEffort or maxTokens only when the user supplies them; otherwise omit them.",
  "Never infer, recommend as chosen, or silently select any provider, model, effort, or token limit. Ask a concise clarification when provider or model is ambiguous.",
  "Do not ask the user to edit YAML, JSON, managed Agent files, or Plugin configuration. The tool owns persistence. A set/remove change applies from the next user turn.",
  "Base controller selection remains host-owned and is not changed by this tool.",
].join("\n");
const ROLE_ROUTE_FIELDS = new Set(["provider", "model", "reasoningEffort", "maxTokens"]);
const STORE_SCHEMA_VERSION = 1;

function assertPlainObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

export function resolveRoleRoute(value, role) {
  if (value === undefined) return undefined;
  if (!CONFIGURABLE_ROLES.includes(role)) throw new TypeError(`unknown odai routing responsibility: ${role}`);
  const route = assertPlainObject(value, `routing role ${role}`);
  const unknown = Object.keys(route).filter((field) => !ROLE_ROUTE_FIELDS.has(field));
  if (unknown.length > 0) {
    throw new TypeError(`routing role ${role} has unknown fields: ${unknown.join(", ")}`);
  }
  if (typeof route.provider !== "string" || route.provider.trim() === "") {
    throw new TypeError(`routing role ${role}.provider must be a non-empty string`);
  }
  if (typeof route.model !== "string" || route.model.trim() === "") {
    throw new TypeError(`routing role ${role}.model must be a non-empty string`);
  }
  if (route.reasoningEffort !== undefined
    && (typeof route.reasoningEffort !== "string" || route.reasoningEffort.trim() === "")) {
    throw new TypeError(`routing role ${role}.reasoningEffort must be a non-empty string`);
  }
  if (route.maxTokens !== undefined
    && (!Number.isSafeInteger(route.maxTokens) || route.maxTokens <= 0)) {
    throw new TypeError(`routing role ${role}.maxTokens must be a positive integer`);
  }

  return Object.freeze({
    provider: route.provider.trim(),
    model: route.model.trim(),
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort.trim() }),
    ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
  });
}

export function resolveRoutingConfigPath(configuredPath, env = process.env) {
  if (configuredPath !== undefined) {
    if (typeof configuredPath !== "string" || configuredPath.trim() === "") {
      throw new TypeError("config.routing.configPath must be a non-empty string");
    }
    return resolve(configuredPath.trim());
  }
  const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== ""
    ? resolve(env.DSH_HOME.trim())
    : resolve(homedir(), ".dsh");
  return resolve(dshHome, "odai", "routing.json");
}

export function readRoutingStore(configPath) {
  if (!existsSync(configPath)) {
    return Object.freeze({ schemaVersion: STORE_SCHEMA_VERSION, roles: Object.freeze({}) });
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read odai routing config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const store = assertPlainObject(parsed, `odai routing config ${configPath}`);
  const unknownStoreFields = Object.keys(store).filter((field) => !["schemaVersion", "roles"].includes(field));
  if (unknownStoreFields.length > 0) {
    throw new TypeError(`odai routing config ${configPath} has unknown fields: ${unknownStoreFields.join(", ")}`);
  }
  if (store.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new TypeError(`odai routing config ${configPath} has unsupported schemaVersion ${String(store.schemaVersion)}`);
  }
  const rawRoles = assertPlainObject(store.roles, `odai routing config ${configPath}.roles`);
  const unknown = Object.keys(rawRoles).filter((role) => !CONFIGURABLE_ROLES.includes(role));
  if (unknown.length > 0) {
    throw new TypeError(`odai routing config ${configPath} has unknown roles: ${unknown.join(", ")}`);
  }
  return Object.freeze({
    schemaVersion: STORE_SCHEMA_VERSION,
    roles: Object.freeze(Object.fromEntries(CONFIGURABLE_ROLES.flatMap((role) => {
      const route = resolveRoleRoute(rawRoles[role], role);
      return route ? [[role, route]] : [];
    }))),
  });
}

export function effectiveRoleRoute(configPath, configuredRoles, role) {
  return readRoutingStore(configPath).roles[role] ?? configuredRoles[role];
}

function writeRoutingStore(configPath, roles) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  const value = `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, roles }, null, 2)}\n`;
  try {
    writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, configPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function acquireRoutingStoreLock(configPath) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const lockPath = `${configPath}.lock`;
  const create = () => writeFileSync(lockPath, `${process.pid}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    create();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const stale = (() => {
      try {
        return Date.now() - statSync(lockPath).mtimeMs > 30_000;
      } catch {
        return false;
      }
    })();
    if (!stale) throw new Error("Odai routing configuration is being updated; retry the tool call");
    rmSync(lockPath, { force: true });
    create();
  }
  return () => rmSync(lockPath, { force: true });
}

function preserveInvalidRoutingStore(configPath) {
  if (!existsSync(configPath)) return;
  renameSync(configPath, `${configPath}.invalid-${Date.now()}-${randomUUID()}`);
}

function routeSchema(required) {
  return {
    type: "object",
    additionalProperties: false,
    ...(required ? { required: ["provider", "model"] } : {}),
    properties: {
      provider: { type: "string" },
      model: { type: "string" },
      reasoningEffort: { type: "string" },
      maxTokens: { type: "integer" },
    },
  };
}

function resultFor(configPath, action, roles, responsibility, recoveredInvalidStore = false) {
  return {
    action,
    ...(responsibility ? { responsibility } : {}),
    configPath,
    roles,
    requiresNextTurn: action !== "show",
    ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
  };
}

export function createRoutingConfigTool(configPath) {
  return {
    name: "odai_routing_config",
    description: [
      "Inspect, set, or remove Odai model mappings for planner, executor, and reviewer responsibilities.",
      "Use this only when the user naturally and explicitly asks to inspect/remove a mapping or names the provider/model to set.",
      "Never choose a provider, model, reasoning effort, or token limit on the user's behalf.",
      "For set/remove, handle one responsibility per call. Persisted mappings are shared by the Odai DSH Plugin and Agent and apply from the next user turn.",
    ].join(" "),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["show", "set", "remove"],
          description: "Show all mappings, set one user-specified mapping, or remove one mapping.",
        },
        responsibility: {
          type: "string",
          enum: [...CONFIGURABLE_ROLES],
          description: "Required for set/remove; omitted for show.",
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
          description: "Optional reasoning effort explicitly supplied by the user.",
        },
        maxTokens: {
          type: "integer",
          description: "Optional positive child output limit explicitly supplied by the user.",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "configPath", "roles", "requiresNextTurn"],
        properties: {
          action: { type: "string", enum: ["show", "set", "remove"] },
          responsibility: { type: "string", enum: [...CONFIGURABLE_ROLES] },
          configPath: { type: "string" },
          roles: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(CONFIGURABLE_ROLES.map((role) => [role, routeSchema(true)])),
          },
          requiresNextTurn: { type: "boolean" },
          recoveredInvalidStore: { type: "boolean" },
        },
      },
      render(_args, value) {
        const mapping = Object.entries(value.roles)
          .map(([role, route]) => {
            const options = [
              ...(route.reasoningEffort ? [`reasoningEffort=${route.reasoningEffort}`] : []),
              ...(route.maxTokens ? [`maxTokens=${route.maxTokens}`] : []),
            ];
            return `${role}: ${route.provider}/${route.model}${options.length > 0 ? ` (${options.join(", ")})` : ""}`;
          })
          .join("\n") || "No Odai responsibility models are configured.";
        return [{
          type: "text",
          text: [
            `${value.action === "show" ? "Current" : "Updated"} Odai routing configuration:\n${mapping}`,
            ...(value.recoveredInvalidStore ? ["\nAn invalid prior store was preserved and replaced."] : []),
            ...(value.requiresNextTurn ? ["\nThe change applies from the next user turn."] : []),
          ].join(""),
        }];
      },
    },
    execute(args, execution) {
      if (!execution.agent) throw new Error("odai_routing_config requires an owning agent session");
      const header = execution.agent.session?.header;
      if (header?.origin === "subagent" || (Number.isSafeInteger(header?.delegationDepth) && header.delegationDepth > 0)) {
        throw new Error("child agents may not change Odai routing configuration");
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("arguments must be an object");
      if (!["show", "set", "remove"].includes(args.action)) throw new TypeError("action must be show, set, or remove");

      if (args.action === "show") {
        return Promise.resolve(resultFor(configPath, "show", readRoutingStore(configPath).roles));
      }
      if (!CONFIGURABLE_ROLES.includes(args.responsibility)) {
        throw new TypeError("responsibility must be planner, executor, or reviewer for set/remove");
      }
      const proposedRoute = args.action === "set" ? resolveRoleRoute({
        provider: args.provider,
        model: args.model,
        ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
        ...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
      }, args.responsibility) : undefined;

      const releaseLock = acquireRoutingStoreLock(configPath);
      try {
        let current;
        let recoveredInvalidStore = false;
        try {
          current = readRoutingStore(configPath);
        } catch (error) {
          if (args.action !== "set") {
            throw new Error("Odai routing configuration is invalid; ask the user to set a responsibility mapping to repair it automatically", { cause: error });
          }
          preserveInvalidRoutingStore(configPath);
          current = { roles: {} };
          recoveredInvalidStore = true;
        }

        const roles = { ...current.roles };
        if (args.action === "remove") delete roles[args.responsibility];
        else roles[args.responsibility] = proposedRoute;
        writeRoutingStore(configPath, roles);
        execution.agent.session?.append?.("odai/routing-configured", {
          action: args.action,
          responsibility: args.responsibility,
          route: roles[args.responsibility],
          ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
        });
        return Promise.resolve(resultFor(
          configPath,
          args.action,
          roles,
          args.responsibility,
          recoveredInvalidStore,
        ));
      } finally {
        releaseLock();
      }
    },
  };
}
