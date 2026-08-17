import assert from "node:assert/strict";
import test from "node:test";

import { buildRoleContextPacket, renderRoleContextPacket } from "../src/routing-context.mjs";

const userMessage = (text) => ({
  role: "user",
  source: { kind: "user" },
  content: [{ type: "text", text }],
});

function completeReviewEvents() {
  return [
    { type: "user/message", data: userMessage("实现请求：修复路由并保持默认行为。") },
    { type: "assistant/message", data: { content: [{ type: "text", text: "验收条件 A1：目标测试通过；A2：只修改目标模块。" }] } },
    {
      type: "tool/result",
      data: {
        callId: "diff-1",
        tool: "bash",
        isError: false,
        command: "git diff -- dsh/runtime/src/router.mjs",
        result: "diff --git a/dsh/runtime/src/router.mjs b/dsh/runtime/src/router.mjs\n+bounded change",
      },
    },
    {
      type: "tool/result",
      data: {
        callId: "test-1",
        tool: "bash",
        isError: false,
        command: "node --test dsh/runtime/tests/router.test.mjs",
        result: "tests 14\npass 14\nfail 0\nexit code: 0",
      },
    },
  ];
}

test("reviewer packets require requirements, acceptance, diff, tests, and tool evidence", () => {
  const agent = { session: { events: completeReviewEvents() } };
  const packet = buildRoleContextPacket(agent, "reviewer", "请独立审查这次实现");

  assert.equal(packet.sufficient, true);
  assert.deepEqual(packet.coverage, {
    requirements: true,
    acceptanceCount: 1,
    diffCount: 1,
    testCount: 1,
    toolEvidenceCount: 2,
  });
  assert.match(packet.digest, /^[a-f0-9]{64}$/u);
  assert.equal(buildRoleContextPacket(agent, "reviewer", "请独立审查这次实现").digest, packet.digest);
  const rendered = renderRoleContextPacket(packet);
  assert.match(rendered, new RegExp(`digest: sha256:${packet.digest}`, "u"));
  assert.match(rendered, /kinds: tool, diff/u);
  assert.match(rendered, /kinds: tool, test/u);
});

test("reviewer packets fail closed when any decisive evidence class is absent", () => {
  const cases = [
    completeReviewEvents().filter((event) => !String(event.data?.command ?? "").includes("git diff")),
    completeReviewEvents().filter((event) => !String(event.data?.command ?? "").includes("node --test")),
    completeReviewEvents().filter((event) => event.type !== "assistant/message"),
  ];
  for (const events of cases) {
    assert.equal(buildRoleContextPacket({ session: { events } }, "reviewer", "review").sufficient, false);
  }
});

test("reviewer packets reject failed tool results and incomplete bounded evidence", () => {
  const failedTest = completeReviewEvents();
  failedTest[3] = {
    ...failedTest[3],
    data: {
      ...failedTest[3].data,
      result: "tests 14 pass 13 fail 1 exit code: 1",
    },
  };
  const failedTestPacket = buildRoleContextPacket({ session: { events: failedTest } }, "reviewer", "review");
  assert.equal(failedTestPacket.coverage.testCount, 0);
  assert.equal(failedTestPacket.sufficient, false);

  const erroredDiff = completeReviewEvents();
  erroredDiff[2] = { ...erroredDiff[2], data: { ...erroredDiff[2].data, isError: true } };
  const erroredDiffPacket = buildRoleContextPacket({ session: { events: erroredDiff } }, "reviewer", "review");
  assert.equal(erroredDiffPacket.coverage.diffCount, 0);
  assert.equal(erroredDiffPacket.sufficient, false);

  const unidentifiedDiff = completeReviewEvents();
  delete unidentifiedDiff[2].data.callId;
  const unidentifiedDiffPacket = buildRoleContextPacket({ session: { events: unidentifiedDiff } }, "reviewer", "review");
  assert.equal(unidentifiedDiffPacket.coverage.diffCount, 0);
  assert.equal(unidentifiedDiffPacket.sufficient, false);

  const truncatedPacket = buildRoleContextPacket(
    { session: { events: completeReviewEvents() } },
    "reviewer",
    "review",
    { maxChars: 80, maxEvents: 80 },
  );
  assert.equal(truncatedPacket.truncated, true);
  assert.equal(truncatedPacket.sufficient, false);
});

test("role context packets bound task and evidence text", () => {
  const long = "x".repeat(10_000);
  const packet = buildRoleContextPacket({
    session: {
      events: [{ type: "assistant/message", data: { content: [{ type: "text", text: long }] } }],
    },
  }, "planner", long, { maxChars: 1_000, maxEvents: 1 });

  assert.equal(packet.sufficient, true);
  assert.equal(packet.truncated, true);
  assert.ok(packet.currentTask.length + packet.entries.reduce((sum, entry) => sum + entry.text.length, 0) <= 1_000);
});
