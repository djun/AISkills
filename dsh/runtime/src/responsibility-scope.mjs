import { randomUUID } from "node:crypto";

const SHORT_SCOPE_ROLES = new Set(["planner", "reviewer"]);
const WORK_SCOPE_ROLES = new Set(["executor", "frontend"]);

function routeSnapshot(value) {
  if (typeof value?.provider !== "string" || typeof value?.model !== "string") return undefined;
  return Object.freeze({
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
    ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens }),
  });
}

function rolePolicy(role) {
  if (SHORT_SCOPE_ROLES.has(role)) return "read-only-tool-chain";
  if (WORK_SCOPE_ROLES.has(role)) return "bounded-work-tool-chain";
  throw new TypeError(`unsupported in-place responsibility: ${role}`);
}

export function createResponsibilityScope({
  turn,
  startStep,
  role,
  route,
  source,
  decision,
  routeValidated = false,
  cardId,
}) {
  if (!Number.isSafeInteger(turn) || turn < 1) throw new TypeError("scope turn must be a positive integer");
  if (!Number.isSafeInteger(startStep) || startStep < 1) throw new TypeError("scope startStep must be a positive integer");
  const requestedRoute = routeSnapshot(route);
  if (!requestedRoute) throw new TypeError("scope route must contain provider and model");
  return Object.freeze({
    id: randomUUID(),
    state: "pending",
    turn,
    startStep,
    role,
    route: requestedRoute,
    source,
    decision,
    continuationPolicy: rolePolicy(role),
    stopPolicy: "terminal-response-or-ownership-boundary",
    routeValidated: routeValidated === true,
    ...(cardId ? { cardId } : {}),
  });
}

export function claimResponsibilityScope(scope, { step, baseRoute, temporaryRoute, routeMode }) {
  if (scope?.state !== "pending") return scope;
  if (step !== scope.startStep) throw new Error("responsibility scope may only be claimed by its start step");
  const base = routeSnapshot(baseRoute);
  const temporary = routeSnapshot(temporaryRoute);
  if (!base || !temporary) throw new TypeError("claimed responsibility scope requires base and temporary routes");
  return Object.freeze({
    ...scope,
    state: "active",
    claimedStep: step,
    baseRoute: base,
    temporaryRoute: temporary,
    routeMode,
  });
}

export function responsibilityScopeOwnsRequest(scope, turn, step) {
  return Boolean(scope
    && ["pending", "active"].includes(scope.state)
    && scope.turn === turn
    && Number.isSafeInteger(step)
    && step >= scope.startStep);
}

export function isDirectHumanMessage(message) {
  return message?.role === "user" && message?.source?.kind === "user";
}

function assistantHasToolCalls(event) {
  return Array.isArray(event?.data?.message?.content)
    && event.data.message.content.some((block) => block?.type === "tool-call");
}

export function responsibilityScopeStopReason(scope, event) {
  if (!scope || !event) return undefined;
  if (event.type === "agent/inbox/spliced"
    && Array.isArray(event.data?.inserted)
    && event.data.inserted.some(isDirectHumanMessage)) {
    return "direct-user-input";
  }
  if (event.type === "assistant/message"
    && event.data?.turn === scope.turn
    && Number.isSafeInteger(event.data?.step)
    && event.data.step >= scope.startStep
    && !assistantHasToolCalls(event)) {
    return "terminal-response";
  }
  if (event.type === "turn/end" && event.data?.turn === scope.turn) return "turn-ended";
  if (scope.cardId && event.type === "odai/route-card-cleared" && event.data?.cardId === scope.cardId) return "route-card-cleared";
  if (scope.cardId && event.type === "odai/route-card-claim-released" && event.data?.cardId === scope.cardId) return "route-card-released";
  return undefined;
}

function scopeEventData(scope) {
  return Object.freeze({
    scopeId: scope.id,
    turn: scope.turn,
    startStep: scope.startStep,
    role: scope.role,
    requestedRoute: scope.route,
    continuationPolicy: scope.continuationPolicy,
    stopPolicy: scope.stopPolicy,
    ...(scope.source ? { routeSource: scope.source } : {}),
    ...(scope.cardId ? { routeCardId: scope.cardId } : {}),
    ...(scope.baseRoute ? { baseRoute: scope.baseRoute } : {}),
    ...(scope.temporaryRoute ? { temporaryRoute: scope.temporaryRoute } : {}),
    ...(scope.routeMode ? { routeMode: scope.routeMode } : {}),
  });
}

export function responsibilityScopeStartedEvent(scope) {
  return scopeEventData(scope);
}

export function responsibilityScopeClaimedEvent(scope) {
  if (scope?.state !== "active") throw new TypeError("only an active responsibility scope can be recorded as claimed");
  return scopeEventData(scope);
}

export function responsibilityScopeStoppedEvent(scope, reason, position = {}) {
  return Object.freeze({
    ...scopeEventData(scope),
    ...(Number.isSafeInteger(position.step) ? { stopStep: position.step } : {}),
    reason,
  });
}

export function latestDanglingResponsibilityScope(events) {
  const states = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const scopeId = event?.data?.scopeId;
    if (typeof scopeId !== "string") continue;
    if (event.type === "odai/responsibility-scope-started") states.set(scopeId, { state: "started", data: event.data });
    else if (event.type === "odai/responsibility-scope-claimed") states.set(scopeId, { state: "claimed", data: event.data });
    else if (event.type === "odai/responsibility-scope-stopped") states.set(scopeId, { state: "stopped", data: event.data });
  }
  return [...states.values()].findLast((entry) => entry.state === "claimed")?.data;
}

export function pendingResponsibilityScopeRestoration(events) {
  let candidate;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "odai/responsibility-scope-stopped"
      && event.data?.baseRoute
      && event.data?.temporaryRoute) {
      candidate = event.data;
      continue;
    }
    if (candidate && event?.type === "request/header") candidate = undefined;
    if (candidate
      && event?.type === "odai/responsibility-scope-restored"
      && event.data?.scopeId === candidate.scopeId) candidate = undefined;
  }
  return candidate;
}
