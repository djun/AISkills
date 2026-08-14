import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideRoute,
  extractLatestUserText,
  renderDelegationPrompt,
  renderMissingRouteConfigNotice,
  renderRouteFailureNotice,
  renderRouteNotice,
  requiresFailClosedProtection,
} from "./router.mjs";
import {
  activeRouteProtection,
  createChildToolGuard,
  createRouteProtectionGuard,
  summarizeToolResult,
} from "./governance.mjs";
import {
  CONFIGURABLE_ROLES,
  ROUTING_CONFIG_PROMPT,
  createRoutingConfigTool,
  effectiveRoleRoute,
  resolveRoleRoute,
  resolveRoutingConfigPath,
} from "./routing-config.mjs";

export const name = "odai-dsh-runtime";
export const inject = ["systemPrompt", "tools", "subagents"];

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTING_MODES = new Set(["off", "observe", "auto", "execute"]);
const ROUTED_ROLES = CONFIGURABLE_ROLES;
const DEFAULT_ROUTING_MODE = "auto";

function assertPlainObject(value, field) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

export function resolveConfig(rawConfig = {}) {
  const raw = assertPlainObject(rawConfig, "config");
  const routing = assertPlainObject(raw.routing, "config.routing");
  const roles = assertPlainObject(routing.roles, "config.routing.roles");
  const governance = assertPlainObject(raw.governance, "config.governance");
  const mode = routing.mode ?? DEFAULT_ROUTING_MODE;
  const provider = routing.provider ?? "spawn";
  const maxInputChars = routing.maxInputChars ?? 12_000;
  const configPath = resolveRoutingConfigPath(routing.configPath);
  const additionalDeniedTools = governance.additionalDeniedTools ?? [];
  const unknownRoles = Object.keys(roles).filter((role) => !ROUTED_ROLES.includes(role));

  if (!ROUTING_MODES.has(mode)) {
    throw new TypeError("config.routing.mode must be off, observe, auto, or execute");
  }
  if (typeof provider !== "string" || provider.trim() === "") {
    throw new TypeError("config.routing.provider must be a non-empty string");
  }
  if (!Number.isSafeInteger(maxInputChars) || maxInputChars < 256) {
    throw new TypeError("config.routing.maxInputChars must be an integer of at least 256");
  }
  if (unknownRoles.length > 0) {
    throw new TypeError(`config.routing.roles has unknown roles: ${unknownRoles.join(", ")}`);
  }
  if (!Array.isArray(additionalDeniedTools)
    || additionalDeniedTools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
    throw new TypeError("config.governance.additionalDeniedTools must be an array of non-empty strings");
  }
  if (raw.skillPath !== undefined && (typeof raw.skillPath !== "string" || raw.skillPath.trim() === "")) {
    throw new TypeError("config.skillPath must be a non-empty string");
  }

  return Object.freeze({
    skillPath: raw.skillPath,
    routing: Object.freeze({
      mode,
      provider: provider.trim(),
      maxInputChars,
      configPath,
      roles: Object.freeze(Object.fromEntries(ROUTED_ROLES.map((role) => [
        role,
        resolveRoleRoute(roles[role], role),
      ]))),
    }),
    governance: Object.freeze({
      additionalDeniedTools: Object.freeze(additionalDeniedTools.map((tool) => tool.trim())),
    }),
  });
}

export function resolveSkillPath(configuredPath) {
  const candidates = [
    configuredPath,
    process.env.ODAI_SKILL_PATH,
    resolve(PLUGIN_DIR, "skills/odai/SKILL.md"),
    resolve(PLUGIN_DIR, "../../skills/odai/SKILL.md"),
  ].filter(Boolean).map((candidate) => resolve(candidate));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  throw new Error(`odai canonical skill not found; checked: ${candidates.join(", ")}`);
}

export function loadRoleContracts(skillPath) {
  const roleRoot = resolve(dirname(skillPath), "assets/routing-roles");
  return Object.freeze(Object.fromEntries(ROUTED_ROLES.map((role) => {
    const path = resolve(roleRoot, `${role}.md`);
    const text = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    if (!text) throw new Error(`odai canonical ${role} role is unavailable: ${path}`);
    return [role, text];
  })));
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function pluginMessage(text, summary, extraBlocks = []) {
  return deepFreeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }, ...extraBlocks],
    source: {
      kind: "plugin",
      plugin: name,
      form: "notice",
      summary: summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`,
    },
  });
}

function loggerFor(ctx) {
  if (typeof ctx.logger !== "function") return { info() {}, warn() {} };
  return ctx.logger(name);
}

function appendEvent(agent, type, data, logger) {
  try {
    agent?.session?.append(type, data);
  } catch (error) {
    logger.warn(`failed to append ${type}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hasSessionEvent(agent, type, predicate) {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return false;
  return events.some((event) => event?.type === type && predicate(event.data));
}

function outputText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function roleAgentOptions(roleRoute) {
  if (!roleRoute) return undefined;
  return {
    provider: roleRoute.provider,
    model: roleRoute.model,
    ...(roleRoute.maxTokens === undefined ? {} : { maxTokens: roleRoute.maxTokens }),
  };
}

function latestRequestRoute(localAgent) {
  const events = localAgent?.session?.events;
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "request/header") continue;
    const config = event.data?.header?.config;
    if (typeof config?.provider !== "string" || typeof config?.model !== "string") return undefined;
    return Object.freeze({
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    });
  }
  return undefined;
}

function routeMismatch(expected, actual) {
  if (!expected) return undefined;
  if (!actual) return "child request/header did not expose an actual model route";
  for (const field of ["provider", "model", "reasoningEffort"]) {
    if (expected[field] !== undefined && expected[field] !== actual[field]) {
      return `child ${field} mismatch: expected ${expected[field]}, got ${actual[field] ?? "<absent>"}`;
    }
  }
  return undefined;
}

export async function runRoutedRole({ subagents, provider, decision, taskText, roleContract, agent, signal, roleRoute }) {
  let run;
  let outcome;
  try {
    run = await subagents.start(provider, {
      label: `odai-${decision.role}`,
      prompt: [{ type: "text", text: renderDelegationPrompt(decision, taskText, roleContract) }],
      parent: agent,
      signal,
      maxDepth: 1,
      ...(roleRoute ? { agentOptions: roleAgentOptions(roleRoute) } : {}),
    });
    const result = await run.result;
    const actualRoute = latestRequestRoute(run.localAgent);
    const mismatch = routeMismatch(roleRoute, actualRoute);
    if (result.stopReason !== "completed") {
      outcome = Object.freeze({
        status: "fallback",
        stopReason: result.stopReason,
        output: result.output ?? [],
        ...(actualRoute ? { actualRoute } : {}),
      });
    } else if (mismatch) {
      outcome = Object.freeze({
        status: "fallback",
        stopReason: "route-unverified",
        output: [],
        error: mismatch,
        ...(actualRoute ? { actualRoute } : {}),
      });
    } else if (!outputText(result.output)) {
      outcome = Object.freeze({
        status: "fallback",
        stopReason: "route-empty-output",
        output: [],
        error: "child completed without textual evidence",
        ...(actualRoute ? { actualRoute } : {}),
      });
    } else {
      outcome = Object.freeze({
        status: "completed",
        stopReason: result.stopReason,
        output: result.output ?? [],
        ...(actualRoute ? { actualRoute } : {}),
      });
    }
  } catch (error) {
    outcome = Object.freeze({
      status: "fallback",
      stopReason: "infrastructure-error",
      output: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (run) {
    try {
      await run.dispose();
    } catch (error) {
      const disposeError = error instanceof Error ? error.message : String(error);
      return Object.freeze({
        status: "fallback",
        stopReason: "infrastructure-error",
        output: [],
        error: outcome?.error
          ? `${outcome.error}; provider cleanup failed: ${disposeError}`
          : `provider cleanup failed: ${disposeError}`,
      });
    }
  }

  return outcome;
}

function canonicalPrompt(skillPath, skillText) {
  return [
    "## odai canonical governance",
    `Canonical source: ${skillPath}`,
    "Apply this governance to every request. Keep the controller as the final delivery owner; use another role only for a real independent gap with observable net benefit.",
    "",
    skillText,
  ].join("\n");
}

function routedRoleOf(agent) {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "subagent/descriptor") continue;
    const label = event.data?.label;
    if (typeof label !== "string" || !label.startsWith("odai-")) return undefined;
    const role = label.slice("odai-".length);
    return ROUTED_ROLES.includes(role) ? role : undefined;
  }
  return undefined;
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const logger = loggerFor(ctx);
  const skillPath = resolveSkillPath(config.skillPath);
  const skillText = readFileSync(skillPath, "utf8").trim();
  if (!skillText) throw new Error(`odai canonical skill is empty: ${skillPath}`);
  const roleContracts = loadRoleContracts(skillPath);

  ctx.systemPrompt.section({
    name: "odai:canonical-governance",
    order: -20,
    text: canonicalPrompt(skillPath, skillText),
  });
  ctx.systemPrompt.section({
    name: "odai:routing-configuration",
    order: -19,
    text: ROUTING_CONFIG_PROMPT,
  });

  const routeProtections = new WeakMap();
  const controllerUpgrades = new WeakMap();
  const configuredRole = (role) => {
    try {
      return { route: effectiveRoleRoute(config.routing.configPath, config.routing.roles, role) };
    } catch (error) {
      return {
        error: "persisted Odai routing configuration failed validation",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const onDenied = (execution, reason) => {
    appendEvent(execution.agent, "odai/governance-denied", {
      callId: String(execution.callId),
      tool: execution.name,
      reason,
    }, logger);
  };
  const childGuard = createChildToolGuard({
    additionalDeniedTools: config.governance.additionalDeniedTools,
    onDenied,
  });
  const routeProtectionGuard = createRouteProtectionGuard({
    additionalDeniedTools: config.governance.additionalDeniedTools,
    onDenied,
    protectionFor(agent) {
      if (config.routing.mode === "off") return undefined;
      return routeProtections.get(agent) ?? activeRouteProtection(agent);
    },
  });
  ctx.tools.register(createRoutingConfigTool(config.routing.configPath));
  ctx.tools.guard((execution) => childGuard(execution) ?? routeProtectionGuard(execution));

  ctx.on("tools/result", (execution, result) => {
    if (!execution.agent) return;
    const summary = summarizeToolResult(execution, result);
    if (hasSessionEvent(execution.agent, "odai/tool-observed", (data) => data?.callId === summary.callId)) return;
    appendEvent(execution.agent, "odai/tool-observed", summary, logger);
  });

  ctx.on("agent/request", async ({ agent, turn }, next) => {
    const proposed = await next();
    const childRole = routedRoleOf(agent);
    const childRoleState = childRole ? configuredRole(childRole) : undefined;
    const upgrade = controllerUpgrades.get(agent);
    const roleRoute = childRole
      ? childRoleState.route
      : upgrade && upgrade.turn === turn
        ? upgrade.route
        : undefined;
    if (!roleRoute) return proposed;

    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = proposed;
    return Object.freeze({
      ...withoutInheritedEffort,
      provider: roleRoute.provider,
      model: roleRoute.model,
      ...(roleRoute.reasoningEffort === undefined ? {} : { reasoningEffort: roleRoute.reasoningEffort }),
      ...(childRole && roleRoute.maxTokens !== undefined ? { maxTokens: roleRoute.maxTokens } : {}),
    });
  }, { prepend: true });

  const protectController = (agent, turn, step, decision, source, failure) => {
    const protection = Object.freeze({
      turn,
      step,
      mode: "read-only",
      reasonCode: decision.reasonCode,
      source,
      ...(failure ? { failure } : {}),
    });
    routeProtections.set(agent, protection);
    appendEvent(agent, "odai/route-protection", protection, logger);
  };

  if (config.routing.mode !== "off") {
    const routedSteps = new WeakMap();
    ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
      const subagentSession = isSubagentSession(agent);
      if (step === 1 && !subagentSession) {
        routeProtections.delete(agent);
        controllerUpgrades.delete(agent);
      }
      const downstream = await next();
      if (downstream.kind === "reject" || signal.aborted || step !== 1 || subagentSession) {
        return downstream;
      }
      if (hasSessionEvent(agent, "odai/route-decided", (data) => data?.turn === turn && data?.step === step)) {
        return downstream;
      }

      let routed = routedSteps.get(agent);
      if (!routed) {
        routed = new Set();
        routedSteps.set(agent, routed);
      }
      const routeKey = `${turn}:${step}`;
      if (routed.has(routeKey)) return downstream;
      routed.add(routeKey);

      const taskText = extractLatestUserText(downstream.messages).slice(0, config.routing.maxInputChars);
      const decision = decideRoute({ text: taskText });
      const routeRole = decision.targetRole ?? decision.role;
      appendEvent(agent, "odai/route-decided", {
        turn,
        step,
        role: decision.role,
        action: decision.action,
        ...(decision.targetRole ? { targetRole: decision.targetRole } : {}),
        mode: config.routing.mode,
        reasonCode: decision.reasonCode,
        signals: decision.signals,
      }, logger);

      if (decision.action === "direct") return downstream;

      if (config.routing.mode === "observe") {
        if (requiresFailClosedProtection(decision)) {
          protectController(agent, turn, step, decision, "observe");
        }
        return {
          kind: "enter",
          messages: [
            ...downstream.messages,
            pluginMessage(
              renderRouteNotice(decision, "observe"),
              `odai observed ${routeRole} gap (${decision.reasonCode})`,
            ),
          ],
        };
      }

      const roleState = configuredRole(routeRole);
      const roleRoute = roleState.route;
      if (!roleRoute) {
        const invalidConfig = Boolean(roleState.error);
        appendEvent(agent, "odai/route-config-missing", {
          turn,
          step,
          role: routeRole,
          action: decision.action,
          mode: config.routing.mode,
          status: invalidConfig ? "invalid" : "unconfigured",
          ...(invalidConfig ? { error: roleState.detail } : {}),
        }, logger);
        if (requiresFailClosedProtection(decision)) {
          protectController(
            agent,
            turn,
            step,
            decision,
            invalidConfig ? "route-config-invalid" : "route-config-missing",
          );
        }
        return {
          kind: "enter",
          messages: [
            ...downstream.messages,
            pluginMessage(
              renderMissingRouteConfigNotice(decision, config.routing.mode, roleState.error),
              `odai ${routeRole} route is ${invalidConfig ? "invalid" : "not configured"}`,
            ),
          ],
        };
      }

      if (config.routing.mode === "auto" && decision.action === "upgrade") {
        controllerUpgrades.set(agent, Object.freeze({ turn, route: roleRoute }));
        appendEvent(agent, "odai/route-upgrade", {
          turn,
          step,
          role: decision.role,
          targetRole: routeRole,
          status: "requested",
          requestedRoute: roleRoute,
        }, logger);
        return {
          kind: "enter",
          messages: [
            ...downstream.messages,
            pluginMessage(
              renderRouteNotice(decision, "auto", roleRoute),
              `odai upgraded controller route (${decision.reasonCode})`,
            ),
          ],
        };
      }

      const delegationDecision = decision.role === routeRole
        ? decision
        : Object.freeze({ ...decision, role: routeRole, mode: "delegate", action: "delegate" });
      const result = ctx.subagents?.start
        ? await runRoutedRole({
            subagents: ctx.subagents,
            provider: config.routing.provider,
            decision: delegationDecision,
            taskText,
            roleContract: roleContracts[routeRole],
            agent,
            signal,
            roleRoute,
          })
        : Object.freeze({
            status: "fallback",
            stopReason: "infrastructure-error",
            output: [],
            error: "dsh subagents service unavailable",
          });
      appendEvent(agent, "odai/route-result", {
        turn,
        step,
        role: routeRole,
        action: "delegate",
        status: result.status,
        stopReason: result.stopReason,
        ...(result.actualRoute ? { actualRoute: result.actualRoute } : {}),
        ...(result.error ? { error: result.error } : {}),
      }, logger);

      if (result.status === "completed") {
        const childText = outputText(result.output);
        const heading = renderRouteNotice(delegationDecision, config.routing.mode, result.actualRoute);
        return {
          kind: "enter",
          messages: [
            ...downstream.messages,
            pluginMessage(
              childText ? `${heading}\n\n${routeRole} output:\n${childText}` : heading,
              `odai completed ${routeRole} route`,
              result.output.filter((block) => block?.type !== "text"),
            ),
          ],
        };
      }

      const failure = result.error ?? result.stopReason;
      if (requiresFailClosedProtection(delegationDecision)) {
        protectController(agent, turn, step, delegationDecision, "route-failure", failure);
      }
      return {
        kind: "enter",
        messages: [
          ...downstream.messages,
          pluginMessage(
            renderRouteFailureNotice(delegationDecision, failure),
            requiresFailClosedProtection(delegationDecision)
              ? `odai blocked high-impact ${routeRole} fallback`
              : `odai fell back from ${routeRole} route`,
          ),
        ],
      };
    }, { prepend: true });
  }

  logger.info(`loaded canonical governance from ${skillPath}; routing=${config.routing.mode}`);
}

function isSubagentSession(agent) {
  const header = agent?.session?.header;
  return header?.origin === "subagent"
    || (Number.isSafeInteger(header?.delegationDepth) && header.delegationDepth > 0);
}
