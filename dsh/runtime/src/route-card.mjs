import { randomUUID } from "node:crypto";

export const ROUTE_CARD_PROMPT = [
  "## Odai frozen route cards",
  "Use odai_route_card only after planning has frozen a concrete implementation boundary and executor separation has an observable net benefit.",
  "After the canonical executor reassessment proves observable net benefit, freeze the card before implementation continues. Otherwise continue directly without a card or process narration.",
  "A card must preserve the target, decisive evidence, allowed and forbidden scope, acceptance conditions, and stop condition. Do not freeze a card merely because an executor model is configured or cheaper.",
  "The controller owns the card. Child agents may not create, replace, or clear it. A frozen card is consumed only by a later explicit execution continuation such as continue, proceed, execute, or implement the plan.",
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

function normalizeCard(args) {
  if (args.observableBenefit !== true) {
    throw new TypeError("observableBenefit must be true before freezing an executor route card");
  }
  return Object.freeze({
    id: randomUUID(),
    frozen: true,
    observableBenefit: true,
    target: nonEmptyString(args.target, "target"),
    evidence: stringList(args.evidence, "evidence", 1),
    scope: stringList(args.scope, "scope", 1),
    accept: stringList(args.accept, "accept", 1),
    stop: nonEmptyString(args.stop, "stop"),
  });
}

export function activeRouteCard(events) {
  const closed = new Set();
  for (let index = (Array.isArray(events) ? events.length : 0) - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (["odai/route-card-cleared", "odai/route-card-consumed"].includes(event?.type)
      && typeof event.data?.cardId === "string") {
      closed.add(event.data.cardId);
      continue;
    }
    if (event?.type !== "odai/route-card-frozen") continue;
    const card = event.data?.card;
    if (card?.frozen === true && typeof card.id === "string" && !closed.has(card.id)) return card;
  }
  return undefined;
}

export function createRouteCardTool(options = {}) {
  const onFrozen = typeof options.onFrozen === "function" ? options.onFrozen : () => {};
  const onCleared = typeof options.onCleared === "function" ? options.onCleared : () => {};
  const activeFor = typeof options.activeFor === "function" ? options.activeFor : () => undefined;
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
        const active = activeFor(execution.agent);
        if (active) throw new Error(`executor route card ${active.id} is already active`);
        const card = normalizeCard(args);
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
