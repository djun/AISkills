import assert from "node:assert/strict";
import test from "node:test";

import {
  RESPONSIBILITY_GAP_PROMPT,
  createResponsibilityGapTool,
  resolveResponsibilityGap,
} from "../build/responsibility-gap.mjs";

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
});

test("only the controller can submit a responsibility or user-decision gap", async () => {
  const proposals = [];
  const tool = createResponsibilityGapTool({ onProposed(_agent, proposal) { proposals.push(proposal); } });
  const agent = { session: { header: {} } };
  const result = await tool.execute({
    responsibility: "user",
    gap: "The request does not choose which behavior to preserve.",
    evidenceRefs: ["user-request", "current-contract"],
    expectedChange: "Choose the compatibility boundary.",
    question: "Should the existing API remain backward compatible?",
  }, { agent });
  assert.equal(result.accepted, true);
  assert.equal(result.responsibility, "user");
  assert.deepEqual(tool.output.schema.required, ["accepted", "responsibility", "stateDigest", "next"]);
  assert.match(tool.output.render({}, result)[0].text, /Ask exactly the accepted concise question/u);
  assert.equal(proposals.length, 1);

  const childTool = createResponsibilityGapTool({ isChild: () => true });
  assert.throws(() => childTool.execute({
    responsibility: "planner",
    gap: "A route is unresolved.",
    evidenceRefs: ["source"],
    expectedChange: "Select a route.",
  }, { agent }), /child agents may not own/u);
});
