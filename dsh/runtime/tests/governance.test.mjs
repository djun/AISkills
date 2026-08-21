import assert from "node:assert/strict";
import test from "node:test";

import {
  activeRouteProtection,
  createChildToolGuard,
  createRouteProtectionGuard,
  isSubagent,
  summarizeToolResult,
} from "../build/governance.mjs";

const controller = { session: { header: {} } };
const child = { session: { header: { origin: "subagent", delegationDepth: 1 } } };

test("subagent detection uses durable lineage", () => {
  assert.equal(isSubagent(controller), false);
  assert.equal(isSubagent(child), true);
});

test("guard denies child writes before dispatch but leaves controller writes alone", () => {
  const denied = [];
  const guard = createChildToolGuard({ onDenied: (execution) => denied.push(execution.name) });

  assert.equal(guard({ agent: controller, name: "write" }), undefined);
  assert.match(guard({ agent: child, name: "write" }), /^ODAI_SUBAGENT_BOUNDARY:/u);
  assert.equal(guard({ agent: child, name: "read" }), undefined);
  assert.deepEqual(denied, ["write"]);
});

test("additional denials are monotonic", () => {
  const guard = createChildToolGuard({ additionalDeniedTools: ["web_fetch"] });
  assert.match(guard({ agent: child, name: "web_fetch" }), /^ODAI_SUBAGENT_BOUNDARY:/u);
  assert.match(guard({ agent: child, name: "bash" }), /^ODAI_SUBAGENT_BOUNDARY:/u);
});

test("high-impact route protection denies controller mutations only for the active turn", () => {
  const denied = [];
  const protectedController = {
    session: {
      header: {},
      events: [
        { type: "odai/route-decided", data: { turn: 1, step: 1 } },
        {
          type: "odai/route-protection",
          data: {
            turn: 1,
            step: 1,
            mode: "read-only",
            reasonCode: "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE",
            scopeId: "scope-1",
          },
        },
      ],
    },
  };
  const guard = createRouteProtectionGuard({
    onDenied: (execution) => denied.push(execution.name),
  });

  assert.equal(activeRouteProtection(protectedController)?.turn, 1);
  assert.match(guard({ agent: protectedController, name: "write" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
  assert.match(guard({ agent: protectedController, name: "bash" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
  assert.match(guard({ agent: protectedController, name: "subagent" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
  assert.match(guard({ agent: protectedController, name: "future_side_effect" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
  assert.equal(guard({ agent: protectedController, name: "read" }), undefined);
  assert.equal(guard({ agent: protectedController, name: "ask_user_question" }), undefined);
  assert.equal(guard({ agent: protectedController, name: "web_fetch" }), undefined);
  assert.deepEqual(denied, ["write", "bash", "subagent", "future_side_effect"]);

  const restrictedGuard = createRouteProtectionGuard({ additionalDeniedTools: ["web_fetch"] });
  assert.match(restrictedGuard({ agent: protectedController, name: "web_fetch" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);

  protectedController.session.events.push({
    type: "odai/route-protection-released",
    data: { turn: 1, scopeId: "scope-1", reason: "terminal-response" },
  });
  assert.equal(activeRouteProtection(protectedController), undefined);
  assert.equal(guard({ agent: protectedController, name: "write" }), undefined);

  protectedController.session.events.push({
    type: "odai/route-decided",
    data: { turn: 2, step: 1, reasonCode: "DIRECT_DEFAULT_NO_INDEPENDENT_GAP" },
  });
  assert.equal(activeRouteProtection(protectedController), undefined);
  assert.equal(guard({ agent: protectedController, name: "write" }), undefined);
});

test("tool summaries retain evidence identity without arguments or output", () => {
  assert.deepEqual(summarizeToolResult({
    callId: "call-1",
    rootCallId: "root-1",
    name: "read",
    agent: child,
  }, { isError: false }), {
    callId: "call-1",
    rootCallId: "root-1",
    tool: "read",
    child: true,
    isError: false,
  });
});
