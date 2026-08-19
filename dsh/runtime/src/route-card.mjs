import { randomUUID } from "node:crypto";

export const ROUTE_CARD_PROMPT = [
  "## Odai frozen route cards",
  "Use odai_route_card only after planning has frozen a concrete implementation boundary and executor separation has an observable net benefit.",
  "After the canonical executor reassessment proves observable net benefit, freeze the card before implementation continues. Otherwise continue directly without a card or process narration.",
  "A card must preserve the target, decisive evidence, allowed and forbidden scope, acceptance conditions, and stop condition. Do not freeze a card merely because an executor model is configured or cheaper.",
  "The controller owns the card. Child agents may not create, replace, or clear it. A card is claimed for one executor attempt and consumed only after an applied executor route receipt; validation, provider, or receipt failure releases the claim for retry. A verified provider max-token interruption may reclaim that same card only after a direct user continuation, without changing its scope or authorization. A later explicit clear is terminal and cannot be undone by a delayed release.",
  "When the original current task already authorizes implementation, a planner that freezes a card must submit an executor responsibility gap so implementation continues automatically in the same user task. Ask the user only for a new task, plan-only request, changed scope, or missing user-owned authorization.",
].join("\n");

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function stringList(value, field, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new TypeError(`${field} must be an array with at least ${minimum} item${minimum === 1 ? "" : "s"}`);
  }
  return Object.freeze(value.map((item, index) => nonEmptyString(item, `${field}[${index}]`)));
}

function normalizeAuthorization(value) {
  const status = value?.status;
  if (!["authorized", "plan-only", "unknown"].includes(status)) return Object.freeze({ status: "unknown" });
  const userMessageId = typeof value.userMessageId === "string" && value.userMessageId.length > 0 && value.userMessageId.length <= 200
    ? value.userMessageId
    : undefined;
  return Object.freeze({ status, ...(userMessageId ? { userMessageId } : {}) });
}

function normalizeCard(args, authorization) {
  if (args.observableBenefit !== true) {
    throw new TypeError("observableBenefit must be true before freezing an executor route card");
  }
  return Object.freeze({
    id: randomUUID(),
    frozen: true,
    observableBenefit: true,
    authorization: normalizeAuthorization(authorization),
    target: nonEmptyString(args.target, "target"),
    evidence: stringList(args.evidence, "evidence", 1),
    scope: stringList(args.scope, "scope", 1),
    accept: stringList(args.accept, "accept", 1),
    stop: nonEmptyString(args.stop, "stop"),
  });
}

function routeCardInState(events, acceptedStates) {
  const source = Array.isArray(events) ? events : [];
  const permanentlyCleared = new Set(source.flatMap((event) => (
    event?.type === "odai/route-card-cleared" && typeof event.data?.cardId === "string"
      ? [event.data.cardId]
      : []
  )));
  const latestState = new Map();
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const event = source[index];
    const cardId = event?.data?.cardId;
    if (typeof cardId === "string" && !latestState.has(cardId)) {
      if (event.type === "odai/route-card-claim-released") latestState.set(cardId, "active");
      else if (event.type === "odai/route-card-claimed") latestState.set(cardId, "claimed");
      else if (["odai/route-card-cleared", "odai/route-card-consumed"].includes(event.type)) latestState.set(cardId, "closed");
    }
    if (event?.type !== "odai/route-card-frozen") continue;
    const card = event.data?.card;
    if (card?.frozen !== true || typeof card.id !== "string") continue;
    const state = permanentlyCleared.has(card.id) ? "closed" : (latestState.get(card.id) ?? "active");
    if (acceptedStates.has(state)) return card;
  }
  return undefined;
}

export function activeRouteCard(events) {
  return routeCardInState(events, new Set(["active"]));
}

export function unsettledRouteCard(events) {
  return routeCardInState(events, new Set(["active", "claimed"]));
}

export function routeCardById(events, cardId) {
  if (typeof cardId !== "string" || cardId === "") return undefined;
  for (let index = (Array.isArray(events) ? events.length : 0) - 1; index >= 0; index -= 1) {
    const event = events[index];
    const card = event?.data?.card;
    if (event?.type === "odai/route-card-frozen" && card?.id === cardId && card.frozen === true) return card;
  }
  return undefined;
}

export function createRouteCardTool(options = {}) {
  const onFrozen = typeof options.onFrozen === "function" ? options.onFrozen : () => {};
  const onCleared = typeof options.onCleared === "function" ? options.onCleared : () => {};
  const activeFor = typeof options.activeFor === "function" ? options.activeFor : () => undefined;
  const unsettledFor = typeof options.unsettledFor === "function" ? options.unsettledFor : activeFor;
  const authorizationFor = typeof options.authorizationFor === "function"
    ? options.authorizationFor
    : () => Object.freeze({ status: "unknown" });
  return {
    name: "odai_route_card",
    description: "Freeze or clear one structured executor route card. Use only when planning has bounded implementation and independently justified executor separation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["freeze", "clear"] },
        target: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        scope: { type: "array", items: { type: "string" } },
        accept: { type: "array", items: { type: "string" } },
        stop: { type: "string" },
        observableBenefit: { type: "boolean" },
        cardId: { type: "string" },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "status"],
        properties: {
          action: { type: "string", enum: ["freeze", "clear"] },
          status: { type: "string", enum: ["frozen", "cleared", "absent"] },
          card: { type: "object" },
          cardId: { type: "string" },
        },
      },
      render(_args, value) {
        return [{
          type: "text",
          text: value.status === "frozen"
            ? `Frozen executor route card ${value.card.id}: ${value.card.target}`
            : value.status === "cleared"
              ? `Cleared executor route card ${value.cardId}.`
              : "No active executor route card exists.",
        }];
      },
    },
    execute(args, execution) {
      if (!execution.agent) throw new Error("odai_route_card requires an owning agent session");
      const header = execution.agent.session?.header;
      if (header?.origin === "subagent" || (Number.isSafeInteger(header?.delegationDepth) && header.delegationDepth > 0)) {
        throw new Error("child agents may not change Odai route cards");
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("arguments must be an object");
      if (args.action === "freeze") {
        const active = unsettledFor(execution.agent);
        if (active) throw new Error(`executor route card ${active.id} is already active or claimed`);
        const card = normalizeCard(args, authorizationFor(execution.agent));
        onFrozen(execution.agent, card);
        return Promise.resolve(Object.freeze({ action: "freeze", status: "frozen", card }));
      }
      if (args.action === "clear") {
        const card = activeFor(execution.agent);
        if (!card) return Promise.resolve(Object.freeze({ action: "clear", status: "absent" }));
        if (args.cardId !== undefined && args.cardId !== card.id) {
          throw new Error(`route card ${args.cardId} does not match active card ${card.id}`);
        }
        onCleared(execution.agent, card.id);
        return Promise.resolve(Object.freeze({ action: "clear", status: "cleared", cardId: card.id }));
      }
      throw new TypeError("action must be freeze or clear");
    },
  };
}
