import assert from "node:assert/strict";
import test from "node:test";

import {
  RESPONSIBILITY_GAP_PROMPT,
  createResponsibilityGapTool,
  resolveResponsibilityGap,
} from "../build/responsibility-gap.mjs";
import type { DshAgent } from "../build/runtime-types.mjs";

test("responsibility gaps are structured, grounded, and content addressed", () => {
  const proposal = resolveResponsibilityGap({
    responsibility: "planner",
    gap: "Two public contract routes remain possible.",
    evidenceRefs: ["read:api.md", "read:implementation.mjs"],
    expectedChange: "Select the compatible contract before implementation.",
  });
  assert.match(proposal.stateDigest, /^[a-f0-9]{64}$/u);
  assert.equal(proposal.responsibility, "planner");
  assert.throws(() => resolveResponsibilityGap({
    responsibility: "planner",
    gap: "Task is complex.",
    evidenceRefs: [],
    expectedChange: "Maybe help.",
  }), /1 to 12/u);
  assert.throws(() => resolveResponsibilityGap({
    responsibility: "user",
    gap: "Priority changes the route.",
    evidenceRefs: ["user-request"],
    expectedChange: "Choose compatibility or speed.",
  }), /question is required/u);
  assert.match(RESPONSIBILITY_GAP_PROMPT, /never need to request internal roles/iu);
  assert.match(RESPONSIBILITY_GAP_PROMPT, /Do not ask users for repository facts/iu);
  assert.match(RESPONSIBILITY_GAP_PROMPT, /independently deployed contracts/iu);
  assert.match(RESPONSIBILITY_GAP_PROMPT, /authentication or state-machine changes/iu);
  assert.match(RESPONSIBILITY_GAP_PROMPT, /rollout-order compatibility/iu);
  assert.match(RESPONSIBILITY_GAP_PROMPT, /rollback boundaries/iu);
  assert.match(RESPONSIBILITY_GAP_PROMPT, /never replace native acceptance, write, diff, or test evidence/iu);
});

test("only the controller can submit a responsibility or user-decision gap", async () => {
  const proposals: ReturnType<typeof resolveResponsibilityGap>[] = [];
  const tool = createResponsibilityGapTool({ onProposed(_agent, proposal) { proposals.push(proposal); } });
  const agent: DshAgent = { session: { header: {}, events: [], append() {} } };
  const result = await tool.execute({
    responsibility: "user",
    gap: "The request does not choose which behavior to preserve.",
    evidenceRefs: ["user-request", "current-contract"],
    expectedChange: "Choose the compatibility boundary.",
    question: "Should the existing API remain backward compatible?",
  }, { name: "odai_responsibility_gap", agent });
  assert.equal(result.recorded, true);
  assert.equal("accepted" in result, false);
  assert.equal(result.responsibility, "user");
  assert.ok(tool.output);
  assert.deepEqual(tool.output.schema.required, ["recorded", "responsibility", "stateDigest", "next"]);
  const outputProperties = tool.output.schema.properties as Record<string, unknown>;
  assert.equal("recorded" in outputProperties, true);
  assert.equal("accepted" in outputProperties, false);
  const rendered = tool.output.render({}, result)[0]?.text;
  assert.ok(rendered);
  assert.match(rendered, /Recorded user gap/u);
  assert.match(rendered, /has not been routed or started/u);
  assert.match(rendered, /Ask exactly the accepted concise question/u);
  const plannerResult = await tool.execute({
    responsibility: "planner",
    gap: "Independent rollout contracts can change implementation order.",
    evidenceRefs: ["user-rollout-requirement", "current-api-contract"],
    expectedChange: "Freeze compatibility and rollback acceptance before edits.",
  }, { name: "odai_responsibility_gap", agent });
  const plannerRendered = tool.output.render({}, plannerResult)[0]?.text;
  assert.ok(plannerRendered);
  assert.match(plannerRendered, /Recorded planner gap/u);
  assert.match(plannerRendered, /not been routed or started/u);
  assert.match(plannerRendered, /will reassess the recorded proposal/u);
  assert.equal(proposals.length, 2);

  const childTool = createResponsibilityGapTool({ isChild: () => true });
  assert.throws(() => childTool.execute({
    responsibility: "planner",
    gap: "A route is unresolved.",
    evidenceRefs: ["source"],
    expectedChange: "Select a route.",
  }, { name: "odai_responsibility_gap", agent }), /child agents may not own/u);
});
