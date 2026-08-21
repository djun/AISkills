import {
  applyCompactionStateProtocol,
  applyCompactionTarget,
  effectiveCompactionTarget,
  invalidatePersistedCompactionTarget,
} from "./compaction-config.mjs";
import { installCompactionRuntime } from "./compaction-runtime.mjs";
import { installLifecycleRuntime } from "./lifecycle-runtime.mjs";
import type {
  OutputUsage,
  PendingRestoration,
  PendingRouteReceipt,
  ResponsibilityScope,
  RouteProtection,
} from "./lifecycle-runtime.mjs";
import { classifyModelRouteFailure, probeModelRoute } from "./model-route.mjs";
import { createPromptRuntime } from "./prompt-runtime.mjs";
import {
  latestDanglingResponsibilityScope,
  responsibilityScopeStoppedEvent,
} from "./responsibility-scope.mjs";
import { invalidatePersistedRoleRoute } from "./routing-config.mjs";
import {
  inheritCompactionReasoning,
  resolveConfig,
  resolveSkillPath,
} from "./runtime-config.mjs";
import {
  RUNTIME_NAME,
  loggerFor,
  routeFromConfig,
  runRoutedRole,
  sameRequestModelRoute,
} from "./runtime-support.mjs";
import { createSessionEvidence, resolveSessionEvidenceRoot } from "./session-evidence.mjs";
import { currentAgentTurn } from "./skill-selection-state.mjs";
import { installToolRuntime } from "./tool-runtime.mjs";
import { resolveHumanSafetyContinuityStorePath } from "./human-safety-continuity-store.mjs";
import type {
  DshAgent,
  DshRuntimeContext,
  DshSession,
  ModelRoute,
  RuntimeEventData,
  UnknownRecord,
} from "./runtime-types.mjs";

export const name = RUNTIME_NAME;
export { inheritCompactionReasoning, resolveConfig, resolveSkillPath, runRoutedRole };

export const inject = ["systemPrompt", "tools", "subagents", "sessions", "llm"];

interface RouteFailure {
  kind: string;
  code: string;
  message: string;
}

interface RouteInvalidation extends UnknownRecord {
  invalidated: boolean;
  reason?: string;
  backupPath?: string;
  error?: string;
}

export function apply(ctx: DshRuntimeContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig);
  const logger = loggerFor(ctx);
  const humanSafetyContinuityStorePath = resolveHumanSafetyContinuityStorePath();
  const evidence = createSessionEvidence({
    root: resolveSessionEvidenceRoot(config.routing.configPath),
    logger,
  });
  const appendEvent = (agent: DshAgent, type: string, data: RuntimeEventData) => {
    try {
      evidence.append(agent, type, data);
    } catch (error) {
      logger.warn(`failed to record ${type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const hasSessionEvent = (
    agent: DshAgent,
    type: string,
    predicate: (data: RuntimeEventData) => boolean,
  ): boolean => (evidence.has as unknown as (
    target: DshAgent,
    eventType: string,
    test: (data: RuntimeEventData) => boolean,
  ) => boolean)(agent, type, predicate);
  installCompactionRuntime({
    appendEvent,
    applyCompactionStateProtocol,
    applyCompactionTarget,
    classifyModelRouteFailure,
    config,
    ctx,
    effectiveCompactionTarget,
    inheritCompactionReasoning,
    invalidatePersistedCompactionTarget,
    logger,
    probeModelRoute,
    routeFromConfig,
    sameRequestModelRoute,
  });
  const promptRuntime = createPromptRuntime({
    appendEvent,
    config,
    ctx,
    evidence,
    hasSessionEvent,
    humanSafetyContinuityStorePath,
    logger,
  });
  const {
    baseSelection,
    bundled,
    evolutionDisabled,
    explicitSkillPath,
    memorySettingsFor,
    routingSnapshotFor,
    selectOutputForAgent,
    skillPath,
  } = promptRuntime;
  const routeProtections = new WeakMap<DshAgent, RouteProtection>();
  const responsibilityScopes = new WeakMap<DshAgent, ResponsibilityScope>();
  const responsibilityScopeOwners = new WeakMap<DshSession, DshAgent>();
  const pendingRouteReceipts = new WeakMap<DshSession, PendingRouteReceipt>();
  const pendingScopeRestorations = new WeakMap<DshSession, PendingRestoration>();
  const outputUsageBySession = new WeakMap<DshSession, OutputUsage>();
  const stopResponsibilityScope = (
    agent: DshAgent,
    reason: string,
    position: RuntimeEventData = {},
  ) => {
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
  const stopDanglingResponsibilityScope = (agent: DshAgent, reason: string): RuntimeEventData | undefined => {
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
  const configuredRole = (agent: DshAgent, role: string, turn = currentAgentTurn(agent)) => {
    const state = routingSnapshotFor(agent, turn);
    if (state.error || !state.snapshot) return state;
    return {
      route: state.snapshot.roles[role],
      source: state.snapshot.sources[role],
    };
  };
  const pendingResponsibilityGap = (
    agent: DshAgent,
    turn: number | undefined,
    step: number,
  ): RuntimeEventData | undefined => {
    const consumed = new Set<unknown>();
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
  const invalidateFailedRoleRoute = (
    agent: DshAgent,
    role: string,
    route: ModelRoute,
    source: string | undefined,
    failure: RouteFailure,
    position: RuntimeEventData = {},
  ): RouteInvalidation => {
    let invalidation: RouteInvalidation = Object.freeze({ invalidated: false, reason: "not-deterministic-or-not-persisted" });
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
  installToolRuntime({
    appendEvent, baseSelection, bundled, config, ctx, evidence, evolutionDisabled, explicitSkillPath,
    hasSessionEvent, humanSafetyContinuityStorePath, logger, pendingResponsibilityGap, promptRuntime,
    routeProtections, selectOutputForAgent,
  });

  installLifecycleRuntime({
    appendEvent, bundled, config, configuredRole, ctx, evidence, hasSessionEvent, invalidateFailedRoleRoute,
    logger, memorySettingsFor, outputUsageBySession, pendingResponsibilityGap, pendingRouteReceipts,
    pendingScopeRestorations, responsibilityScopeOwners, responsibilityScopes, routeProtections,
    selectOutputForAgent, stopDanglingResponsibilityScope, stopResponsibilityScope,
  });

  logger.info(`loaded canonical governance ${bundled.manifest.skillVersion} from ${skillPath}; skillSource=${explicitSkillPath ? "path" : config.governance.skillSource}; routing=${config.routing.mode}`);
}
