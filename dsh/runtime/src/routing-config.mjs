import { randomUUID } from "node:crypto";
import {
  copyFileSync,
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

import { requireModelRoute, sameModelRoute } from "./model-route.mjs";
import {
  IN_PLACE_OUTPUT_RESPONSIBILITIES,
  resolveInPlaceResponsibilityOutputBudgets,
} from "./output-config.mjs";

export const CONFIGURABLE_ROLES = Object.freeze(["researcher", "planner", "executor", "reviewer", "frontend"]);
export const ROUTING_CONFIG_PROMPT = [
  "## Odai responsibility model configuration",
  "When the user naturally asks to inspect, set, change, or remove the research/investigation, planning/planner, execution/executor, review/acceptance/reviewer, or frontend design/implementation model, use odai_routing_config.",
  "Translate the user's natural responsibility wording into the tool's responsibility field. Do not require internal routing terms or a special prompt form.",
  "For set, call the tool only after the user explicitly supplies both provider and model. Pass reasoningEffort or maxTokens only when the user supplies them; otherwise omit them.",
  "Never infer, recommend as chosen, or silently select any provider, model, effort, token limit, or price. Ask a concise clarification when provider or model is ambiguous.",
  "Researcher routing is task-gated but not price-aware. A researcher mapping enables the narrow trigger but does not guarantee lower cost; compare actual provider prices and measured usage without inventing either.",
  "A generic subagent is not proof that a configured responsibility ran. When a real responsibility gap emerges after initial routing and manual delegation is necessary, begin the subagent label with `odai-<responsibility>` followed by a space or colon; otherwise keep it generic and do not claim the responsibility mapping was used.",
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
  return effectiveRoutingSnapshot(configPath, configuredRoles).roles[role];
}

export function effectiveRoutingSnapshot(configPath, configuredRoles = {}) {
  const persisted = readRoutingStore(configPath).roles;
  const roles = {};
  const sources = {};
  for (const role of CONFIGURABLE_ROLES) {
    const route = persisted[role] ?? configuredRoles[role];
    if (!route) continue;
    roles[role] = route;
    sources[role] = persisted[role] ? "persisted-mapping" : "deployment-config";
  }
  return Object.freeze({
    roles: Object.freeze(roles),
    sources: Object.freeze(sources),
  });
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

export function invalidatePersistedRoleRoute(configPath, role, expectedRoute) {
  if (!CONFIGURABLE_ROLES.includes(role)) throw new TypeError(`unknown odai routing responsibility: ${role}`);
  const releaseLock = acquireRoutingStoreLock(configPath);
  try {
    const current = readRoutingStore(configPath);
    const persisted = current.roles[role];
    if (!sameModelRoute(persisted, expectedRoute)) {
      return Object.freeze({ invalidated: false, reason: "mapping-changed-or-not-persisted" });
    }
    const backupPath = `${configPath}.invalidated-${Date.now()}-${randomUUID()}`;
    copyFileSync(configPath, backupPath);
    const roles = { ...current.roles };
    delete roles[role];
    writeRoutingStore(configPath, roles);
    return Object.freeze({ invalidated: true, backupPath, route: persisted });
  } finally {
    releaseLock();
  }
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

function resultFor(configPath, action, snapshot, responsibility, recoveredInvalidStore = false, latestRoute, outputPolicy) {
  const responsibilityBudgets = resolveInPlaceResponsibilityOutputBudgets(outputPolicy, snapshot.roles);
  return {
    action,
    ...(responsibility ? { responsibility } : {}),
    configPath,
    roles: snapshot.roles,
    sources: snapshot.sources,
    requiresNextTurn: action !== "show",
    ...(responsibilityBudgets ? { responsibilityBudgets } : {}),
    ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
    ...(latestRoute ? { latestRoute } : {}),
  };
}

export function createRoutingConfigTool(configPath, options = {}) {
  const onConfigured = typeof options.onConfigured === "function" ? options.onConfigured : () => {};
  const configuredRoles = options.configuredRoles ?? {};
  const latestRouteFor = typeof options.latestRouteFor === "function" ? options.latestRouteFor : () => undefined;
  const outputPolicyFor = typeof options.outputPolicyFor === "function" ? options.outputPolicyFor : () => undefined;
  const resolveCallConfig = typeof options.resolveCallConfig === "function" ? options.resolveCallConfig : undefined;
  return {
    name: "odai_routing_config",
    description: [
      "Inspect effective Odai model mappings and the latest current-session route receipt, or set/remove persisted mappings for researcher, planner, executor, reviewer, and frontend responsibilities.",
      "Use this only when the user naturally and explicitly asks to inspect/remove a mapping or names the provider/model to set.",
      "Never choose a provider, model, reasoning effort, token limit, or price on the user's behalf.",
      "Researcher routing is task-gated but not price-aware; its mapping does not guarantee lower cost.",
      "For set/remove, handle one responsibility per call. Persisted mappings are shared by the Odai DSH Plugin and Agent and apply from the next user turn.",
      "Results expose configured in-place responsibility ceilings and warn when planner, executor, or frontend mappings without maxTokens inherit the controller ceiling; never invent an override.",
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
          description: "Optional positive output limit explicitly supplied by the user. It limits routed child requests and explicitly overrides the global controller ceiling only inside the same planner, executor, or frontend responsibility scope when that responsibility runs in-place."
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "configPath", "roles", "sources", "requiresNextTurn"],
        properties: {
          action: { type: "string", enum: ["show", "set", "remove"] },
          responsibility: { type: "string", enum: [...CONFIGURABLE_ROLES] },
          configPath: { type: "string" },
          roles: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(CONFIGURABLE_ROLES.map((role) => [role, routeSchema(true)])),
          },
          sources: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(CONFIGURABLE_ROLES.map((role) => [role, {
              type: "string",
              enum: ["persisted-mapping", "deployment-config"],
            }])),
          },
          requiresNextTurn: { type: "boolean" },
          recoveredInvalidStore: { type: "boolean" },
          responsibilityBudgets: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(IN_PLACE_OUTPUT_RESPONSIBILITIES.map((responsibility) => [responsibility, {
              type: "object",
              additionalProperties: false,
              required: ["source"],
              properties: {
                source: { type: "string", enum: ["responsibility-override", "controller-policy", "unbounded-by-odai"] },
                maxTokens: { type: "integer" },
                warning: { type: "string", enum: ["responsibility-inherits-controller-ceiling"] },
              },
            }])),
          },
          latestRoute: {
            type: "object",
            additionalProperties: false,
            required: ["turn", "step", "responsibility", "status", "routeSource", "fallbackUsed"],
            properties: {
              turn: { type: "integer" },
              step: { type: "integer" },
              responsibility: { type: "string", enum: [...CONFIGURABLE_ROLES] },
              responsibilityScopeId: { type: "string" },
              routeCardId: { type: "string" },
              status: { type: "string", enum: ["applied", "mismatch", "unverified", "fallback"] },
              taskStatus: { type: "string", enum: ["completed", "fallback"] },
              routeMode: { type: "string", enum: ["inline", "same-turn", "child"] },
              routeSource: { type: "string", enum: ["persisted-mapping", "deployment-config"] },
              fallbackUsed: { type: "boolean" },
              requestedRoute: routeSchema(true),
              actualRoute: routeSchema(true),
              stopReason: { type: "string" },
              error: { type: "string" },
              taskStopReason: { type: "string" },
              taskError: { type: "string" },
            },
          },
        },
      },
      render(_args, value) {
        const mapping = Object.entries(value.roles)
          .map(([role, route]) => {
            const options = [
              ...(route.reasoningEffort ? [`reasoningEffort=${route.reasoningEffort}`] : []),
              ...(route.maxTokens ? [`maxTokens=${route.maxTokens}`] : []),
            ];
            return `${role}: ${route.provider}/${route.model}${options.length > 0 ? ` (${options.join(", ")})` : ""} [${value.sources[role]}]`;
          })
          .join("\n") || "No Odai responsibility models are configured.";
        const responsibilityBudgets = Object.entries(value.responsibilityBudgets ?? {});
        const configuredResponsibilities = responsibilityBudgets.length > 0
          ? `\nIn-place responsibility ceilings: ${responsibilityBudgets.map(([responsibility, budget]) => (
              `${responsibility}=${budget.maxTokens === undefined ? "no Odai maxTokens" : `maxTokens=${budget.maxTokens}`} [${budget.source}]`
            )).join("; ")}.`
          : "";
        const inheritedWarnings = responsibilityBudgets
          .filter(([, budget]) => budget.warning === "responsibility-inherits-controller-ceiling")
          .map(([responsibility]) => `\nWarning: ${responsibility} has no explicit maxTokens and inherits the controller ceiling when routed in-place; providers may count reasoning and truncate substantial work.`)
          .join("");
        const latestRoute = value.latestRoute
          ? [
              "\nLatest current-session responsibility route receipt:",
              `responsibility=${value.latestRoute.responsibility} status=${value.latestRoute.status} mode=${value.latestRoute.routeMode ?? "unknown"}`,
              `routeSource=${value.latestRoute.routeSource} fallbackUsed=${String(value.latestRoute.fallbackUsed)}`,
              ...(value.latestRoute.responsibilityScopeId ? [`responsibilityScope=${value.latestRoute.responsibilityScopeId}`] : []),
              ...(value.latestRoute.routeCardId ? [`routeCard=${value.latestRoute.routeCardId}`] : []),
              ...(value.latestRoute.taskStatus ? [`taskStatus=${value.latestRoute.taskStatus}`] : []),
              ...(value.latestRoute.taskStopReason ? [`taskStopReason=${value.latestRoute.taskStopReason}`] : []),
              ...(value.latestRoute.error ? [`routeError=${value.latestRoute.error}`] : []),
              ...(value.latestRoute.taskError ? [`taskError=${value.latestRoute.taskError}`] : []),
              ...(value.latestRoute.actualRoute
                ? [`actual=${value.latestRoute.actualRoute.provider}/${value.latestRoute.actualRoute.model} (${[
                    `reasoningEffort=${value.latestRoute.actualRoute.reasoningEffort ?? "unspecified"}`,
                    ...(value.latestRoute.actualRoute.maxTokens === undefined ? [] : [`maxTokens=${value.latestRoute.actualRoute.maxTokens}`]),
                  ].join(", ")})`]
                : ["actual=<unverified>"]),
            ].join("\n")
          : value.action === "show"
            ? "\nNo mapped responsibility route receipt is recorded in this session."
            : "";
        return [{
          type: "text",
          text: [
            `${value.action === "show" ? "Current" : "Updated"} Odai routing configuration:\n${mapping}`,
            ...(value.recoveredInvalidStore ? ["\nAn invalid prior store was preserved and replaced."] : []),
            configuredResponsibilities,
            inheritedWarnings,
            ...(value.roles.researcher ? ["\nResearcher routing is task-gated but not price-aware. This mapping does not guarantee lower cost; compare actual provider prices and measured usage."] : []),
            latestRoute,
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
        return Promise.resolve(resultFor(
          configPath,
          "show",
          effectiveRoutingSnapshot(configPath, configuredRoles),
          undefined,
          false,
          latestRouteFor(execution.agent),
          outputPolicyFor(),
        ));
      }
      if (!CONFIGURABLE_ROLES.includes(args.responsibility)) {
        throw new TypeError("responsibility must be researcher, planner, executor, reviewer, or frontend for set/remove");
      }
      const proposedRoute = args.action === "set" ? resolveRoleRoute({
        provider: args.provider,
        model: args.model,
        ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
        ...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
      }, args.responsibility) : undefined;

      const commit = (validationStatus) => {
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
          onConfigured(execution.agent, {
            action: args.action,
            responsibility: args.responsibility,
            route: roles[args.responsibility],
            ...(validationStatus === "verified" ? { validationStatus } : {}),
            ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
          });
          return resultFor(
            configPath,
            args.action,
            effectiveRoutingSnapshot(configPath, configuredRoles),
            args.responsibility,
            recoveredInvalidStore,
            undefined,
            outputPolicyFor(),
          );
        } finally {
          releaseLock();
        }
      };
      if (args.action === "set") {
        return requireModelRoute(
          resolveCallConfig,
          proposedRoute,
          execution.signal,
          `${args.responsibility} responsibility route`,
        ).then((validation) => commit(validation.status));
      }
      return Promise.resolve(commit());
    },
  };
}
