import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTE_CARD_PROMPT,
  activeRouteCard,
  createRouteCardTool,
  routeCardById,
  unsettledRouteCard,
} from "../build/route-card.mjs";
import type { DshAgent, DshEvent, ToolExecution } from "../build/runtime-types.mjs";

function testAgent(origin?: string): DshAgent {
  return { session: { header: origin ? { origin } : {}, events: [], append() {} } };
}

function execution(agent: DshAgent): ToolExecution {
  return { name: "odai_route_card", agent };
}

function cardArgs() {
  return {
    action: "freeze",
    observableBenefit: true,
    target: "Implement the bounded change",
    evidence: ["requirements verified"],
    scope: ["src/target.mjs only"],
    accept: ["A1: focused test passes"],
    stop: "Stop if the public contract changes",
  };
}

test("route-card guidance applies canonical reassessment without size routing", () => {
  assert.match(ROUTE_CARD_PROMPT, /After the canonical executor reassessment proves observable net benefit/u);
  assert.doesNotMatch(ROUTE_CARD_PROMPT, /earlier direct-routing choice expires/u);
  assert.match(ROUTE_CARD_PROMPT, /freeze the card before implementation continues/u);
  assert.match(ROUTE_CARD_PROMPT, /Otherwise continue directly without a card/u);
  assert.match(ROUTE_CARD_PROMPT, /original current task already authorizes implementation/u);
  assert.match(ROUTE_CARD_PROMPT, /continues automatically/u);
  assert.match(ROUTE_CARD_PROMPT, /verified provider max-token interruption/u);
  assert.match(ROUTE_CARD_PROMPT, /direct user continuation/u);
  assert.match(ROUTE_CARD_PROMPT, /explicit clear is terminal/u);
  assert.doesNotMatch(ROUTE_CARD_PROMPT, /task size alone never justifies delegation/u);
});

test("route cards freeze, expose, consume, and clear exactly once", async () => {
  const events: DshEvent[] = [];
  const agent = testAgent();
  const tool = createRouteCardTool({
    activeFor() { return activeRouteCard(events); },
    onFrozen(_agent, card) { events.push({ type: "odai/route-card-frozen", data: { card: { ...card } } }); },
    onCleared(_agent, cardId) { events.push({ type: "odai/route-card-cleared", data: { cardId } }); },
  });

  const frozen = await tool.execute(cardArgs(), execution(agent));
  assert.equal(frozen.status, "frozen");
  if (frozen.status !== "frozen") assert.fail("expected a frozen route card");
  assert.match(frozen.card.id, /^[a-f0-9-]{36}$/u);
  assert.deepEqual(frozen.card.authorization, { status: "unknown" });
  assert.equal(activeRouteCard(events)?.id, frozen.card.id);
  assert.throws(() => tool.execute(cardArgs(), execution(agent)), /already active/u);

  events.push({ type: "odai/route-card-consumed", data: { cardId: frozen.card.id } });
  assert.equal(activeRouteCard(events), undefined);

  const replacement = await tool.execute(cardArgs(), execution(agent));
  if (replacement.status !== "frozen") assert.fail("expected a replacement route card");
  assert.throws(
    () => tool.execute({ action: "clear", cardId: frozen.card.id }, execution(agent)),
    /does not match/u,
  );
  assert.equal((await tool.execute({ action: "clear", cardId: replacement.card.id }, execution(agent))).status, "cleared");
  assert.equal(activeRouteCard(events), undefined);
});

test("route-card claims block duplicate attempts and release after receipt or provider failure", () => {
  const card = { id: "card-1", frozen: true };
  const events: DshEvent[] = [{ type: "odai/route-card-frozen", data: { card } }];
  assert.equal(activeRouteCard(events), card);

  events.push({ type: "odai/route-card-claimed", data: { cardId: card.id } });
  assert.equal(activeRouteCard(events), undefined);
  assert.equal(unsettledRouteCard(events), card);
  const tool = createRouteCardTool({
    activeFor: () => activeRouteCard(events),
    unsettledFor: () => unsettledRouteCard(events),
  });
  assert.throws(() => tool.execute(cardArgs(), execution(testAgent())), /already active or claimed/u);
  events.push({ type: "odai/route-card-claim-released", data: { cardId: card.id } });
  assert.equal(activeRouteCard(events), card);

  events.push({ type: "odai/route-card-claimed", data: { cardId: card.id } });
  events.push({ type: "odai/route-card-consumed", data: { cardId: card.id } });
  assert.equal(activeRouteCard(events), undefined);
  assert.equal(unsettledRouteCard(events), undefined);
  assert.equal(routeCardById(events, card.id), card);
  events.push({ type: "odai/route-card-claim-released", data: { cardId: card.id } });
  assert.equal(activeRouteCard(events), card);
  events.push({ type: "odai/route-card-cleared", data: { cardId: card.id } });
  assert.equal(activeRouteCard(events), undefined);
  assert.equal(unsettledRouteCard(events), undefined);
  events.push({ type: "odai/route-card-claim-released", data: { cardId: card.id, reason: "late-provider-failure" } });
  assert.equal(activeRouteCard(events), undefined);
  assert.equal(unsettledRouteCard(events), undefined);
});

test("route cards reject incomplete claims and child mutation", async () => {
  const tool = createRouteCardTool();
  assert.throws(
    () => tool.execute({ ...cardArgs(), evidence: [] }, execution(testAgent())),
    /evidence must be an array/u,
  );
  assert.throws(
    () => tool.execute(cardArgs(), execution(testAgent("subagent"))),
    /child agents may not change/u,
  );
});
