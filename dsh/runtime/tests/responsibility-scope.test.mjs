import assert from "node:assert/strict";
import test from "node:test";

import {
  claimResponsibilityScope,
  createResponsibilityScope,
  latestDanglingResponsibilityScope,
  pendingResponsibilityScopeRestoration,
  responsibilityScopeOwnsRequest,
  responsibilityScopeStopReason,
} from "../src/responsibility-scope.mjs";

const decision = Object.freeze({ reasonCode: "TEST_SCOPE", action: "upgrade" });
const baseRoute = Object.freeze({ provider: "openai", model: "controller", reasoningEffort: "high", maxTokens: 500 });
const roleRoute = Object.freeze({ provider: "openai", model: "planner", reasoningEffort: "xhigh" });

function pendingScope(role = "planner", cardId) {
  return createResponsibilityScope({
    turn: 1,
    startStep: 2,
    role,
    route: roleRoute,
    source: "persisted-mapping",
    decision,
    ...(cardId ? { cardId } : {}),
  });
}

test("responsibility scope claims one explicit route chain", () => {
  const pending = pendingScope();
  assert.equal(pending.state, "pending");
  assert.equal(pending.continuationPolicy, "read-only-tool-chain");
  assert.equal(responsibilityScopeOwnsRequest(pending, 1, 2), true);
  assert.equal(responsibilityScopeOwnsRequest(pending, 1, 1), false);
  assert.equal(responsibilityScopeOwnsRequest(pending, 2, 2), false);

  const active = claimResponsibilityScope(pending, {
    step: 2,
    baseRoute,
    temporaryRoute: roleRoute,
    routeMode: "same-turn",
  });
  assert.equal(active.state, "active");
  assert.deepEqual(active.baseRoute, baseRoute);
  assert.equal(responsibilityScopeOwnsRequest(active, 1, 3), true);
});

test("all in-place responsibilities share terminal, direct-user, and turn ownership boundaries", () => {
  for (const role of ["planner", "reviewer", "executor", "frontend"]) {
    const scope = claimResponsibilityScope(pendingScope(role), {
      step: 2,
      baseRoute,
      temporaryRoute: { ...roleRoute, model: role },
      routeMode: "same-turn",
    });
    assert.equal(
      scope.continuationPolicy,
      ["planner", "reviewer"].includes(role) ? "read-only-tool-chain" : "bounded-work-tool-chain",
      role,
    );
    assert.equal(responsibilityScopeStopReason(scope, {
      type: "assistant/message",
      data: { turn: 1, step: 3, message: { content: [{ type: "text", text: "done" }] } },
    }), "terminal-response", role);
    assert.equal(responsibilityScopeStopReason(scope, {
      type: "agent/inbox/spliced",
      data: { inserted: [{ role: "user", source: { kind: "user" }, content: [] }] },
    }), "direct-user-input", role);
    assert.equal(responsibilityScopeStopReason(scope, {
      type: "turn/end",
      data: { turn: 1 },
    }), "turn-ended", role);
  }
});

test("scope continues only for tool chains and stops at ownership boundaries", () => {
  const scope = claimResponsibilityScope(pendingScope("executor", "card-1"), {
    step: 2,
    baseRoute,
    temporaryRoute: roleRoute,
    routeMode: "same-turn",
  });
  assert.equal(scope.continuationPolicy, "bounded-work-tool-chain");
  assert.equal(responsibilityScopeStopReason(scope, {
    type: "assistant/message",
    data: { turn: 1, step: 2, message: { content: [{ type: "tool-call", name: "read" }] } },
  }), undefined);
  assert.equal(responsibilityScopeStopReason(scope, {
    type: "assistant/message",
    data: { turn: 1, step: 3, message: { content: [{ type: "text", text: "done" }] } },
  }), "terminal-response");
  assert.equal(responsibilityScopeStopReason(scope, {
    type: "agent/inbox/spliced",
    data: { inserted: [{ role: "user", source: { kind: "user" }, content: [] }] },
  }), "direct-user-input");
  assert.equal(responsibilityScopeStopReason(scope, {
    type: "agent/inbox/spliced",
    data: { inserted: [{ role: "user", source: { kind: "tool" }, content: [] }] },
  }), undefined);
  assert.equal(responsibilityScopeStopReason(scope, {
    type: "odai/route-card-consumed",
    data: { cardId: "card-1" },
  }), undefined);
  assert.equal(responsibilityScopeStopReason(scope, {
    type: "odai/route-card-claim-released",
    data: { cardId: "card-1" },
  }), "route-card-released");
  assert.equal(responsibilityScopeStopReason(scope, {
    type: "turn/end",
    data: { turn: 1 },
  }), "turn-ended");
});

test("durable scope evidence recovers the base route once and never revives a stopped scope", () => {
  const events = [
    { type: "odai/responsibility-scope-started", data: { scopeId: "scope-1", role: "reviewer" } },
    {
      type: "odai/responsibility-scope-claimed",
      data: {
        scopeId: "scope-1",
        role: "reviewer",
        baseRoute,
        temporaryRoute: roleRoute,
      },
    },
  ];
  assert.equal(latestDanglingResponsibilityScope(events).scopeId, "scope-1");
  events.push({
    type: "odai/responsibility-scope-stopped",
    data: {
      scopeId: "scope-1",
      role: "reviewer",
      baseRoute,
      temporaryRoute: roleRoute,
      reason: "terminal-response",
    },
  });
  assert.equal(latestDanglingResponsibilityScope(events), undefined);
  assert.equal(pendingResponsibilityScopeRestoration(events).scopeId, "scope-1");
  events.push({ type: "request/header", data: { header: { config: baseRoute }, reason: "change" } });
  assert.equal(pendingResponsibilityScopeRestoration(events), undefined);

  const noEffectiveRequest = events.slice(0, -1);
  noEffectiveRequest.push({
    type: "odai/responsibility-scope-restored",
    data: { scopeId: "scope-1", status: "unverified", stopReason: "no-effective-request" },
  });
  assert.equal(pendingResponsibilityScopeRestoration(noEffectiveRequest), undefined);
});
