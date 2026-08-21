import { randomUUID } from "node:crypto";

import type { DshAgent, DshEvent, RuntimeTool } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

export const ROUTE_CARD_PROMPT = [
  "## Odai frozen route cards",
  "Use odai_route_card only after planning has frozen a concrete implementation boundary and executor separation has an observable net benefit.",
  "After the canonical executor reassessment proves observable net benefit, freeze the card before implementation continues. Otherwise continue directly without a card or process narration.",
  "A card must preserve the target, decisive evidence, allowed and forbidden scope, acceptance conditions, and stop condition. Do not freeze a card merely because an executor model is configured or cheaper.",
  "The controller owns the card. Child agents may not create, replace, or clear it. A card is claimed for one executor attempt and consumed only after an applied executor route receipt; validation, provider, or receipt failure releases the claim for retry. A verified provider max-token interruption may reclaim that same card only after a direct user continuation, without changing its scope or authorization. A later explicit clear is terminal and cannot be undone by a delayed release.",
  "When the original current task already authorizes implementation, a planner that freezes a card must submit an executor responsibility gap so implementation continues automatically in the same user task. Ask the user only for a new task, plan-only request, changed scope, or missing user-owned authorization.",
].join("\n");

export type RouteAuthorizationStatus = "authorized" | "plan-only" | "unknown";

export interface RouteAuthorization {
  readonly status: RouteAuthorizationStatus;
  readonly userMessageId?: string;
}

export interface RouteCard {
  readonly id: string;
  readonly frozen: true;
  readonly observableBenefit: true;
  readonly authorization: RouteAuthorization;
  readonly target: string;
  readonly evidence: readonly string[];
  readonly scope: readonly string[];
  readonly accept: readonly string[];
  readonly stop: string;
}

type RouteCardState = "active" | "claimed" | "closed";

export type RouteCardToolResult =
  | { readonly action: "freeze"; readonly status: "frozen"; readonly card: RouteCard }
  | { readonly action: "clear"; readonly status: "cleared"; readonly cardId: string }
  | { readonly action: "clear"; readonly status: "absent" };

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function stringList(value: unknown, field: string, minimum = 0): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new TypeError(`${field} must be an array with at least ${minimum} item${minimum === 1 ? "" : "s"}`);
  }
  return Object.freeze(value.map((item, index) => nonEmptyString(item, `${field}[${index}]`)));
}

function normalizeAuthorization(value: unknown): Readonly<RouteAuthorization> {
  if (!isUnknownRecord(value)) return Object.freeze({ status: "unknown" });
  const status = value.status;
  if (status !== "authorized" && status !== "plan-only" && status !== "unknown") {
    return Object.freeze({ status: "unknown" });
  }
  const userMessageId = typeof value.userMessageId === "string" && value.userMessageId.length > 0 && value.userMessageId.length <= 200
    ? value.userMessageId
    : undefined;
  return Object.freeze({ status, ...(userMessageId ? { userMessageId } : {}) });
}

function normalizeCard(arguments_: Record<string, unknown>, authorization: unknown): Readonly<RouteCard> {
  if (arguments_.observableBenefit !== true) {
    throw new TypeError("observableBenefit must be true before freezing an executor route card");
  }
  return Object.freeze({
    id: randomUUID(),
    frozen: true,
    observableBenefit: true,
    authorization: normalizeAuthorization(authorization),
    target: nonEmptyString(arguments_.target, "target"),
    evidence: stringList(arguments_.evidence, "evidence", 1),
    scope: stringList(arguments_.scope, "scope", 1),
    accept: stringList(arguments_.accept, "accept", 1),
    stop: nonEmptyString(arguments_.stop, "stop"),
  });
}

function isRouteCard(value: unknown): value is RouteCard {
  return isUnknownRecord(value)
    && value.frozen === true
    && typeof value.id === "string";
}

function routeCardInState(
  events: readonly DshEvent[] | undefined,
  acceptedStates: ReadonlySet<RouteCardState>,
): RouteCard | undefined {
  const source = Array.isArray(events) ? events : [];
  const permanentlyCleared = new Set<string>(source.flatMap((event) => (
    event?.type === "odai/route-card-cleared" && typeof event.data?.cardId === "string"
      ? [event.data.cardId]
      : []
  )));
  const latestState = new Map<string, RouteCardState>();
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
    if (!isRouteCard(card)) continue;
    const state = permanentlyCleared.has(card.id) ? "closed" : (latestState.get(card.id) ?? "active");
    if (acceptedStates.has(state)) return card;
  }
  return undefined;
}

export function activeRouteCard(events: readonly DshEvent[] | undefined): RouteCard | undefined {
  return routeCardInState(events, new Set<RouteCardState>(["active"]));
}

export function unsettledRouteCard(events: readonly DshEvent[] | undefined): RouteCard | undefined {
  return routeCardInState(events, new Set<RouteCardState>(["active", "claimed"]));
}

export function routeCardById(events: readonly DshEvent[] | undefined, cardId: unknown): RouteCard | undefined {
  if (typeof cardId !== "string" || cardId === "") return undefined;
  for (let index = (Array.isArray(events) ? events.length : 0) - 1; index >= 0; index -= 1) {
    const event = events?.[index];
    const card = event?.data?.card;
    if (event?.type === "odai/route-card-frozen" && isRouteCard(card) && card.id === cardId) return card;
  }
  return undefined;
}

export interface RouteCardToolOptions {
  onFrozen?(agent: DshAgent, card: RouteCard): void;
  onCleared?(agent: DshAgent, cardId: string): void;
  activeFor?(agent: DshAgent): RouteCard | undefined;
  unsettledFor?(agent: DshAgent): RouteCard | undefined;
  authorizationFor?(agent: DshAgent): RouteAuthorization;
}

export function createRouteCardTool(
  options: RouteCardToolOptions = {},
): RuntimeTool<unknown, RouteCardToolResult> {
  const onFrozen = typeof options.onFrozen === "function" ? options.onFrozen : () => {};
  const onCleared = typeof options.onCleared === "function" ? options.onCleared : () => {};
  const activeFor = typeof options.activeFor === "function" ? options.activeFor : () => undefined;
  const unsettledFor = typeof options.unsettledFor === "function" ? options.unsettledFor : activeFor;
  const authorizationFor = typeof options.authorizationFor === "function"
    ? options.authorizationFor
    : () => Object.freeze({ status: "unknown" as const });
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
      render(_arguments, value) {
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
    execute(arguments_, execution) {
      if (!execution.agent) throw new Error("odai_route_card requires an owning agent session");
      const header = execution.agent.session?.header;
      if (header?.origin === "subagent" || (Number.isSafeInteger(header?.delegationDepth) && (header?.delegationDepth ?? 0) > 0)) {
        throw new Error("child agents may not change Odai route cards");
      }
      if (!isUnknownRecord(arguments_)) throw new TypeError("arguments must be an object");
      if (arguments_.action === "freeze") {
        const active = unsettledFor(execution.agent);
        if (active) throw new Error(`executor route card ${active.id} is already active or claimed`);
        const card = normalizeCard(arguments_, authorizationFor(execution.agent));
        onFrozen(execution.agent, card);
        return Promise.resolve(Object.freeze({ action: "freeze", status: "frozen", card }));
      }
      if (arguments_.action === "clear") {
        const card = activeFor(execution.agent);
        if (!card) return Promise.resolve(Object.freeze({ action: "clear", status: "absent" }));
        if (arguments_.cardId !== undefined && arguments_.cardId !== card.id) {
          throw new Error(`route card ${String(arguments_.cardId)} does not match active card ${card.id}`);
        }
        onCleared(execution.agent, card.id);
        return Promise.resolve(Object.freeze({ action: "clear", status: "cleared", cardId: card.id }));
      }
      throw new TypeError("action must be freeze or clear");
    },
  };
}
