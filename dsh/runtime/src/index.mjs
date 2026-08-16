import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideRoute,
  extractRoutingText,
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
  isSubagent,
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
import {
  DEFAULT_OUTPUT_POLICY,
  createOutputConfigTool,
  effectiveOutputPolicy,
  renderOutputPolicyPrompt,
  resolveOutputConfigPath,
} from "./output-config.mjs";
import { selectSharedOutputPolicyForTurn } from "./output-policy-state.mjs";
import {
  COMPACTION_CONFIG_PROMPT,
  applyCompactionStateProtocol,
  applyCompactionTarget,
  createCompactionConfigTool,
  effectiveCompactionTarget,
  resolveCompactionConfigPath,
} from "./compaction-config.mjs";
import { createSessionEvidence, resolveSessionEvidenceRoot } from "./session-evidence.mjs";
import {
  SKILL_SOURCE_CONFIG_PROMPT,
  createSkillSourceConfigTool,
  effectiveSkillSource,
  resolveSkillSourceConfigPath,
} from "./skill-source-config.mjs";
import {
  ODAI_RUNTIME_CONTRACT,
  SKILL_SOURCE_MODES,
  loadSkillBundle,
} from "./skill-bundle.mjs";
import { resolveSkillSelection } from "./skill-selector.mjs";
import {
  currentAgentTurn,
  selectSharedSkillForTurn,
  sharedSkillSelection,
} from "./skill-selection-state.mjs";

export const name = "odai-dsh-runtime";
export const inject = ["systemPrompt", "tools", "subagents", "sessions"];

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTING_MODES = new Set(["off", "observe", "auto", "execute"]);
const COMPACTION_CACHE_RETENTIONS = new Set(["provider-default", "short", "long", "none"]);
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
  const output = assertPlainObject(raw.output, "config.output");
  const compaction = assertPlainObject(raw.compaction, "config.compaction");
  const mode = routing.mode ?? DEFAULT_ROUTING_MODE;
  const provider = routing.provider ?? "spawn";
  const maxInputChars = routing.maxInputChars ?? 12_000;
  const configPath = resolveRoutingConfigPath(routing.configPath);
  const additionalDeniedTools = governance.additionalDeniedTools ?? [];
  const skillSource = governance.skillSource ?? "bundled";
  const skillConfigPath = resolveSkillSourceConfigPath(governance.skillConfigPath);
  const outputConfigPath = resolveOutputConfigPath(output.configPath);
  const compactionConfigPath = resolveCompactionConfigPath(compaction.configPath);
  const compactionCacheRetention = compaction.cacheRetention
    ?? process.env.ODAI_COMPACTION_CACHE_RETENTION
    ?? "provider-default";
  const unknownRoles = Object.keys(roles).filter((role) => !ROUTED_ROLES.includes(role));
  const unknownOutputFields = Object.keys(output).filter((field) => field !== "configPath");
  const unknownCompactionFields = Object.keys(compaction).filter((field) => !["cacheRetention", "configPath"].includes(field));

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
  if (unknownOutputFields.length > 0) {
    throw new TypeError(`config.output has unknown fields: ${unknownOutputFields.join(", ")}`);
  }
  if (unknownCompactionFields.length > 0) {
    throw new TypeError(`config.compaction has unknown fields: ${unknownCompactionFields.join(", ")}`);
  }
  if (!COMPACTION_CACHE_RETENTIONS.has(compactionCacheRetention)) {
    throw new TypeError("config.compaction.cacheRetention must be provider-default, short, long, or none");
  }
  if (!Array.isArray(additionalDeniedTools)
    || additionalDeniedTools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
    throw new TypeError("config.governance.additionalDeniedTools must be an array of non-empty strings");
  }
  if (!SKILL_SOURCE_MODES.includes(skillSource)) {
    throw new TypeError("config.governance.skillSource must be bundled, auto, or user");
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
      skillSource,
      skillConfigPath,
    }),
    output: Object.freeze({ configPath: outputConfigPath }),
    compaction: Object.freeze({
      cacheRetention: compactionCacheRetention,
      configPath: compactionConfigPath,
    }),
  });
}

/** Mutate exact-route compaction options; returns true only when an option changed. */
export function inheritCompactionReasoning(options, sessions, cacheRetention = "provider-default") {
  if (options?.purpose !== "compaction"
    || options.sessionId === undefined
    || !Object.isExtensible(options)) {
    return false;
  }

  const route = sessions?.get?.(options.sessionId)?.requestHeader?.()?.config;
  if (route?.provider !== options.provider
    || route?.model !== options.model
    || typeof route.reasoningEffort !== "string"
    || route.reasoningEffort.length === 0) {
    return false;
  }

  let changed = false;
  if (options.reasoningEffort === undefined) {
    options.reasoningEffort = route.reasoningEffort;
    changed = true;
  }
  if (options.cacheRetention === undefined && cacheRetention !== "provider-default") {
    options.cacheRetention = cacheRetention;
    changed = true;
  }
  return changed;
}

export function resolveSkillPath(configuredPath, env = process.env) {
  const explicit = configuredPath ?? env.ODAI_SKILL_PATH;
  if (explicit !== undefined) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new Error(`explicit Odai canonical skill not found: ${path}`);
    return path;
  }

  const candidates = [
    resolve(PLUGIN_DIR, "skills/odai/SKILL.md"),
    resolve(PLUGIN_DIR, "../../skills/odai/SKILL.md"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(`Odai bundled canonical skill not found; checked: ${candidates.join(", ")}`);
}

export function loadRoleContracts(skillPath) {
  return loadSkillBundle(skillPath).roleContracts;
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

function canonicalPrompt(selection) {
  const { bundle } = selection;
  const fallback = selection.status === "fallback"
    ? `Selection fallback: ${selection.reasonCode}${selection.detail ? ` (${selection.detail})` : ""}.`
    : undefined;
  return [
    "## odai canonical governance",
    `Canonical source: ${bundle.source} (${bundle.provider})`,
    `Canonical skill: ${bundle.manifest.skillVersion}; runtime contract: ${bundle.manifest.runtimeContract}; digest: ${bundle.digest}.`,
    ...(fallback ? [fallback] : []),
    "Apply this governance to every request. Keep the controller as the final delivery owner; use another role only for a real independent gap with observable net benefit.",
    "Odai governance is already loaded by this runtime; do not call the skill tool or read SKILL.md to load odai again.",
    "",
    bundle.skillText,
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
  const evidence = createSessionEvidence({
    root: resolveSessionEvidenceRoot(config.routing.configPath),
    logger,
  });
  const appendEvent = (agent, type, data) => {
    try {
      evidence.append(agent, type, data);
    } catch (error) {
      logger.warn(`failed to record ${type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const hasSessionEvent = (agent, type, predicate) => evidence.has(agent, type, predicate);
  const selectCompactionTarget = () => {
    try {
      return effectiveCompactionTarget(config.compaction.configPath);
    } catch (error) {
      logger.warn(`Odai compaction model configuration is invalid; inheriting the conversation route: ${error instanceof Error ? error.message : String(error)}`);
      return Object.freeze({ source: "inherit", status: "fallback", reasonCode: "compaction-config-invalid" });
    }
  };
  ctx.on("llm/stream", (options, next) => {
    if (options?.purpose === "compaction") {
      const selection = selectCompactionTarget();
      applyCompactionTarget(options, selection.target, ctx.sessions);
      applyCompactionStateProtocol(options, selection.target);
      inheritCompactionReasoning(options, ctx.sessions, config.compaction.cacheRetention);
    }
    return next();
  });
  const skillPath = resolveSkillPath(config.skillPath);
  const explicitSkillPath = config.skillPath !== undefined
    || (typeof process.env.ODAI_SKILL_PATH === "string" && process.env.ODAI_SKILL_PATH.trim() !== "");
  const bundled = loadSkillBundle(skillPath, {
    source: explicitSkillPath ? "path" : "bundled",
    provider: explicitSkillPath ? "odai-explicit-path" : "odai-dsh-runtime",
  });
  if (bundled.manifest.runtimeContract !== ODAI_RUNTIME_CONTRACT) {
    throw new Error(`Odai canonical runtimeContract ${bundled.manifest.runtimeContract} is incompatible with this runtime`);
  }
  const baseSelection = Object.freeze({
    mode: explicitSkillPath ? "path" : "bundled",
    status: "selected",
    reasonCode: explicitSkillPath ? "explicit-path" : "bundled-configured",
    bundle: bundled,
    rejections: Object.freeze([]),
  });

  ctx.systemPrompt.section({
    name: "odai:canonical-governance",
    order: -20,
    text: canonicalPrompt(baseSelection),
  });
  ctx.systemPrompt.section({
    name: "odai:routing-configuration",
    order: -19,
    text: ROUTING_CONFIG_PROMPT,
  });
  ctx.systemPrompt.section({
    name: "odai:skill-source-configuration",
    order: -18,
    text: SKILL_SOURCE_CONFIG_PROMPT,
  });
  ctx.systemPrompt.section({
    name: "odai:controller-output-policy",
    order: -17,
    text: "",
  });
  ctx.systemPrompt.section({
    name: "odai:compaction-model-configuration",
    order: -16,
    text: COMPACTION_CONFIG_PROMPT,
  });

  const optionalSkillRegistry = () => {
    try {
      if (ctx.skills && typeof ctx.skills.get === "function") return ctx.skills;
    } catch {}
    try {
      const service = typeof ctx.get === "function" ? ctx.get("skills") : undefined;
      return service && typeof service.get === "function" ? service : undefined;
    } catch {
      return undefined;
    }
  };
  const selectForAgent = async (agent, context) => {
    if (explicitSkillPath) return baseSelection;
    let mode;
    try {
      mode = effectiveSkillSource(config.governance.skillConfigPath, config.governance.skillSource);
    } catch (error) {
      return Object.freeze({
        ...baseSelection,
        mode: "bundled",
        status: "fallback",
        reasonCode: "source-config-invalid",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return resolveSkillSelection({
      mode,
      bundled,
      cwd: agent.session?.header?.cwd,
      scope: context.scope,
      signal: context.signal,
      skills: optionalSkillRegistry(),
    });
  };
  const selectOutputForAgent = () => {
    try {
      return effectiveOutputPolicy(config.output.configPath);
    } catch (error) {
      logger.warn(`Odai output configuration is invalid; using the default policy: ${error instanceof Error ? error.message : String(error)}`);
      return Object.freeze({
        policy: DEFAULT_OUTPUT_POLICY,
        source: "default",
        status: "fallback",
        reasonCode: "output-config-invalid",
      });
    }
  };
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const downstream = await next();
    const agent = context.agent;
    if (!agent) return downstream;
    const selection = await selectSharedSkillForTurn(agent, () => selectForAgent(agent, context));
    const turn = currentAgentTurn(agent);
    const outputSelection = isSubagentSession(agent)
      ? Object.freeze({ policy: DEFAULT_OUTPUT_POLICY, source: "default" })
      : await selectSharedOutputPolicyForTurn(agent, turn, selectOutputForAgent);
    const selectionEvidence = {
      ...(turn === undefined ? {} : { turn }),
      requestedMode: selection.mode,
      status: selection.status,
      reasonCode: selection.reasonCode,
      effectiveSource: selection.bundle.source,
      skillVersion: selection.bundle.manifest.skillVersion,
      runtimeContract: selection.bundle.manifest.runtimeContract,
      digest: selection.bundle.digest,
      rejections: selection.rejections.map(({ source, reasonCode }) => ({ source, reasonCode })),
    };
    if (!hasSessionEvent(agent, "odai/skill-selected", (data) => data?.turn === turn && data?.digest === selection.bundle.digest)) {
      appendEvent(agent, "odai/skill-selected", selectionEvidence);
    }
    if (selection.status === "fallback") {
      logger.warn(`Odai skill source ${selection.mode} fell back to bundled governance (${selection.reasonCode})`);
    }
    const outputPrompt = renderOutputPolicyPrompt(outputSelection.policy);
    if (outputPrompt && !hasSessionEvent(agent, "odai/output-policy-selected", (data) => data?.turn === turn)) {
      appendEvent(agent, "odai/output-policy-selected", {
        ...(turn === undefined ? {} : { turn }),
        source: outputSelection.source,
        policy: outputSelection.policy,
      });
    }
    return {
      ...downstream,
      sections: downstream.sections.map((section) => {
        if (section.name === "odai:canonical-governance") return { ...section, text: canonicalPrompt(selection) };
        if (section.name === "odai:controller-output-policy") return { ...section, text: outputPrompt };
        return section;
      }),
    };
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
      return routeProtections.get(agent) ?? activeRouteProtection(agent, evidence.events(agent));
    },
  });
  ctx.tools.register(createRoutingConfigTool(config.routing.configPath, {
    onConfigured(agent, data) {
      appendEvent(agent, "odai/routing-configured", data);
    },
  }));
  ctx.tools.register(createSkillSourceConfigTool(
    config.governance.skillConfigPath,
    config.governance.skillSource,
    {
      explicitPath: explicitSkillPath,
      onConfigured(agent, data) {
        appendEvent(agent, "odai/skill-source-configured", data);
      },
    },
  ));
  ctx.tools.register(createOutputConfigTool(config.output.configPath, {
    isChild: isSubagent,
    onConfigured(agent, data) {
      appendEvent(agent, "odai/output-configured", data);
    },
  }));
  ctx.tools.register(createCompactionConfigTool(config.compaction.configPath, {
    isChild: isSubagent,
    onConfigured(agent, data) {
      appendEvent(agent, "odai/compaction-configured", data);
    },
  }));
  ctx.tools.guard((execution) => childGuard(execution) ?? routeProtectionGuard(execution));

  ctx.on("tools/result", (execution, result) => {
    if (!execution.agent) return;
    const summary = summarizeToolResult(execution, result);
    if (hasSessionEvent(execution.agent, "odai/tool-observed", (data) => data?.callId === summary.callId)) return;
    appendEvent(execution.agent, "odai/tool-observed", summary, logger);
  });

  ctx.on("agent/request", async ({ agent, turn, step }, next) => {
    const proposed = await next();
    const childRole = routedRoleOf(agent);
    const childRoleState = childRole ? configuredRole(childRole) : undefined;
    const upgrade = controllerUpgrades.get(agent);
    const roleRoute = childRole
      ? childRoleState.route
      : upgrade && upgrade.turn === turn
        ? upgrade.route
        : undefined;
    let request = proposed;
    if (roleRoute) {
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = proposed;
      request = Object.freeze({
        ...withoutInheritedEffort,
        provider: roleRoute.provider,
        model: roleRoute.model,
        ...(roleRoute.reasoningEffort === undefined ? {} : { reasoningEffort: roleRoute.reasoningEffort }),
        ...(childRole && roleRoute.maxTokens !== undefined ? { maxTokens: roleRoute.maxTokens } : {}),
      });
    }
    if (childRole || isSubagentSession(agent)) return request;

    const outputSelection = await selectSharedOutputPolicyForTurn(agent, turn, selectOutputForAgent);
    const configuredMaxTokens = outputSelection.policy.maxTokens;
    if (configuredMaxTokens === undefined) return request;
    const priorMaxTokens = request.maxTokens;
    const effectiveMaxTokens = priorMaxTokens === undefined
      ? configuredMaxTokens
      : Math.min(priorMaxTokens, configuredMaxTokens);
    if (!hasSessionEvent(agent, "odai/output-budget-applied", (data) => data?.turn === turn && data?.step === step)) {
      appendEvent(agent, "odai/output-budget-applied", {
        turn,
        ...(step === undefined ? {} : { step }),
        configuredMaxTokens,
        ...(priorMaxTokens === undefined ? {} : { priorMaxTokens }),
        effectiveMaxTokens,
        semantics: "provider-request-ceiling",
      });
    }
    return Object.freeze({ ...request, maxTokens: effectiveMaxTokens });
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

      const taskText = extractRoutingText(downstream.messages, agent?.session?.events).slice(0, config.routing.maxInputChars);
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
            roleContract: (sharedSkillSelection(agent, turn)?.bundle ?? bundled).roleContracts[routeRole],
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

  logger.info(`loaded canonical governance ${bundled.manifest.skillVersion} from ${skillPath}; skillSource=${explicitSkillPath ? "path" : config.governance.skillSource}; routing=${config.routing.mode}`);
}

function isSubagentSession(agent) {
  const header = agent?.session?.header;
  return header?.origin === "subagent"
    || (Number.isSafeInteger(header?.delegationDepth) && header.delegationDepth > 0);
}
