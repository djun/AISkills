import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyImplementationAuthorization,
  classifyResponsibilityInterruptionText,
  decideResearchPrefetch,
  decideRoute,
  extractLatestUserText,
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
  invalidatePersistedRoleRoute,
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
  invalidatePersistedCompactionTarget,
  resolveCompactionConfigPath,
} from "./compaction-config.mjs";
import { createSessionEvidence, resolveSessionEvidenceRoot } from "./session-evidence.mjs";
import { classifyModelRouteFailure, probeModelRoute } from "./model-route.mjs";
import { RESPONSIBILITY_GAP_PROMPT, createResponsibilityGapTool } from "./responsibility-gap.mjs";
import {
  ODAI_CORE_TOOL_NAMES,
  activeOdaiToolNames,
  classifyContextActivation,
  inactiveOdaiToolNames,
} from "./context-activation.mjs";
import {
  activateRequestedCapabilities,
  createContextCapabilityTool,
  requestedContextCapabilities,
} from "./context-capability.mjs";
import {
  claimResponsibilityScope,
  createResponsibilityScope,
  latestDanglingResponsibilityScope,
  latestStoppedResponsibilityScope,
  pendingResponsibilityInterruption,
  pendingResponsibilityScopeRestoration,
  responsibilityScopeClaimedEvent,
  responsibilityScopeOwnsRequest,
  responsibilityScopeStartedEvent,
  responsibilityScopeStopReason,
  responsibilityScopeStoppedEvent,
} from "./responsibility-scope.mjs";
import { HUMAN_CARE_REFERENCE_PATH, createHumanCareTool } from "./human-care.mjs";
import { HUMAN_SAFETY_REFERENCE_PATH, createHumanSafetyTool } from "./human-safety.mjs";
import {
  HUMAN_SAFETY_CONTINUITY_PROMPT,
  createHumanSafetyContinuityTool,
  renderHumanSafetyContinuitySection,
} from "./human-safety-continuity.mjs";
import {
  readHumanSafetyContinuityStore,
  resolveHumanSafetyContinuityStorePath,
} from "./human-safety-continuity-store.mjs";
import {
  ROUTE_CARD_PROMPT,
  activeRouteCard,
  createRouteCardTool,
  routeCardById,
  unsettledRouteCard,
} from "./route-card.mjs";
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
  readSkillBundleFile,
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
export const inject = ["systemPrompt", "tools", "subagents", "sessions", "llm"];

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

function renderOutputLimitInterruptionNotice(interruption) {
  const route = interruption.effectiveRoute ?? interruption.requestedRoute;
  return [
    "Odai verified output-limit interruption",
    `responsibility: ${interruption.responsibility}`,
    `interrupted scope: ${interruption.scopeId}`,
    `provider finish reason: ${interruption.reason}`,
    ...(route ? [`effective route: ${route.provider}/${route.model}`] : []),
    ...(interruption.effectiveMaxTokens === undefined ? [] : [`effective maxTokens: ${interruption.effectiveMaxTokens}`]),
    ...(interruption.outputTokens === undefined ? [] : [`observed outputTokens: ${interruption.outputTokens}`]),
    "This proves the responsibility output was interrupted, not that its task completed. Explain the verified cause without guessing. Resume only after an explicit user continuation.",
  ].join("\n");
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

function sameRequestModelRoute(left, right) {
  return Boolean(left && right
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort);
}

function currentAgentStep(agent) {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "step/start" && Number.isSafeInteger(events[index].data?.step)) return events[index].data.step;
  }
  return undefined;
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
    if (event.type === "odai/route-fallback") {
      return Object.freeze({
        turn: data.turn,
        step: data.step,
        responsibility: data.responsibility,
        ...(data.responsibilityScopeId ? { responsibilityScopeId: data.responsibilityScopeId } : {}),
        ...(data.routeCardId ? { routeCardId: data.routeCardId } : {}),
        status: "fallback",
        taskStatus: "fallback",
        routeMode: data.routeMode,
        routeSource: data.routeSource,
        fallbackUsed: true,
        requestedRoute: data.requestedRoute,
        ...(data.fallbackRoute ? { actualRoute: data.fallbackRoute } : {}),
        ...(data.error ? { error: data.error } : {}),
      });
    }
    if (event.type === "odai/route-applied") {
      return Object.freeze({
        turn: data.turn,
        step: data.step,
        responsibility: data.responsibility,
        ...(data.responsibilityScopeId ? { responsibilityScopeId: data.responsibilityScopeId } : {}),
        ...(data.routeCardId ? { routeCardId: data.routeCardId } : {}),
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
  const humanSafetyContinuityStorePath = resolveHumanSafetyContinuityStorePath();
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
  const compactionFallbackRequests = new WeakSet();
  ctx.on("llm/stream", (options, next) => {
    if (options?.purpose !== "compaction" || compactionFallbackRequests.has(options)) return next();
    const selection = selectCompactionTarget();
    const downstream = next();
    const streamLike = downstream && typeof downstream[Symbol.asyncIterator] === "function";
    if (!selection.target || !streamLike) {
      applyCompactionTarget(options, selection.target, ctx.sessions);
      applyCompactionStateProtocol(options, selection.target);
      inheritCompactionReasoning(options, ctx.sessions, config.compaction.cacheRetention);
      return downstream;
    }

    const original = Object.freeze({ ...options, messages: options.messages });
    const session = options.sessionId === undefined ? undefined : ctx.sessions?.get?.(options.sessionId);
    const record = (data) => {
      if (session) appendEvent({ session }, "odai/compaction-route", data);
    };
    const restoreOriginal = () => {
      for (const key of Object.keys(options)) {
        if (!Object.hasOwn(original, key)) delete options[key];
      }
      Object.assign(options, original);
    };
    return (async function* configuredCompactionRoute() {
      const validation = await probeModelRoute(
        (candidate, signal) => ctx.llm.resolveCallConfig(candidate, signal),
        selection.target,
        options.signal,
      );
      if (validation.status === "rejected") {
        let invalidation = { invalidated: false };
        if (validation.failure.kind === "deterministic" && selection.source === "persisted") {
          try {
            invalidation = invalidatePersistedCompactionTarget(config.compaction.configPath, selection.target);
          } catch (error) {
            invalidation = { invalidated: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
        record({
          status: "fallback",
          requestedRoute: selection.target,
          fallbackRoute: routeFromConfig(original),
          fallbackUsed: true,
          failureKind: validation.failure.kind,
          errorCode: validation.failure.code,
          error: validation.failure.message,
          invalidated: invalidation.invalidated,
          ...(invalidation.backupPath ? { backupPath: invalidation.backupPath } : {}),
          ...(invalidation.error ? { cleanupError: invalidation.error } : {}),
        });
        inheritCompactionReasoning(options, ctx.sessions, config.compaction.cacheRetention);
        for await (const chunk of downstream) yield chunk;
        return;
      }

      applyCompactionTarget(options, selection.target, ctx.sessions);
      applyCompactionStateProtocol(options, selection.target);
      inheritCompactionReasoning(options, ctx.sessions, config.compaction.cacheRetention);
      const buffered = [];
      let terminalFailure;
      for await (const chunk of downstream) {
        buffered.push(chunk);
        if (chunk?.type === "finish" && ["error", "aborted"].includes(chunk.reason?.kind)) {
          terminalFailure = chunk.reason.failure;
        }
      }
      if (!terminalFailure) {
        record({
          status: "applied",
          requestedRoute: selection.target,
          effectiveRoute: routeFromConfig(options),
          fallbackUsed: false,
        });
        for (const chunk of buffered) yield chunk;
        return;
      }

      const failure = classifyModelRouteFailure(terminalFailure);
      if (failure.kind === "cancelled" || options.signal?.aborted) {
        record({
          status: "failed",
          requestedRoute: selection.target,
          fallbackUsed: false,
          failureKind: failure.kind,
          errorCode: failure.code,
          error: failure.message,
        });
        for (const chunk of buffered) yield chunk;
        return;
      }

      if (sameRequestModelRoute(original, options)) {
        record({
          status: "failed",
          requestedRoute: selection.target,
          effectiveRoute: routeFromConfig(options),
          fallbackUsed: false,
          failureKind: failure.kind,
          errorCode: failure.code,
          error: failure.message,
          stopReason: "configured-and-inherited-routes-match",
        });
        for (const chunk of buffered) yield chunk;
        return;
      }

      let invalidation = { invalidated: false };
      if (failure.kind === "deterministic" && selection.source === "persisted") {
        try {
          invalidation = invalidatePersistedCompactionTarget(config.compaction.configPath, selection.target);
        } catch (error) {
          invalidation = { invalidated: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      restoreOriginal();
      const fallbackOptions = { ...original, messages: original.messages };
      inheritCompactionReasoning(fallbackOptions, ctx.sessions, config.compaction.cacheRetention);
      compactionFallbackRequests.add(fallbackOptions);
      record({
        status: "fallback",
        requestedRoute: selection.target,
        fallbackRoute: routeFromConfig(fallbackOptions),
        fallbackUsed: true,
        failureKind: failure.kind,
        errorCode: failure.code,
        error: failure.message,
        invalidated: invalidation.invalidated,
        ...(invalidation.backupPath ? { backupPath: invalidation.backupPath } : {}),
        ...(invalidation.error ? { cleanupError: invalidation.error } : {}),
      });
      for await (const chunk of ctx.llm.stream(fallbackOptions)) yield chunk;
    })();
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
    name: "odai:human-safety-continuity",
    order: -18.875,
    text: HUMAN_SAFETY_CONTINUITY_PROMPT,
  });
  ctx.systemPrompt.section({
    name: "odai:responsibility-gap",
    order: -18.75,
    text: RESPONSIBILITY_GAP_PROMPT,
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
  const contextActivationFor = (agent, text, turn = currentAgentTurn(agent)) => activateRequestedCapabilities(
    classifyContextActivation(text),
    requestedContextCapabilities(evidence.events(agent), turn),
  );
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
    const childSession = isSubagentSession(agent);
    const directMessage = latestDirectUserMessage(agent);
    const activation = contextActivationFor(agent, directMessage ? extractLatestUserText([directMessage]) : "", turn);
    const proposedStep = (currentAgentStep(agent) ?? 0) + 1;
    const routeCardNeeded = !childSession && (Boolean(activeRouteCard(evidence.events(agent)))
      || ["planner", "executor"].includes(pendingResponsibilityGap(agent, turn, proposedStep)?.responsibility));
    const routingPrompt = !activation.routingConfig
      ? ""
      : childSession
        ? ROUTING_CONFIG_PROMPT
        : `${ROUTING_CONFIG_PROMPT}\n\n${renderEffectiveRoutingContext(routingSnapshotFor(agent, turn))}`;
    let continuityRecordPrompt;
    if (!childSession && (activation.care || activation.safety || activation.continuity)) {
      try {
        continuityRecordPrompt = renderHumanSafetyContinuitySection(
          readHumanSafetyContinuityStore(humanSafetyContinuityStorePath),
        );
      } catch (error) {
        logger.warn(`Odai human-safety continuity is unavailable for this turn: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const continuityPrompt = [activation.continuity ? HUMAN_SAFETY_CONTINUITY_PROMPT : undefined, continuityRecordPrompt]
      .filter(Boolean)
      .join("\n\n");
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
        if (section.name === "odai:human-safety-continuity") return { ...section, text: continuityPrompt };
        if (section.name === "odai:responsibility-gap") return { ...section, text: childSession ? "" : RESPONSIBILITY_GAP_PROMPT };
        if (section.name === "odai:route-card") return { ...section, text: routeCardNeeded ? ROUTE_CARD_PROMPT : "" };
        if (section.name === "odai:skill-source-configuration") return { ...section, text: activation.skillSource ? SKILL_SOURCE_CONFIG_PROMPT : "" };
        if (section.name === "odai:controller-output-policy") return { ...section, text: outputPrompt };
        if (section.name === "odai:compaction-model-configuration") return { ...section, text: activation.compactionConfig ? COMPACTION_CONFIG_PROMPT : "" };
        if (section.name === "odai:semantic-memory") return { ...section, text: activation.memory ? MEMORY_PROMPT : "" };
        return section;
      }),
    };
  });

  const routeProtections = new WeakMap();
  const responsibilityScopes = new WeakMap();
  const responsibilityScopeOwners = new WeakMap();
  const pendingRouteReceipts = new WeakMap();
  const pendingScopeRestorations = new WeakMap();
  const outputUsageBySession = new WeakMap();
  const stopResponsibilityScope = (agent, reason, position = {}) => {
    const scope = responsibilityScopes.get(agent);
    if (!scope || (position.scopeId && position.scopeId !== scope.id)) return undefined;
    responsibilityScopes.delete(agent);
    const protection = routeProtections.get(agent);
    if (protection?.scopeId === scope.id) routeProtections.delete(agent);
    appendEvent(agent, "odai/route-protection-released", {
      scopeId: scope.id,
      turn: scope.turn,
      reason,
    });
    appendEvent(agent, "odai/responsibility-scope-stopped", responsibilityScopeStoppedEvent(scope, reason, position));
    return scope;
  };
  const stopDanglingResponsibilityScope = (agent, reason) => {
    if (responsibilityScopes.has(agent)) return undefined;
    const dangling = latestDanglingResponsibilityScope(evidence.events(agent));
    if (!dangling) return undefined;
    appendEvent(agent, "odai/route-protection-released", {
      scopeId: dangling.scopeId,
      turn: dangling.turn,
      reason,
    });
    appendEvent(agent, "odai/responsibility-scope-stopped", {
      ...dangling,
      reason,
    });
    return dangling;
  };
  const configuredRole = (agent, role, turn = currentAgentTurn(agent)) => {
    const state = routingSnapshotFor(agent, turn);
    if (state.error) return state;
    return {
      route: state.snapshot.roles[role],
      source: state.snapshot.sources[role],
    };
  };
  const pendingResponsibilityGap = (agent, turn, step) => {
    const consumed = new Set();
    const events = evidence.events(agent);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.data?.turn !== turn) continue;
      if (event.type === "odai/responsibility-gap-consumed") {
        consumed.add(event.data.stateDigest);
        continue;
      }
      if (event.type !== "odai/responsibility-gap"
        || !Number.isSafeInteger(event.data?.step)
        || event.data.step >= step
        || consumed.has(event.data.stateDigest)) continue;
      return event.data;
    }
    return undefined;
  };
  const invalidateFailedRoleRoute = (agent, role, route, source, failure, position = {}) => {
    let invalidation = Object.freeze({ invalidated: false, reason: "not-deterministic-or-not-persisted" });
    if (failure.kind === "deterministic" && source === "persisted-mapping") {
      try {
        invalidation = invalidatePersistedRoleRoute(config.routing.configPath, role, route);
      } catch (error) {
        invalidation = Object.freeze({
          invalidated: false,
          reason: "cleanup-failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    appendEvent(agent, "odai/route-health", {
      ...position,
      responsibility: role,
      routeSource: source,
      requestedRoute: route,
      status: failure.kind === "deterministic" ? "invalid" : "unhealthy",
      failureKind: failure.kind,
      errorCode: failure.code,
      error: failure.message,
      invalidated: invalidation.invalidated,
      ...(invalidation.backupPath ? { backupPath: invalidation.backupPath } : {}),
      ...(invalidation.reason ? { cleanupReason: invalidation.reason } : {}),
      ...(invalidation.error ? { cleanupError: invalidation.error } : {}),
    });
    return invalidation;
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
  ctx.tools.register(createContextCapabilityTool({
    isChild: isSubagent,
    onRequested(agent, capability) {
      const turn = currentAgentTurn(agent);
      const step = currentAgentStep(agent);
      appendEvent(agent, "odai/context-capability-requested", {
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
        capability,
      });
    },
  }));
  ctx.tools.register(createRoutingConfigTool(config.routing.configPath, {
    configuredRoles: config.routing.roles,
    resolveCallConfig(route, signal) {
      return ctx.llm.resolveCallConfig(route, signal);
    },
    latestRouteFor(agent) {
      return latestRouteReceipt(evidence.events(agent));
    },
    outputPolicyFor() {
      return selectOutputForAgent().policy;
    },
    onConfigured(agent, data) {
      appendEvent(agent, "odai/routing-configured", data);
    },
  }));
  ctx.tools.register(createHumanCareTool({
    isChild: isSubagent,
    contractFor(agent) {
      const bundle = sharedSkillSelection(agent)?.bundle ?? bundled;
      return readSkillBundleFile(bundle, HUMAN_CARE_REFERENCE_PATH).toString("utf8");
    },
  }));
  ctx.tools.register(createHumanSafetyTool({
    isChild: isSubagent,
    contractFor(agent) {
      const bundle = sharedSkillSelection(agent)?.bundle ?? bundled;
      return readSkillBundleFile(bundle, HUMAN_SAFETY_REFERENCE_PATH).toString("utf8");
    },
  }));
  ctx.tools.register(createResponsibilityGapTool({
    isChild: isSubagent,
    onProposed(agent, proposal) {
      const turn = currentAgentTurn(agent);
      const step = currentAgentStep(agent);
      appendEvent(agent, "odai/responsibility-gap", {
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
        ...proposal,
      });
    },
  }));
  ctx.tools.register(createRouteCardTool({
    activeFor(agent) {
      return activeRouteCard(evidence.events(agent));
    },
    unsettledFor(agent) {
      return unsettledRouteCard(evidence.events(agent));
    },
    authorizationFor(agent) {
      const message = latestDirectUserMessage(agent);
      if (!message) return Object.freeze({ status: "unknown" });
      return Object.freeze({
        ...classifyImplementationAuthorization(extractLatestUserText([message])),
        userMessageId: message.id,
      });
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
    responsibilityRoutesFor() {
      try {
        return effectiveRoutingSnapshot(config.routing.configPath, config.routing.roles).roles;
      } catch {
        return undefined;
      }
    },
    onConfigured(agent, data) {
      appendEvent(agent, "odai/output-configured", data);
    },
  }));
  ctx.tools.register(createCompactionConfigTool(config.compaction.configPath, {
    isChild: isSubagent,
    resolveCallConfig(route, signal) {
      return ctx.llm.resolveCallConfig(route, signal);
    },
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
  ctx.tools.register(createHumanSafetyContinuityTool({
    storePath: humanSafetyContinuityStorePath,
    directUserTextFor(agent) {
      const message = latestDirectUserMessage(agent);
      return message ? extractLatestUserText([message]) : "";
    },
    onChanged(agent, data) {
      appendEvent(agent, "odai/human-safety-continuity-changed", data);
    },
  }));
  ctx.tools.guard((execution) => childGuard(execution) ?? routeProtectionGuard(execution));

  const toolExposureStates = new WeakMap();
  const syncToolExposure = (agent, activation, options = {}) => {
    const child = isSubagentSession(agent);
    const activeNames = activeOdaiToolNames(activation, { child, routeCard: options.routeCard === true });
    const deniedNames = [
      ...inactiveOdaiToolNames(activeNames),
      ...(child ? ODAI_CORE_TOOL_NAMES : []),
    ];
    const key = deniedNames.join("\u0000");
    const previous = toolExposureStates.get(agent);
    if (previous?.key === key || ["unsupported", "fallback"].includes(previous?.key)) return activeNames;
    previous?.dispose?.();
    const restrict = agent?.ctx?.tools?.restrict;
    if (typeof restrict !== "function") {
      toolExposureStates.set(agent, Object.freeze({ key: "unsupported", dispose: undefined }));
      return activeNames;
    }
    try {
      const dispose = deniedNames.length > 0
        ? restrict.call(agent.ctx.tools, { deny: deniedNames })
        : undefined;
      toolExposureStates.set(agent, Object.freeze({ key, dispose }));
      appendEvent(agent, "odai/tool-exposure-selected", {
        ...(options.turn === undefined ? {} : { turn: options.turn }),
        ...(options.step === undefined ? {} : { step: options.step }),
        mode: "adaptive",
        activeTools: activeNames,
      });
    } catch (error) {
      logger.warn(`Odai adaptive tool exposure is unavailable; retaining the complete tool catalog: ${error instanceof Error ? error.message : String(error)}`);
      toolExposureStates.set(agent, Object.freeze({ key: "fallback", dispose: undefined }));
    }
    return activeNames;
  };

  ctx.on("tools/result", (execution, result) => {
    if (!execution.agent) return;
    const summary = summarizeToolResult(execution, result);
    if (hasSessionEvent(execution.agent, "odai/tool-observed", (data) => data?.callId === summary.callId)) return;
    appendEvent(execution.agent, "odai/tool-observed", summary, logger);
  });

  ctx.on("agent/request", async ({ agent, turn, step, signal }, next) => {
    let proposed = await next();
    const childRole = routedRoleOf(agent);
    const childRoleState = childRole ? configuredRole(agent, childRole, turn) : undefined;
    if (childRole && !childRoleState.route) {
      throw new Error(childRoleState.error
        ? `Odai ${childRole} child route is unavailable: ${childRoleState.detail}`
        : `Odai ${childRole} child route is not configured`);
    }
    let scope = responsibilityScopes.get(agent);
    if (scope && !responsibilityScopeOwnsRequest(scope, turn, step)) {
      stopResponsibilityScope(agent, "ownership-boundary", { step });
      scope = undefined;
    }
    if (!childRole && !scope) {
      const restoration = pendingResponsibilityScopeRestoration(evidence.events(agent));
      if (restoration && sameRequestModelRoute(proposed, restoration.temporaryRoute)) {
        const { reasoningEffort: _temporaryEffort, maxTokens: _temporaryMaxTokens, ...withoutTemporaryRoute } = proposed;
        proposed = Object.freeze({ ...withoutTemporaryRoute, ...restoration.baseRoute });
        appendEvent(agent, "odai/responsibility-scope-restoration-requested", {
          scopeId: restoration.scopeId,
          turn,
          step,
          role: restoration.role,
          requestedRoute: restoration.baseRoute,
        });
        if (agent?.session) {
          pendingScopeRestorations.set(agent.session, Object.freeze({
            agent,
            scopeId: restoration.scopeId,
            turn,
            step,
            role: restoration.role,
            expectedRoute: restoration.baseRoute,
          }));
        }
      }
    }
    const upgradeRole = scope?.role;
    let roleRoute = childRole
      ? childRoleState.route
      : scope
        ? scope.route
        : undefined;
    const routeSource = childRole ? childRoleState?.source : scope?.source;
    let routeMode = childRole ? "child" : sameRequestModelRoute(proposed, roleRoute) ? "inline" : "same-turn";
    let scopedResponsibilityMaxTokens = upgradeRole ? roleRoute?.maxTokens : undefined;
    const finalize = (finalRequest) => {
      if (roleRoute && agent?.session && Number.isSafeInteger(turn) && Number.isSafeInteger(step)) {
        const expectedRoute = roleRoute;
        const receiptScope = responsibilityScopeOwnsRequest(responsibilityScopes.get(agent), turn, step)
          ? responsibilityScopes.get(agent)
          : scope;
        pendingRouteReceipts.set(agent.session, Object.freeze({
          agent,
          turn,
          step,
          responsibility: childRole ?? upgradeRole,
          routeMode,
          routeSource,
          ...(receiptScope?.id ? { responsibilityScopeId: receiptScope.id } : {}),
          ...(receiptScope?.cardId ? { routeCardId: receiptScope.cardId } : {}),
          ...(receiptScope?.resumeOfScopeId ? { resumeOfScopeId: receiptScope.resumeOfScopeId } : {}),
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
        ...((childRole || scopedResponsibilityMaxTokens !== undefined) && roleRoute.maxTokens !== undefined
          ? { maxTokens: roleRoute.maxTokens }
          : {}),
      });
      if (!childRole && scope?.state === "pending") {
        scope = claimResponsibilityScope(scope, {
          step,
          baseRoute: proposed,
          temporaryRoute: request,
          routeMode,
        });
        responsibilityScopes.set(agent, scope);
        appendEvent(agent, "odai/responsibility-scope-claimed", responsibilityScopeClaimedEvent(scope));
      }
      const validation = scope?.routeValidated
        ? Object.freeze({ status: "verified" })
        : await probeModelRoute(
            (candidate, candidateSignal) => ctx.llm.resolveCallConfig(candidate, candidateSignal),
            request,
            signal,
          );
      if (validation.status === "rejected") {
        const responsibility = childRole ?? upgradeRole;
        const invalidation = invalidateFailedRoleRoute(
          agent,
          responsibility,
          roleRoute,
          routeSource,
          validation.failure,
          { turn, step },
        );
        appendEvent(agent, "odai/route-fallback", {
          turn,
          step,
          responsibility,
          ...(scope?.id ? { responsibilityScopeId: scope.id } : {}),
          ...(scope?.cardId ? { routeCardId: scope.cardId } : {}),
          routeMode,
          routeSource,
          requestedRoute: roleRoute,
          fallbackUsed: true,
          fallbackRoute: routeFromConfig(proposed),
          failureKind: validation.failure.kind,
          errorCode: validation.failure.code,
          error: validation.failure.message,
          invalidated: invalidation.invalidated,
        });
        if (scope?.cardId) {
          appendEvent(agent, "odai/route-card-claim-released", {
            cardId: scope.cardId,
            turn,
            step,
            reason: "route-validation-failed",
          });
        }
        if (childRole) {
          const error = new Error(`Odai ${childRole} route failed validation: ${validation.failure.code}: ${validation.failure.message}`);
          error.code = validation.failure.code;
          error.routeFailureKind = validation.failure.kind;
          throw error;
        }
        stopResponsibilityScope(agent, "route-validation-failed", { step });
        if (scope?.decision && requiresFailClosedProtection(scope.decision)) {
          protectController(agent, turn, step, scope.decision, "route-validation", validation.failure.message);
        }
        roleRoute = undefined;
        routeMode = "same-turn";
        scopedResponsibilityMaxTokens = undefined;
        request = proposed;
      }
    }
    if (childRole || isSubagentSession(agent)) return finalize(request);

    const outputSelection = await selectSharedOutputPolicyForTurn(agent, turn, selectOutputForAgent);
    const configuredMaxTokens = outputSelection.policy.maxTokens;
    if (scopedResponsibilityMaxTokens !== undefined) {
      if (!hasSessionEvent(agent, "odai/output-budget-overridden", (data) => data?.turn === turn && data?.step === step)) {
        appendEvent(agent, "odai/output-budget-overridden", {
          turn,
          ...(step === undefined ? {} : { step }),
          responsibility: upgradeRole,
          responsibilityMaxTokens: scopedResponsibilityMaxTokens,
          ...(configuredMaxTokens === undefined ? {} : { configuredControllerMaxTokens: configuredMaxTokens }),
          effectiveMaxTokens: scopedResponsibilityMaxTokens,
          budgetSource: "responsibility-override",
          semantics: "explicit-responsibility-override",
        });
      }
      return finalize(Object.freeze({ ...request, maxTokens: scopedResponsibilityMaxTokens }));
    }
    if (configuredMaxTokens === undefined) return finalize(request);
    const priorMaxTokens = request.maxTokens;
    const effectiveMaxTokens = priorMaxTokens === undefined
      ? configuredMaxTokens
      : Math.min(priorMaxTokens, configuredMaxTokens);
    const budgetSource = priorMaxTokens !== undefined && priorMaxTokens < configuredMaxTokens
      ? "preexisting-request-ceiling"
      : "controller-policy";
    if (!hasSessionEvent(agent, "odai/output-budget-applied", (data) => data?.turn === turn && data?.step === step)) {
      appendEvent(agent, "odai/output-budget-applied", {
        turn,
        ...(step === undefined ? {} : { step }),
        ...(upgradeRole === undefined ? {} : { responsibility: upgradeRole }),
        configuredMaxTokens,
        ...(priorMaxTokens === undefined ? {} : { priorMaxTokens }),
        effectiveMaxTokens,
        budgetSource,
        semantics: "provider-request-ceiling",
      });
    }
    return finalize(Object.freeze({ ...request, maxTokens: effectiveMaxTokens }));
  }, { prepend: true });

  const routeFallbackAttempts = new WeakMap();
  ctx.on("agent/request-error", async ({ agent, turn, step, provider, failure, signal }, next) => {
    const childRole = routedRoleOf(agent);
    const scope = responsibilityScopes.get(agent);
    if (!childRole && scope && (signal.aborted || failure?.code === "CONTEXT_WINDOW_EXCEEDED")) {
      if (agent?.session) pendingRouteReceipts.delete(agent.session);
      stopResponsibilityScope(agent, signal.aborted ? "request-aborted" : "context-window-exceeded", { step });
      return next();
    }
    if (signal.aborted || failure?.code === "CONTEXT_WINDOW_EXCEEDED") return next();
    const active = childRole
      ? { role: childRole, ...configuredRole(agent, childRole, turn) }
      : responsibilityScopeOwnsRequest(scope, turn, step)
        ? scope
        : undefined;
    if (!active?.route || provider !== active.route.provider) return next();

    const classified = classifyModelRouteFailure(failure);
    const invalidation = invalidateFailedRoleRoute(
      agent,
      active.role,
      active.route,
      active.source,
      classified,
      { turn, step },
    );
    appendEvent(agent, "odai/route-fallback", {
      turn,
      step,
      responsibility: active.role,
      ...(active.id ? { responsibilityScopeId: active.id } : {}),
      ...(active.cardId ? { routeCardId: active.cardId } : {}),
      routeMode: childRole ? "child" : "same-turn",
      routeSource: active.source,
      requestedRoute: active.route,
      fallbackUsed: !childRole,
      fallbackRoute: childRole ? undefined : active.baseRoute ?? routeFromConfig(agent?.options),
      failureKind: classified.kind,
      errorCode: classified.code,
      error: classified.message,
      invalidated: invalidation.invalidated,
    });
    if (active.cardId) {
      appendEvent(agent, "odai/route-card-claim-released", {
        cardId: active.cardId,
        turn,
        step,
        reason: "route-request-failed",
      });
    }
    if (childRole) return next();
    if (agent?.session) pendingRouteReceipts.delete(agent.session);
    stopResponsibilityScope(agent, classified.kind === "cancelled" ? "request-cancelled" : "route-request-failed", { step });
    if (scope?.decision && requiresFailClosedProtection(scope.decision)) {
      protectController(agent, turn, step, scope.decision, "route-request-failure", classified.message);
    }
    if (classified.kind === "cancelled") return next();

    let attempts = routeFallbackAttempts.get(agent);
    if (!attempts) {
      attempts = new Set();
      routeFallbackAttempts.set(agent, attempts);
    }
    const key = `${turn}:${step}`;
    if (attempts.has(key)) return next();
    attempts.add(key);
    return { kind: "retry" };
  });

  const protectController = (agent, turn, step, decision, source, failure, scopeId) => {
    const protection = Object.freeze({
      turn,
      step,
      mode: "read-only",
      reasonCode: decision.reasonCode,
      source,
      ...(failure ? { failure } : {}),
      ...(scopeId ? { scopeId } : {}),
    });
    routeProtections.set(agent, protection);
    appendEvent(agent, "odai/route-protection", protection, logger);
  };

  ctx.on("session/event", (session, event) => {
    const owner = responsibilityScopeOwners.get(session);
    const activeScope = owner ? responsibilityScopes.get(owner) : undefined;
    const eventMatchesRequestPosition = (position) => Number.isSafeInteger(event?.data?.turn)
      && Number.isSafeInteger(event?.data?.step)
      && event.data.turn === position?.turn
      && event.data.step === position?.step;
    const scopeStopReason = responsibilityScopeStopReason(activeScope, event);
    if (scopeStopReason) {
      stopResponsibilityScope(owner, scopeStopReason, {
        scopeId: activeScope.id,
        ...(Number.isSafeInteger(event.data?.step) ? { step: event.data.step } : {}),
      });
    }

    if (event?.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
      outputUsageBySession.set(session, {
        turn: event.data.turn,
        step: event.data.step,
        usage: event.data.chunk.usage,
      });
    } else if (event?.type === "assistant/message" && event.data?.usage) {
      outputUsageBySession.set(session, {
        turn: event.data.turn,
        step: event.data.step,
        usage: event.data.usage,
      });
    }

    if (event?.type === "turn/end") {
      const usage = outputUsageBySession.get(session);
      if (event.data?.reason?.kind === "max-tokens" && owner) {
        const events = evidence.events(owner);
        const stopped = latestStoppedResponsibilityScope(events, event.data?.turn);
        const receipt = stopped && events.findLast((candidate) => (
          candidate?.type === "odai/route-applied"
            && candidate.data?.status === "applied"
            && candidate.data?.responsibilityScopeId === stopped.scopeId
        ))?.data;
        const routeCard = stopped?.routeCardId ? routeCardById(events, stopped.routeCardId) : undefined;
        const observedOutputTokens = usage?.turn === stopped?.turn
          && usage?.step === stopped?.stopStep
          && Number.isSafeInteger(usage.usage?.outputTokens)
          ? usage.usage.outputTokens
          : undefined;
        if (stopped?.reason === "terminal-response"
          && Number.isSafeInteger(stopped.stopStep)
          && receipt?.step === stopped.stopStep
          && Number.isSafeInteger(observedOutputTokens)
          && ["planner", "executor", "frontend"].includes(receipt.responsibility)
          && (receipt.responsibility !== "executor" || routeCard)) {
          const effectiveRoute = receipt.actualRoute ?? receipt.requestedRoute;
          appendEvent(owner, "odai/responsibility-interrupted", {
            scopeId: stopped.scopeId,
            turn: stopped.turn,
            step: stopped.stopStep ?? stopped.startStep,
            responsibility: receipt.responsibility,
            reason: "max-tokens",
            routeMode: receipt.routeMode,
            routeSource: receipt.routeSource,
            requestedRoute: receipt.requestedRoute,
            ...(effectiveRoute ? { effectiveRoute } : {}),
            ...(effectiveRoute?.maxTokens === undefined ? {} : { effectiveMaxTokens: effectiveRoute.maxTokens }),
            outputTokens: observedOutputTokens,
            ...(stopped.routeCardId ? { routeCardId: stopped.routeCardId } : {}),
            ...(routeCard ? { routeCard } : {}),
          }, logger);
        }
      }
      outputUsageBySession.delete(session);
    }

    const pendingRestoration = pendingScopeRestorations.get(session);
    if (pendingRestoration && event?.type === "turn/end" && event.data?.turn === pendingRestoration.turn) {
      appendEvent(pendingRestoration.agent, "odai/responsibility-scope-restored", {
        scopeId: pendingRestoration.scopeId,
        turn: pendingRestoration.turn,
        step: pendingRestoration.step,
        role: pendingRestoration.role,
        status: "unverified",
        requestedRoute: pendingRestoration.expectedRoute,
        stopReason: "no-effective-request",
      });
      pendingScopeRestorations.delete(session);
    }
    if (pendingRestoration
      && ["request/header", "assistant/chunk", "assistant/message"].includes(event?.type)
      && eventMatchesRequestPosition(pendingRestoration)) {
      let actualRoute;
      try {
        actualRoute = event.type === "request/header"
          ? routeFromConfig(event.data?.header?.config)
          : routeFromConfig(session.requestHeader?.()?.config);
      } catch {}
      if (actualRoute || event.type !== "request/header") {
        const mismatch = routeMismatchFor(pendingRestoration.expectedRoute, actualRoute, "base-route restoration");
        appendEvent(pendingRestoration.agent, "odai/responsibility-scope-restored", {
          scopeId: pendingRestoration.scopeId,
          turn: pendingRestoration.turn,
          step: pendingRestoration.step,
          role: pendingRestoration.role,
          status: mismatch ? "mismatch" : "applied",
          requestedRoute: pendingRestoration.expectedRoute,
          ...(actualRoute ? { actualRoute } : {}),
          ...(mismatch ? { error: mismatch } : {}),
        });
        if (mismatch) {
          protectController(
            pendingRestoration.agent,
            pendingRestoration.turn,
            pendingRestoration.step,
            { reasonCode: "RESPONSIBILITY_BASE_ROUTE_RESTORATION_MISMATCH" },
            "scope-restoration-mismatch",
            mismatch,
            pendingRestoration.scopeId,
          );
        }
        pendingScopeRestorations.delete(session);
      }
    }

    const pending = pendingRouteReceipts.get(session);
    if (!pending) return;
    if (event?.type === "turn/end" && event.data?.turn === pending.turn) {
      appendEvent(pending.agent, "odai/route-applied", {
        turn: pending.turn,
        step: pending.step,
        responsibility: pending.responsibility,
        ...(pending.responsibilityScopeId ? { responsibilityScopeId: pending.responsibilityScopeId } : {}),
        ...(pending.routeCardId ? { routeCardId: pending.routeCardId } : {}),
        status: "unverified",
        routeMode: pending.routeMode,
        routeSource: pending.routeSource,
        fallbackUsed: true,
        requestedRoute: pending.requestedRoute,
        stopReason: "no-effective-request",
      });
      if (pending.routeCardId) {
        appendEvent(pending.agent, "odai/route-card-claim-released", {
          cardId: pending.routeCardId,
          turn: pending.turn,
          step: pending.step,
          reason: "no-effective-request",
        });
      }
      stopResponsibilityScope(pending.agent, "no-effective-request", {
        scopeId: pending.responsibilityScopeId,
        step: pending.step,
      });
      pendingRouteReceipts.delete(session);
      return;
    }
    if (!["request/header", "assistant/chunk", "assistant/message"].includes(event?.type)) return;
    if (!eventMatchesRequestPosition(pending)) return;
    let actualRoute;
    try {
      actualRoute = event.type === "request/header"
        ? routeFromConfig(event.data?.header?.config)
        : routeFromConfig(session.requestHeader?.()?.config);
    } catch {}
    if (!actualRoute && event.type === "request/header") return;
    const mismatch = routeMismatchFor(pending.expectedRoute, actualRoute, pending.routeMode);
    appendEvent(pending.agent, "odai/route-applied", {
      turn: pending.turn,
      step: pending.step,
      responsibility: pending.responsibility,
      ...(pending.responsibilityScopeId ? { responsibilityScopeId: pending.responsibilityScopeId } : {}),
      ...(pending.routeCardId ? { routeCardId: pending.routeCardId } : {}),
      status: mismatch ? "mismatch" : "applied",
      routeMode: pending.routeMode,
      routeSource: pending.routeSource,
      fallbackUsed: Boolean(mismatch),
      requestedRoute: pending.requestedRoute,
      ...(actualRoute ? { actualRoute } : {}),
      ...(mismatch ? { stopReason: "route-mismatch", error: mismatch } : {}),
    });
    if (mismatch && pending.routeMode === "same-turn") {
      stopResponsibilityScope(pending.agent, "route-mismatch", {
        scopeId: pending.responsibilityScopeId,
        step: pending.step,
      });
    }
    if (!mismatch && pending.resumeOfScopeId) {
      appendEvent(pending.agent, "odai/responsibility-interruption-consumed", {
        scopeId: pending.resumeOfScopeId,
        turn: pending.turn,
        step: pending.step,
        responsibility: pending.responsibility,
        resumedScopeId: pending.responsibilityScopeId,
      });
    }
    if (pending.routeCardId) {
      appendEvent(pending.agent, mismatch ? "odai/route-card-claim-released" : "odai/route-card-consumed", {
        cardId: pending.routeCardId,
        turn: pending.turn,
        step: pending.step,
        ...(mismatch ? { reason: "route-mismatch" } : { receiptStatus: "applied" }),
      });
    }
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
    stopResponsibilityScope(agent, "turn-stopping");
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
      if (!subagentSession) {
        if (step === 1) {
          stopResponsibilityScope(agent, "new-turn");
          routeProtections.delete(agent);
        }
        stopDanglingResponsibilityScope(agent, "runtime-resume");
      }
      let downstream = await next();
      if (downstream.kind === "reject" || signal.aborted) return downstream;
      const responsibilityGap = subagentSession ? undefined : pendingResponsibilityGap(agent, turn, step);
      const authenticatedDirectMessage = latestDirectUserMessage(agent, undefined, { turn });
      const suppliedDirectMessages = Array.isArray(downstream.messages)
        ? downstream.messages.filter((message) => message?.role === "user" && message?.source?.kind === "user")
        : [];
      const directMessage = latestDirectUserMessage(agent, suppliedDirectMessages, { turn });
      const directText = directMessage ? extractLatestUserText([directMessage]) : "";
      const authenticatedDirectText = authenticatedDirectMessage
        ? extractLatestUserText([authenticatedDirectMessage])
        : "";
      const responsibilityEvents = subagentSession ? [] : evidence.events(agent);
      const interruption = !subagentSession && step === 1
        ? pendingResponsibilityInterruption(responsibilityEvents)
        : undefined;
      let responsibilityContinuation;
      let interruptionNotice;
      if (interruption && authenticatedDirectMessage) {
        const disposition = classifyResponsibilityInterruptionText(authenticatedDirectText);
        if (disposition === "continue" && directMessage) {
          responsibilityContinuation = Object.freeze({ ...interruption, continuationText: authenticatedDirectText });
          appendEvent(agent, "odai/responsibility-interruption-resume-requested", {
            scopeId: interruption.scopeId,
            turn,
            step,
            responsibility: interruption.responsibility,
          });
        } else if (disposition === "preserve") {
          if (directMessage) {
            interruptionNotice = pluginMessage(
              renderOutputLimitInterruptionNotice(interruption),
              `odai verified ${interruption.responsibility} output-limit interruption`,
            );
          }
          appendEvent(agent, "odai/responsibility-interruption-preserved", {
            scopeId: interruption.scopeId,
            turn,
            step,
            responsibility: interruption.responsibility,
            reason: "output-limit-diagnostic",
          });
        } else if (disposition === "clear") {
          appendEvent(agent, "odai/responsibility-interruption-cleared", {
            scopeId: interruption.scopeId,
            turn,
            step,
            responsibility: interruption.responsibility,
            reason: "superseded-by-user-task",
          });
        }
      }
      const activation = contextActivationFor(agent, directText, turn);
      const routeCardNeeded = !subagentSession && (Boolean(activeRouteCard(responsibilityEvents))
        || ["planner", "executor"].includes(responsibilityGap?.responsibility)
        || responsibilityContinuation?.responsibility === "executor");
      syncToolExposure(agent, activation, { turn, step, routeCard: routeCardNeeded });
      if (interruptionNotice) {
        downstream = { ...downstream, messages: [...downstream.messages, interruptionNotice] };
      }
      if (subagentSession) return downstream;
      if (step !== 1 && !responsibilityGap) return downstream;

      if (step === 1 && claimSemanticMemoryTurn(agent, turn, step)) {
        const settings = memorySettingsFor(agent, turn);
        const message = directMessage;
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
      const researchDecision = decideResearchPrefetch({ text: taskText, proposal: responsibilityGap });
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

      const frozenCard = responsibilityContinuation?.routeCard ?? activeRouteCard(evidence.events(agent));
      let decision = decideRoute({
        text: taskText,
        routeCard: frozenCard,
        proposal: responsibilityGap,
        interruption: responsibilityContinuation,
      });
      let routeRole = decision.targetRole ?? decision.role;
      const roleTaskText = researchPacketText ? `${taskText}\n\n${researchPacketText}` : taskText;
      let roleContext = decision.action === "direct"
        ? undefined
        : buildRoleContextPacket(agent, routeRole, roleTaskText);
      let localReviewerCoverage;
      if (config.routing.mode === "auto"
        && routeRole === "reviewer"
        && decision.action === "delegate"
        && !roleContext.sufficient) {
        localReviewerCoverage = roleContext.coverage;
        decision = Object.freeze({
          ...decision,
          role: "controller",
          mode: "direct",
          action: "direct",
          targetRole: "reviewer",
          signals: Object.freeze([...decision.signals, "review-evidence-packet-missing", "controller-local-review"]),
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
        ...(responsibilityGap ? {
          stateDigest: responsibilityGap.stateDigest,
          gap: responsibilityGap.gap,
          evidenceRefs: responsibilityGap.evidenceRefs,
          expectedChange: responsibilityGap.expectedChange,
        } : {}),
        ...(decision.considerations ? { considerations: decision.considerations } : {}),
      }, logger);
      if (responsibilityGap) {
        appendEvent(agent, "odai/responsibility-gap-consumed", {
          turn,
          step,
          responsibility: responsibilityGap.responsibility,
          stateDigest: responsibilityGap.stateDigest,
          routeAction: decision.action,
          reasonCode: decision.reasonCode,
        }, logger);
      }

      if (decision.action === "direct") {
        if (!localReviewerCoverage) return routedDownstream;
        appendEvent(agent, "odai/route-context", {
          turn,
          step,
          role: "reviewer",
          mode: "controller-local",
          digest: roleContext.digest,
          evidenceCount: roleContext.evidenceCount,
          toolEvidenceCount: roleContext.toolEvidenceCount,
          acceptanceCount: localReviewerCoverage.acceptanceCount,
          diffCount: localReviewerCoverage.diffCount,
          testCount: localReviewerCoverage.testCount,
          truncated: roleContext.truncated,
          sufficient: false,
        }, logger);
        appendEvent(agent, "odai/route-result", {
          turn,
          step,
          role: "reviewer",
          action: "direct",
          status: "fallback",
          stopReason: "evidence-packet-missing",
          independent: false,
        }, logger);
        return {
          kind: "enter",
          messages: [
            ...routedDownstream.messages,
            pluginMessage(
              [
                `An independent reviewer was not started because the bounded packet is incomplete (${JSON.stringify(localReviewerCoverage)}).`,
                "Remain on the current controller route and continue the authorized task. Gather project-available requirements, acceptance conditions, diff, tests, and matching tool evidence before resubmitting a changed reviewer gap.",
                "A controller-local read-only check may guide the work, but it is not independent acceptance. Do not stop solely to ask the user for review artifacts the project can produce, and do not claim the reviewer approved release.",
              ].join("\n"),
              "odai reviewer evidence is incomplete; controller continues locally",
            ),
          ],
        };
      }

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
      let rolePreflightVerified = false;
      if (routeRole === "frontend" && decision.action === "upgrade") {
        const health = await probeModelRoute(
          (candidate, candidateSignal) => ctx.llm.resolveCallConfig(candidate, candidateSignal),
          roleRoute,
          signal,
        );
        if (health.status === "rejected") {
          const invalidation = invalidateFailedRoleRoute(
            agent,
            routeRole,
            roleRoute,
            roleState.source,
            health.failure,
            { turn, step, position: "pre-step" },
          );
          appendEvent(agent, "odai/route-result", {
            turn,
            step,
            role: routeRole,
            action: "upgrade",
            status: "fallback",
            stopReason: "route-preflight-failed",
            routeSource: roleState.source,
            fallbackUsed: true,
            requestedRoute: roleRoute,
            failureKind: health.failure.kind,
            error: health.failure.message,
            invalidated: invalidation.invalidated,
          }, logger);
          return {
            kind: "enter",
            messages: [
              ...routedDownstream.messages,
              pluginMessage(
                [
                  `The configured frontend route failed preflight (${health.failure.kind}: ${health.failure.message}).`,
                  "Continue locally as the current controller for this turn using the canonical frontend and craft contract below. Do not claim the configured frontend responsibility ran; no routed receipt exists.",
                  "",
                  "frontend local-fallback responsibility contract:",
                  roleContract,
                ].join("\n"),
                "odai frontend route unavailable; explicit local fallback",
              ),
            ],
          };
        }
        rolePreflightVerified = health.status === "verified";
      }
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
        stopResponsibilityScope(agent, "superseded", { step });
        const responsibilityScope = createResponsibilityScope({
          turn,
          startStep: step,
          role: routeRole,
          route: roleRoute,
          source: roleState.source,
          decision,
          routeValidated: rolePreflightVerified,
          ...(routeRole === "executor" && frozenCard ? { cardId: frozenCard.id } : {}),
          ...(responsibilityContinuation ? { resumeOfScopeId: responsibilityContinuation.scopeId } : {}),
        });
        responsibilityScopes.set(agent, responsibilityScope);
        if (agent?.session) responsibilityScopeOwners.set(agent.session, agent);
        appendEvent(agent, "odai/responsibility-scope-started", responsibilityScopeStartedEvent(responsibilityScope));
        if (["planner", "reviewer"].includes(routeRole)) {
          protectController(agent, turn, step, decision, `responsibility-scope-${routeRole}`, undefined, responsibilityScope.id);
        }
        if (routeRole === "executor" && frozenCard) {
          appendEvent(agent, "odai/route-card-claimed", {
            cardId: frozenCard.id,
            turn,
            step,
            ...(responsibilityContinuation ? { reason: "output-limit-continuation" } : {}),
          });
        }
        appendEvent(agent, "odai/route-upgrade", {
          turn,
          step,
          role: decision.role,
          targetRole: routeRole,
          status: "requested",
          responsibilityScopeId: responsibilityScope.id,
          ...(responsibilityContinuation ? { resumeOfScopeId: responsibilityContinuation.scopeId } : {}),
          continuationPolicy: responsibilityScope.continuationPolicy,
          stopPolicy: responsibilityScope.stopPolicy,
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
