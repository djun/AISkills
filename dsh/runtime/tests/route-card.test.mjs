import assert from "node:assert/strict";
import test from "node:test";

import { ROUTE_CARD_PROMPT, activeRouteCard, createRouteCardTool } from "../src/route-card.mjs";

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
  assert.doesNotMatch(ROUTE_CARD_PROMPT, /task size alone never justifies delegation/u);
});

test("route cards freeze, expose, consume, and clear exactly once", async () => {
  const events = [];
  const agent = {};
  const tool = createRouteCardTool({
    activeFor() { return activeRouteCard(events); },
    onFrozen(_agent, card) { events.push({ type: "odai/route-card-frozen", data: { card } }); },
    onCleared(_agent, cardId) { events.push({ type: "odai/route-card-cleared", data: { cardId } }); },
  });

  const frozen = await tool.execute(cardArgs(), { agent });
  assert.equal(frozen.status, "frozen");
  assert.match(frozen.card.id, /^[a-f0-9-]{36}$/u);
  assert.equal(activeRouteCard(events).id, frozen.card.id);
  assert.throws(() => tool.execute(cardArgs(), { agent }), /already active/u);

  events.push({ type: "odai/route-card-consumed", data: { cardId: frozen.card.id } });
  assert.equal(activeRouteCard(events), undefined);

  const replacement = await tool.execute(cardArgs(), { agent });
  assert.throws(
    () => tool.execute({ action: "clear", cardId: frozen.card.id }, { agent }),
    /does not match/u,
  );
  assert.equal((await tool.execute({ action: "clear", cardId: replacement.card.id }, { agent })).status, "cleared");
  assert.equal(activeRouteCard(events), undefined);
});

test("route cards reject incomplete claims and child mutation", async () => {
  const tool = createRouteCardTool();
  assert.throws(
    () => tool.execute({ ...cardArgs(), evidence: [] }, { agent: {} }),
    /evidence must be an array/u,
  );
  assert.throws(
    () => tool.execute(cardArgs(), { agent: { session: { header: { origin: "subagent" } } } }),
    /child agents may not change/u,
  );
});
