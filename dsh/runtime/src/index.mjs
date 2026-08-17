import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideResearchPrefetch,
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
  effectiveRoutingSnapshot,
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
import { ROUTE_CARD_PROMPT, activeRouteCard, createRouteCardTool } from "./route-card.mjs";
import { buildRoleContextPacket, renderRoleContextPacket } from "./routing-context.mjs";
import {
  parseResearchPacket,
  renderResearchPacket,
  verifyResearchPacketSources,
} from "./research-packet.mjs";
import { dshRoleContract } from "./role-overlays.mjs";
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
import {
  applySkillEvolutionSelection,
  createSkillEvolutionTool,
  resolveSkillEvolutionRoot,
  skillEvolutionDisabled,
} from "./skill-evolution.mjs";
import {
  MEMORY_PROMPT,
  captureAutomaticMemories,
  claimSemanticMemoryTurn,
  createSemanticMemoryTool,
  latestDirectUserMessage,
  memoryPacketMessage,
  renderSemanticMemoryPacket,
  retrieveSemanticMemories,
} from "./semantic-memory.mjs";
import {
  MEMORY_MODES,
  effectiveMemorySettings,
  resolveMemoryStorePath,
} from "./semantic-memory-store.mjs";

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
  const memory = assertPlainObject(raw.memory, "config.memory");
  const mode = routing.mode ?? DEFAULT_ROUTING_MODE;
  const provider = routing.provider ?? "spawn";
  const maxInputChars = routing.maxInputChars ?? 12_000;
  const configPath = resolveRoutingConfigPath(routing.configPath);
  const additionalDeniedTools = governance.additionalDeniedTools ?? [];
  const skillSource = governance.skillSource ?? "bundled";
  const skillConfigPath = resolveSkillSourceConfigPath(governance.skillConfigPath);
  const evolutionRoot = resolveSkillEvolutionRoot(governance.evolutionRoot);
  const outputConfigPath = resolveOutputConfigPath(output.configPath);
  const compactionConfigPath = resolveCompactionConfigPath(compaction.configPath);
  const memoryStorePath = resolveMemoryStorePath(memory.storePath);
  const memoryMode = memory.mode ?? "auto";
  const memoryMaxRetrieved = memory.maxRetrieved ?? 6;
  const compactionCacheRetention = compaction.cacheRetention
    ?? process.env.ODAI_COMPACTION_CACHE_RETENTION
    ?? "provider-default";
  const unknownRoles = Object.keys(roles).filter((role) => !ROUTED_ROLES.includes(role));
  const unknownOutputFields = Object.keys(output).filter((field) => field !== "configPath");
  const unknownCompactionFields = Object.keys(compaction).filter((field) => !["cacheRetention", "configPath"].includes(field));
  const unknownMemoryFields = Object.keys(memory).filter((field) => !["mode", "storePath", "maxRetrieved"].includes(field));

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
  if (unknownMemoryFields.length > 0) {
    throw new TypeError(`config.memory has unknown fields: ${unknownMemoryFields.join(", ")}`);
  }
  if (!MEMORY_MODES.includes(memoryMode)) {
    throw new TypeError("config.memory.mode must be auto or off");
  }
  if (!Number.isSafeInteger(memoryMaxRetrieved) || memoryMaxRetrieved < 1 || memoryMaxRetrieved > 12) {
    throw new TypeError("config.memory.maxRetrieved must be an integer from 1 to 12");
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
      evolutionRoot,
    }),
    output: Object.freeze({ configPath: outputConfigPath }),
    compaction: Object.freeze({
      cacheRetention: compactionCacheRetention,
      configPath: compactionConfigPath,
    }),
    memory: Object.freeze({
      mode: memoryMode,
      storePath: memoryStorePath,
      maxRetrieved: memoryMaxRetrieved,
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

function renderResearchTaskContract(taskText) {
  return [
    "Decision-blocking factual question: Determine whether the user's causal claim is supported and which existing repository facts govern the safety of the requested high-impact change.",
    "Allowed source scope: the current project root only. Use repository-relative paths and read-only source tools; do not inspect parent, sibling, user, or unrelated directories.",
    "Authority and freshness: label each current-checkout source by its actual role (for example runtime configuration, implementation, test, incident record, or documentation). Do not invent an authority hierarchy; report unresolved conflicts and missing freshness evidence as unknowns.",
    "Stop condition: return the smallest packet with 2-6 source-backed facts from at least two files, or stop with the missing evidence boundary. Do not select a route or continue after additional reading cannot change this factual question.",
    "For every fact, excerpt must exactly equal the complete cited source line after trimming leading and trailing whitespace.",
    "",
    "Original user request:",
    taskText,
  ].join("\n");
}

function roleAgentOptions(roleRoute) {
  if (!roleRoute) return undefined;
  return {
    provider: roleRoute.provider,
    model: roleRoute.model,
    ...(roleRoute.maxTokens === undefined ? {} : { maxTokens: roleRoute.maxTokens }),
  };
}

function routeFromConfig(config) {
  if (typeof config?.provider !== "string" || typeof config?.model !== "string") return undefined;
  return Object.freeze({
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
  });
}

function latestRequestRoute(localAgent) {
  const events = localAgent?.session?.events;
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "request/header") continue;
    return routeFromConfig(event.data?.header?.config);
  }
  return undefined;
}

function routeMismatchFor(expected, actual, subject) {
  if (!expected) return undefined;
  if (!actual) return `${subject} request/header did not expose an actual model route`;
  for (const field of ["provider", "model", "reasoningEffort", "maxTokens"]) {
    if (expected[field] !== undefined && expected[field] !== actual[field]) {
      return `${subject} ${field} mismatch: expected ${expected[field]}, got ${actual[field] ?? "<absent>"}`;
    }
  }
  return undefined;
}

function routeMismatch(expected, actual) {
  return routeMismatchFor(expected, actual, "child");
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
    const routeReceiptStatus = !actualRoute ? "unverified" : mismatch ? "mismatch" : "applied";
    const routeEvidence = Object.freeze({
      routeReceiptStatus,
      ...(mismatch ? { routeReceiptError: mismatch } : {}),
      ...(actualRoute ? { actualRoute } : {}),
    });
    if (result.stopReason !== "completed") {
      outcome = Object.freeze({
        status: "fallback",
        stopReason: result.stopReason,
        output: result.output ?? [],
        ...routeEvidence,
      });
    } else if (mismatch) {
      outcome = Object.freeze({
        status: "fallback",
        stopReason: "route-unverified",
        output: [],
        error: mismatch,
        ...routeEvidence,
      });
    } else if (!outputText(result.output)) {
      outcome = Object.freeze({
        status: "fallback",
        stopReason: "route-empty-output",
        output: [],
        error: "child completed without textual evidence",
        taskError: "child completed without textual evidence",
        ...routeEvidence,
      });
    } else {
      outcome = Object.freeze({
        status: "completed",
        stopReason: result.stopReason,
        output: result.output ?? [],
        ...routeEvidence,
      });
    }
  } catch (error) {
    const taskError = error instanceof Error ? error.message : String(error);
    outcome = Object.freeze({
      status: "fallback",
      stopReason: "infrastructure-error",
      output: [],
      routeReceiptStatus: "unverified",
      error: taskError,
      taskError,
    });
  }

  if (run) {
    try {
      await run.dispose();
    } catch (error) {
      const disposeError = error instanceof Error ? error.message : String(error);
      const cleanupTaskError = outcome?.taskError
        ? `${outcome.taskError}; provider cleanup failed: ${disposeError}`
        : `provider cleanup failed: ${disposeError}`;
      return Object.freeze({
        status: "fallback",
        stopReason: "infrastructure-error",
        output: [],
        routeReceiptStatus: outcome?.routeReceiptStatus ?? "unverified",
        ...(outcome?.routeReceiptError ? { routeReceiptError: outcome.routeReceiptError } : {}),
        ...(outcome?.actualRoute ? { actualRoute: outcome.actualRoute } : {}),
        error: outcome?.error
          ? `${outcome.error}; provider cleanup failed: ${disposeError}`
          : cleanupTaskError,
        taskError: cleanupTaskError,
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
  const evolution = selection.evolution?.status === "active"
    ? `User evolution: generation ${selection.evolution.generationId}; base digest ${selection.evolution.baseDigest}; current upstream digest ${selection.evolution.upstreamDigest}; rebase required: ${String(selection.evolution.rebaseRequired)}.`
    : undefined;
  return [
    "## odai canonical governance",
    `Canonical source: ${bundle.source} (${bundle.provider})`,
    `Canonical skill: ${bundle.manifest.skillVersion}; runtime contract: ${bundle.manifest.runtimeContract}; digest: ${bundle.digest}.`,
    ...(evolution ? [evolution] : []),
    ...(fallback ? [fallback] : []),
    "Apply this governance to every request. Keep the controller as the final delivery owner; use another role only for a real independent gap with observable net benefit.",
    "Odai governance is already loaded by this runtime; do not call the skill tool or read SKILL.md to load odai again.",
    "",
    bundle.skillText,
  ].join("\n");
}

function renderEffectiveRoutingContext(snapshotState) {
  if (snapshotState.error) {
    return [
      "Current effective responsibility mappings: unavailable because the saved routing configuration is invalid.",
      `Configuration error: ${snapshotState.detail}`,
      "Use odai_routing_config only when the user asks to inspect or repair it; do not infer any route.",
    ].join("\n");
  }
  const mappings = CONFIGURABLE_ROLES.flatMap((role) => {
    const route = snapshotState.snapshot.roles[role];
    if (!route) return [];
    const options = [
      ...(route.reasoningEffort ? [`reasoningEffort=${route.reasoningEffort}`] : []),
      ...(route.maxTokens ? [`maxTokens=${route.maxTokens}`] : []),
    ];
    return [`${role}=${route.provider}/${route.model}${options.length > 0 ? ` (${options.join(", ")})` : ""} [${snapshotState.snapshot.sources[role]}]`];
  });
  return [
    `Current effective responsibility mappings (runtime-owned; supersedes conversation summaries): ${mappings.join("; ") || "none"}.`,
    "These are route targets, not evidence that a responsibility ran. Only an actual route receipt proves use; a generic subagent does not.",
  ].join("\n");
}

function latestRouteReceipt(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const data = event?.data;
    if (!data?.routeSource || !Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step)) continue;
    if (event.type === "odai/route-applied") {
      return Object.freeze({
        turn: data.turn,
        step: data.step,
        responsibility: data.responsibility,
        status: data.status,
        routeMode: data.routeMode,
        routeSource: data.routeSource,
        fallbackUsed: data.fallbackUsed,
        requestedRoute: data.requestedRoute,
        ...(data.actualRoute ? { actualRoute: data.actualRoute } : {}),
        ...(data.stopReason ? { stopReason: data.stopReason } : {}),
        ...(data.error ? { error: data.error } : {}),
      });
    }
    if (["odai/route-result", "odai/research-result"].includes(event.type)) {
      const routeReceiptStatus = data.routeReceiptStatus ?? "unverified";
      return Object.freeze({
        turn: data.turn,
        step: data.step,
        responsibility: data.role,
        status: routeReceiptStatus,
        taskStatus: data.status,
        routeMode: "child",
        routeSource: data.routeSource,
        fallbackUsed: routeReceiptStatus !== "applied",
        requestedRoute: data.requestedRoute,
        ...(data.actualRoute ? { actualRoute: data.actualRoute } : {}),
        ...(data.routeReceiptError ? { error: data.routeReceiptError } : {}),
        ...(data.stopReason ? { taskStopReason: data.stopReason } : {}),
        ...(data.error ? { taskError: data.error } : {}),
      });
    }
  }
  return undefined;
}

function routedRoleOf(agent) {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "subagent/descriptor") continue;
    const label = event.data?.label;
    if (typeof label !== "string") return undefined;
    const match = /^odai-(researcher|planner|executor|reviewer|frontend)(?:$|[\s:])/u.exec(label.trim());
    return match && ROUTED_ROLES.includes(match[1]) ? match[1] : undefined;
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
  const evolutionDisabled = explicitSkillPath || skillEvolutionDisabled();

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
    name: "odai:route-card",
    order: -18.5,
    text: ROUTE_CARD_PROMPT,
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
  ctx.systemPrompt.section({
    name: "odai:semantic-memory",
    order: -15,
    text: MEMORY_PROMPT,
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
  const selectUpstreamForAgent = async (agent, context) => {
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
  const selectForAgent = async (agent, context) => {
    const upstream = await selectUpstreamForAgent(agent, context);
    return applySkillEvolutionSelection(upstream, config.governance.evolutionRoot, { disabled: evolutionDisabled });
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
  const memorySettingsSnapshots = new WeakMap();
  const memorySettingsFor = (agent, turn = currentAgentTurn(agent)) => {
    const cached = memorySettingsSnapshots.get(agent);
    if (cached && cached.turn === turn) return cached.settings;
    let settings;
    try {
      settings = effectiveMemorySettings(config.memory.storePath, { mode: config.memory.mode });
    } catch (error) {
      logger.warn(`Odai semantic memory is unavailable; capture and retrieval are disabled for this turn: ${error instanceof Error ? error.message : String(error)}`);
      settings = Object.freeze({ mode: "off", source: "invalid-store" });
    }
    memorySettingsSnapshots.set(agent, { turn, settings });
    return settings;
  };
  const routingSnapshots = new WeakMap();
  const routingSnapshotFor = (agent, turn = currentAgentTurn(agent)) => {
    const cached = routingSnapshots.get(agent);
    if (cached && cached.turn === turn) return cached.state;
    let state;
    try {
      state = Object.freeze({
        snapshot: effectiveRoutingSnapshot(config.routing.configPath, config.routing.roles),
      });
    } catch (error) {
      state = Object.freeze({
        error: "persisted Odai routing configuration failed validation",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    routingSnapshots.set(agent, { turn, state });
    return state;
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
      ...(selection.evolution?.generationId ? {
        evolution: {
          status: selection.evolution.status,
          generationId: selection.evolution.generationId,
          ...(selection.evolution.baseDigest ? { baseDigest: selection.evolution.baseDigest } : {}),
          ...(selection.evolution.upstreamDigest ? { upstreamDigest: selection.evolution.upstreamDigest } : {}),
          ...(selection.evolution.rebaseRequired === undefined ? {} : { rebaseRequired: selection.evolution.rebaseRequired }),
        },
      } : {}),
    };
    if (!hasSessionEvent(agent, "odai/skill-selected", (data) => data?.turn === turn && data?.digest === selection.bundle.digest)) {
      appendEvent(agent, "odai/skill-selected", selectionEvidence);
    }
    if (selection.status === "fallback") {
      logger.warn(`Odai skill source ${selection.mode} fell back to bundled governance (${selection.reasonCode})`);
    }
    const outputPrompt = renderOutputPolicyPrompt(outputSelection.policy);
    const routingPrompt = isSubagentSession(agent)
      ? ROUTING_CONFIG_PROMPT
      : `${ROUTING_CONFIG_PROMPT}\n\n${renderEffectiveRoutingContext(routingSnapshotFor(agent, turn))}`;
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
        if (section.name === "odai:routing-configuration") return { ...section, text: routingPrompt };
        if (section.name === "odai:controller-output-policy") return { ...section, text: outputPrompt };
        return section;
      }),
    };
  });

  const routeProtections = new WeakMap();
  const controllerUpgrades = new WeakMap();
  const pendingRouteReceipts = new WeakMap();
  const configuredRole = (agent, role, turn = currentAgentTurn(agent)) => {
    const state = routingSnapshotFor(agent, turn);
    if (state.error) return state;
    return {
      route: state.snapshot.roles[role],
      source: state.snapshot.sources[role],
    };
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
    configuredRoles: config.routing.roles,
    latestRouteFor(agent) {
      return latestRouteReceipt(evidence.events(agent));
    },
    onConfigured(agent, data) {
      appendEvent(agent, "odai/routing-configured", data);
    },
  }));
  ctx.tools.register(createRouteCardTool({
    activeFor(agent) {
      return activeRouteCard(evidence.events(agent));
    },
    onFrozen(agent, card) {
      appendEvent(agent, "odai/route-card-frozen", { card });
    },
    onCleared(agent, cardId) {
      appendEvent(agent, "odai/route-card-cleared", { cardId });
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
  ctx.tools.register(createSkillEvolutionTool(config.governance.evolutionRoot, {
    disabled: evolutionDisabled,
    currentSelectionFor(agent) {
      return sharedSkillSelection(agent)
        ?? applySkillEvolutionSelection(baseSelection, config.governance.evolutionRoot, { disabled: evolutionDisabled });
    },
    onChanged(agent, data) {
      appendEvent(agent, `odai/evolution-${data.action}`, data);
    },
  }));
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
  ctx.tools.register(createSemanticMemoryTool(config.memory.storePath, {
    configuredMode: config.memory.mode,
    onChanged(agent, data) {
      appendEvent(agent, "odai/memory-changed", data);
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
    const childRoleState = childRole ? configuredRole(agent, childRole, turn) : undefined;
    if (childRole && !childRoleState.route) {
      throw new Error(childRoleState.error
        ? `Odai ${childRole} child route is unavailable: ${childRoleState.detail}`
        : `Odai ${childRole} child route is not configured`);
    }
    const upgrade = controllerUpgrades.get(agent);
    const upgradeRole = upgrade && upgrade.turn === turn ? upgrade.role : undefined;
    const roleRoute = childRole
      ? childRoleState.route
      : upgradeRole
        ? upgrade.route
        : undefined;
    const routeSource = childRole ? childRoleState?.source : upgrade?.source;
    const routeMode = childRole ? "child" : "same-turn";
    const scopedFrontendMaxTokens = upgradeRole === "frontend" ? roleRoute?.maxTokens : undefined;
    const finalize = (finalRequest) => {
      if (roleRoute && agent?.session && Number.isSafeInteger(turn) && Number.isSafeInteger(step)) {
        const expectedRoute = routeMode === "same-turn" && upgradeRole !== "frontend"
          ? Object.freeze({
              provider: roleRoute.provider,
              model: roleRoute.model,
              ...(roleRoute.reasoningEffort === undefined ? {} : { reasoningEffort: roleRoute.reasoningEffort }),
            })
          : roleRoute;
        pendingRouteReceipts.set(agent.session, Object.freeze({
          agent,
          turn,
          step,
          responsibility: childRole ?? upgradeRole,
          routeMode,
          routeSource,
          requestedRoute: expectedRoute,
          expectedRoute,
        }));
      }
      return finalRequest;
    };
    let request = proposed;
    if (roleRoute) {
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = proposed;
      request = Object.freeze({
        ...withoutInheritedEffort,
        provider: roleRoute.provider,
        model: roleRoute.model,
        ...(roleRoute.reasoningEffort === undefined ? {} : { reasoningEffort: roleRoute.reasoningEffort }),
        ...((childRole || scopedFrontendMaxTokens !== undefined) && roleRoute.maxTokens !== undefined
          ? { maxTokens: roleRoute.maxTokens }
          : {}),
      });
    }
    if (childRole || isSubagentSession(agent)) return finalize(request);

    const outputSelection = await selectSharedOutputPolicyForTurn(agent, turn, selectOutputForAgent);
    const configuredMaxTokens = outputSelection.policy.maxTokens;
    if (scopedFrontendMaxTokens !== undefined) {
      if (!hasSessionEvent(agent, "odai/output-budget-overridden", (data) => data?.turn === turn && data?.step === step)) {
        appendEvent(agent, "odai/output-budget-overridden", {
          turn,
          ...(step === undefined ? {} : { step }),
          responsibility: "frontend",
          responsibilityMaxTokens: scopedFrontendMaxTokens,
          ...(configuredMaxTokens === undefined ? {} : { configuredControllerMaxTokens: configuredMaxTokens }),
          effectiveMaxTokens: scopedFrontendMaxTokens,
          semantics: "explicit-responsibility-override",
        });
      }
      return finalize(Object.freeze({ ...request, maxTokens: scopedFrontendMaxTokens }));
    }
    if (configuredMaxTokens === undefined) return finalize(request);
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
    return finalize(Object.freeze({ ...request, maxTokens: effectiveMaxTokens }));
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

  ctx.on("session/event", (session, event) => {
    const pending = pendingRouteReceipts.get(session);
    if (!pending) return;
    if (event?.type === "turn/end") {
      appendEvent(pending.agent, "odai/route-applied", {
        turn: pending.turn,
        step: pending.step,
        responsibility: pending.responsibility,
        status: "unverified",
        routeMode: pending.routeMode,
        routeSource: pending.routeSource,
        fallbackUsed: true,
        requestedRoute: pending.requestedRoute,
        stopReason: "no-effective-request",
      });
      pendingRouteReceipts.delete(session);
      return;
    }
    if (!["request/header", "assistant/chunk"].includes(event?.type)) return;
    let actualRoute;
    try {
      actualRoute = event.type === "request/header"
        ? routeFromConfig(event.data?.header?.config)
        : routeFromConfig(session.requestHeader?.()?.config);
    } catch {}
    if (!actualRoute && event.type !== "assistant/chunk") return;
    const mismatch = routeMismatchFor(pending.expectedRoute, actualRoute, pending.routeMode);
    appendEvent(pending.agent, "odai/route-applied", {
      turn: pending.turn,
      step: pending.step,
      responsibility: pending.responsibility,
      status: mismatch ? "mismatch" : "applied",
      routeMode: pending.routeMode,
      routeSource: pending.routeSource,
      fallbackUsed: Boolean(mismatch),
      requestedRoute: pending.requestedRoute,
      ...(actualRoute ? { actualRoute } : {}),
      ...(mismatch ? { stopReason: "route-mismatch", error: mismatch } : {}),
    });
    pendingRouteReceipts.delete(session);
    if (mismatch && pending.routeMode === "same-turn") {
      protectController(
        pending.agent,
        pending.turn,
        pending.step,
        { reasonCode: `${pending.responsibility.toUpperCase()}_ROUTE_MISMATCH` },
        "route-mismatch",
        mismatch,
      );
    }
  });

  ctx.on("agent/turn-stopping", ({ agent, turn }) => {
    const role = routedRoleOf(agent);
    if (!role) return;
    const receipts = evidence.events(agent)
      .filter((event) => event.type === "odai/route-applied"
        && event.data?.turn === turn
        && event.data?.responsibility === role
        && event.data?.routeMode === "child")
      .map((event) => event.data);
    const failed = receipts.find((receipt) => receipt.status !== "applied");
    if (receipts.length > 0 && !failed) return;
    const detail = failed?.error ?? failed?.stopReason ?? "no verified child route receipt";
    throw new Error(`Odai ${role} child route was not verified: ${detail}`);
  });

  {
    const routedSteps = new WeakMap();
    ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
      const subagentSession = isSubagentSession(agent);
      if (step === 1 && !subagentSession) {
        routeProtections.delete(agent);
        controllerUpgrades.delete(agent);
      }
      let downstream = await next();
      if (downstream.kind === "reject" || signal.aborted || step !== 1 || subagentSession) {
        return downstream;
      }

      if (claimSemanticMemoryTurn(agent, turn, step)) {
        const settings = memorySettingsFor(agent, turn);
        const message = latestDirectUserMessage(agent, downstream.messages, { turn });
        const query = extractRoutingText(downstream.messages, agent?.session?.events).slice(0, config.routing.maxInputChars);
        let retrieved = [];
        let captured = [];
        let error;
        if (settings.mode === "auto" && message) {
          try {
            retrieved = retrieveSemanticMemories({
              storePath: config.memory.storePath,
              query,
              cwd: agent?.session?.header?.cwd,
              limit: config.memory.maxRetrieved,
            });
            captured = captureAutomaticMemories({
              storePath: config.memory.storePath,
              mode: settings.mode,
              agent,
              message,
              turn,
              cwd: agent?.session?.header?.cwd,
            });
          } catch (memoryError) {
            error = memoryError instanceof Error ? memoryError.message : String(memoryError);
            logger.warn(`Odai semantic memory processing failed closed for this turn: ${error}`);
            retrieved = [];
            captured = [];
          }
        }
        const captureEvidence = captured.filter((result) => result.changed);
        if (retrieved.length > 0 || captureEvidence.length > 0 || error) {
          appendEvent(agent, "odai/memory-processed", {
            turn,
            step,
            mode: settings.mode,
            source: settings.source,
            retrievedIds: retrieved.map((entry) => entry.id),
            captures: captureEvidence.map((result) => ({
              changed: true,
              reasonCode: result.reasonCode,
              ...(result.id ? { id: result.id } : {}),
              ...(result.status ? { status: result.status } : {}),
              ...(result.scope ? { scope: result.scope } : {}),
            })),
            ...(error ? { status: "fallback", error: "memory-store-unavailable" } : { status: "completed" }),
          }, logger);
        }
        const packet = renderSemanticMemoryPacket(retrieved);
        if (packet) {
          downstream = {
            ...downstream,
            messages: [...downstream.messages, memoryPacketMessage(packet)],
          };
        }
      }

      if (config.routing.mode === "off") return downstream;
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
      let routedDownstream = downstream;
      let researchPacketText = "";
      const researchDecision = decideResearchPrefetch({ text: taskText });
      if (researchDecision.action === "delegate") {
        appendEvent(agent, "odai/research-decided", {
          turn,
          step,
          role: "researcher",
          action: "delegate",
          mode: config.routing.mode,
          reasonCode: researchDecision.reasonCode,
          signals: researchDecision.signals,
        }, logger);
        if (config.routing.mode === "observe") {
          appendEvent(agent, "odai/research-result", {
            turn,
            step,
            role: "researcher",
            status: "observed",
            stopReason: "observe-mode",
          }, logger);
        } else {
          const researchState = configuredRole(agent, "researcher", turn);
          const researchRoute = researchState.route;
          if (!researchRoute) {
            appendEvent(agent, "odai/research-result", {
              turn,
              step,
              role: "researcher",
              status: "fallback",
              stopReason: researchState.error ? "route-config-invalid" : "route-config-missing",
              ...(researchState.error ? { error: researchState.detail } : {}),
            }, logger);
          } else {
            const researchBundle = sharedSkillSelection(agent, turn)?.bundle ?? bundled;
            const researchContract = dshRoleContract(
              "researcher",
              researchBundle.roleContracts.researcher,
              researchBundle.referenceContracts,
            );
            const result = ctx.subagents?.start
              ? await runRoutedRole({
                  subagents: ctx.subagents,
                  provider: config.routing.provider,
                  decision: researchDecision,
                  taskText: renderResearchTaskContract(taskText),
                  roleContract: researchContract,
                  agent,
                  signal,
                  roleRoute: researchRoute,
                })
              : Object.freeze({
                  status: "fallback",
                  stopReason: "infrastructure-error",
                  output: [],
                  error: "dsh subagents service unavailable",
                });
            let packet;
            let packetError;
            if (result.status === "completed") {
              try {
                packet = verifyResearchPacketSources(
                  parseResearchPacket(outputText(result.output)),
                  agent?.session?.header?.cwd,
                );
              } catch (error) {
                packetError = error instanceof Error ? error.message : String(error);
              }
            }
            const completed = result.status === "completed" && packet !== undefined;
            appendEvent(agent, "odai/research-result", {
              turn,
              step,
              role: "researcher",
              status: completed ? "completed" : "fallback",
              stopReason: completed ? result.stopReason : (packetError ? "packet-invalid" : result.stopReason),
              routeSource: researchState.source,
              fallbackUsed: !completed,
              routeReceiptStatus: result.routeReceiptStatus,
              requestedRoute: researchRoute,
              ...(result.routeReceiptError ? { routeReceiptError: result.routeReceiptError } : {}),
              ...(result.actualRoute ? { actualRoute: result.actualRoute } : {}),
              ...(packet ? { packetDigest: packet.digest, sourceCount: packet.sourceCount } : {}),
              ...(packetError ? { error: packetError } : result.taskError ? { error: result.taskError } : {}),
            }, logger);
            if (completed) {
              researchPacketText = renderResearchPacket(packet);
              routedDownstream = {
                ...downstream,
                messages: [
                  ...routedDownstream.messages,
                  pluginMessage(
                    researchPacketText,
                    `odai completed researcher evidence compression (${packet.sourceCount} sources)`,
                  ),
                ],
              };
            }
          }
        }
      }

      const frozenCard = activeRouteCard(evidence.events(agent));
      let decision = decideRoute({ text: taskText, routeCard: frozenCard });
      let routeRole = decision.targetRole ?? decision.role;
      const roleTaskText = researchPacketText ? `${taskText}\n\n${researchPacketText}` : taskText;
      let roleContext = decision.action === "direct"
        ? undefined
        : buildRoleContextPacket(agent, routeRole, roleTaskText);
      if (config.routing.mode === "auto"
        && routeRole === "reviewer"
        && decision.action === "delegate"
        && !roleContext.sufficient) {
        decision = Object.freeze({
          ...decision,
          role: "controller",
          mode: "upgrade",
          action: "upgrade",
          targetRole: "reviewer",
          signals: Object.freeze([...decision.signals, "review-evidence-packet-missing"]),
        });
        routeRole = "reviewer";
      }
      appendEvent(agent, "odai/route-decided", {
        turn,
        step,
        role: decision.role,
        action: decision.action,
        ...(decision.targetRole ? { targetRole: decision.targetRole } : {}),
        mode: config.routing.mode,
        reasonCode: decision.reasonCode,
        signals: decision.signals,
        ...(decision.considerations ? { considerations: decision.considerations } : {}),
      }, logger);

      if (decision.action === "direct") return routedDownstream;

      if (config.routing.mode === "observe") {
        if (requiresFailClosedProtection(decision)) {
          protectController(agent, turn, step, decision, "observe");
        }
        return {
          kind: "enter",
          messages: [
            ...routedDownstream.messages,
            pluginMessage(
              renderRouteNotice(decision, "observe"),
              `odai observed ${routeRole} gap (${decision.reasonCode})`,
            ),
          ],
        };
      }

      const roleState = configuredRole(agent, routeRole, turn);
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
        if (routeRole === "frontend") return routedDownstream;
        return {
          kind: "enter",
          messages: [
            ...routedDownstream.messages,
            pluginMessage(
              renderMissingRouteConfigNotice(decision, config.routing.mode, roleState.error),
              `odai ${routeRole} route is ${invalidConfig ? "invalid" : "not configured"}`,
            ),
          ],
        };
      }

      const roleBundle = sharedSkillSelection(agent, turn)?.bundle ?? bundled;
      const canonicalRoleContract = roleBundle.roleContracts[routeRole];
      const roleContract = dshRoleContract(routeRole, canonicalRoleContract, roleBundle.referenceContracts);
      roleContext ??= buildRoleContextPacket(agent, routeRole, taskText);
      const inPlaceUpgrade = decision.action === "upgrade"
        && (config.routing.mode === "auto" || ["executor", "frontend"].includes(routeRole));
      const contextMode = inPlaceUpgrade ? "same-turn" : "bounded-packet";
      appendEvent(agent, "odai/route-context", {
        turn,
        step,
        role: routeRole,
        mode: contextMode,
        digest: roleContext.digest,
        evidenceCount: roleContext.evidenceCount,
        toolEvidenceCount: roleContext.toolEvidenceCount,
        acceptanceCount: roleContext.coverage.acceptanceCount,
        diffCount: roleContext.coverage.diffCount,
        testCount: roleContext.coverage.testCount,
        truncated: roleContext.truncated,
        sufficient: roleContext.sufficient,
      }, logger);

      if (routeRole === "reviewer" && decision.action === "delegate" && !roleContext.sufficient) {
        appendEvent(agent, "odai/route-result", {
          turn,
          step,
          role: "reviewer",
          action: "delegate",
          status: "fallback",
          stopReason: "evidence-packet-missing",
          contextDigest: roleContext.digest,
        }, logger);
        return {
          kind: "enter",
          messages: [
            ...routedDownstream.messages,
            pluginMessage(
              `odai reviewer child was not started because the bounded packet is incomplete (${JSON.stringify(roleContext.coverage)}). Gather requirements, acceptance conditions, actual diff, tests, and matching tool evidence first; do not claim independent acceptance.`,
              "odai reviewer evidence packet is incomplete",
            ),
          ],
        };
      }

      if (inPlaceUpgrade) {
        if (["planner", "reviewer"].includes(routeRole)) {
          protectController(agent, turn, step, decision, `same-turn-${routeRole}`);
        }
        if (routeRole === "executor" && frozenCard) {
          appendEvent(agent, "odai/route-card-consumed", { cardId: frozenCard.id, turn, step });
        }
        controllerUpgrades.set(agent, Object.freeze({
          turn,
          role: routeRole,
          route: roleRoute,
          source: roleState.source,
        }));
        appendEvent(agent, "odai/route-upgrade", {
          turn,
          step,
          role: decision.role,
          targetRole: routeRole,
          status: "requested",
          routeSource: roleState.source,
          requestedRoute: roleRoute,
          contextDigest: roleContext.digest,
          contextMode,
          ...(routeRole === "reviewer" ? { independent: false } : {}),
        }, logger);
        const contextBoundary = routeRole === "reviewer"
          ? `The bounded packet is not independently reviewable (${JSON.stringify(roleContext.coverage)}). Perform a same-turn read-only check and do not claim independent acceptance.`
          : "Retain the current controller conversation and workspace context; do not reconstruct it through a child handoff.";
        return {
          kind: "enter",
          messages: [
            ...routedDownstream.messages,
            pluginMessage(
              [
                renderRouteNotice(decision, config.routing.mode, roleRoute),
                "",
                `Context digest: sha256:${roleContext.digest}`,
                contextBoundary,
                "",
                `${routeRole} responsibility contract:`,
                roleContract,
                ...(routeRole === "executor" && frozenCard
                  ? ["", "Frozen route card:", JSON.stringify(frozenCard, null, 2)]
                  : []),
              ].join("\n"),
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
            taskText: renderRoleContextPacket(roleContext),
            roleContract,
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
        routeSource: roleState.source,
        fallbackUsed: result.status !== "completed",
        routeReceiptStatus: result.routeReceiptStatus,
        requestedRoute: roleRoute,
        contextDigest: roleContext.digest,
        ...(result.routeReceiptError ? { routeReceiptError: result.routeReceiptError } : {}),
        ...(result.actualRoute ? { actualRoute: result.actualRoute } : {}),
        ...(result.taskError ? { error: result.taskError } : {}),
      }, logger);

      if (result.status === "completed") {
        const childText = outputText(result.output);
        const heading = renderRouteNotice(delegationDecision, config.routing.mode, result.actualRoute);
        return {
          kind: "enter",
          messages: [
            ...routedDownstream.messages,
            pluginMessage(
              childText ? `${heading}\ncontext digest: sha256:${roleContext.digest}\n\n${routeRole} output:\n${childText}` : heading,
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
          ...routedDownstream.messages,
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
