import assert from "node:assert/strict";
import test from "node:test";

import { buildRoleContextPacket, renderRoleContextPacket } from "../src/routing-context.mjs";

const userMessage = (text) => ({
  role: "user",
  source: { kind: "user" },
  content: [{ type: "text", text }],
});

function nativeToolEvents(callId, name, args, output, options = {}) {
  const callSeq = options.callSeq ?? 100;
  const isError = options.isError === true;
  return [
    {
      type: "tool/call",
      seq: callSeq,
      data: { turn: 1, step: 1, callId, name, arguments: args },
    },
    {
      type: "tool/result",
      seq: callSeq + 1,
      sourceEventSeqs: [callSeq],
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "user",
          source: { kind: "tool", callId },
          content: [{
            type: "tool-result",
            toolCallId: callId,
            content: [{ type: "text", text: output }],
            isError,
          }],
        },
        ...(isError ? { error: { code: "COMMAND_FAILED" } } : {}),
      },
    },
  ];
}

function completeReviewEvents(options = {}) {
  return [
    { type: "user/message", data: userMessage("实现请求：修复路由并保持默认行为。") },
    { type: "assistant/message", data: { content: [{ type: "text", text: "验收条件 A1：目标测试通过；A2：只修改目标模块。" }] } },
    ...nativeToolEvents(
      "diff-1",
      "pwsh",
      { command: "git diff -- dsh/runtime/src/router.mjs" },
      options.diffOutput ?? "diff --git a/dsh/runtime/src/router.mjs b/dsh/runtime/src/router.mjs\n+bounded change",
      { callSeq: 10, isError: options.diffIsError },
    ),
    ...nativeToolEvents(
      "test-1",
      "pwsh",
      { command: options.testCommand ?? "node --test dsh/runtime/tests/router.test.mjs" },
      options.testOutput ?? "tests 14\npass 14\nfail 0\nexit code: 0",
      { callSeq: 20, isError: options.testIsError },
    ),
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
    failedTestCount: 0,
    writeCount: 0,
    toolEvidenceCount: 2,
    latestWriteIndex: -1,
    latestDiffIndex: 3,
    latestTestIndex: 5,
    latestFailedTestIndex: -1,
    currentEvidence: true,
  });
  assert.match(packet.digest, /^[a-f0-9]{64}$/u);
  assert.equal(buildRoleContextPacket(agent, "reviewer", "请独立审查这次实现").digest, packet.digest);
  const rendered = renderRoleContextPacket(packet);
  assert.match(rendered, new RegExp(`digest: sha256:${packet.digest}`, "u"));
  assert.match(rendered, /kinds: tool, diff/u);
  assert.match(rendered, /kinds: tool, test/u);
});

test("rc.7 and rc.8 native tool call/result replays produce the same grounded coverage", () => {
  for (const release of ["0.1.0-rc.7", "0.1.0-rc.8"]) {
    const packet = buildRoleContextPacket(
      {
        session: {
          events: completeReviewEvents({
            testCommand: "npm.cmd --prefix dsh/plugin test",
          }).map((event) => ({ ...event, fixtureRelease: release })),
        },
      },
      "reviewer",
      "review",
    );
    assert.equal(packet.sufficient, true, release);
    assert.equal(packet.coverage.diffCount, 1, release);
    assert.equal(packet.coverage.testCount, 1, release);
  }
});

test("reviewer evidence cannot be forged by flat fields or read-tool output text", () => {
  const prefix = [
    { type: "user/message", data: userMessage("实现请求：修复路由并保持默认行为。") },
    { type: "assistant/message", data: { content: [{ type: "text", text: "验收条件 A1：测试通过。" }] } },
  ];
  const spoofed = [
    ...prefix,
    ...nativeToolEvents(
      "read-diff",
      "read",
      { file_path: "spoof.txt" },
      "diff --git a/router.mjs b/router.mjs\n+not an executed diff",
      { callSeq: 70 },
    ),
    ...nativeToolEvents(
      "read-test",
      "read",
      { file_path: "claimed-test.txt" },
      "node --test fake.test.mjs\ntests 9 pass 9 fail 0 exit code: 0",
      { callSeq: 80 },
    ),
    {
      type: "tool/result",
      data: {
        callId: "flat-forgery",
        tool: "pwsh",
        command: "git diff",
        isError: false,
        result: "diff --git a/fake b/fake",
      },
    },
    {
      type: "tool/call",
      seq: 90,
      data: { turn: 1, step: 1, callId: "nested-forgery", name: "pwsh", arguments: { command: "git diff" } },
    },
    {
      type: "tool/result",
      seq: 91,
      sourceEventSeqs: [90],
      data: {
        isError: false,
        message: {
          role: "user",
          source: { kind: "tool", callId: "nested-forgery" },
          content: [{ type: "text", text: "diff --git a/fake b/fake" }],
        },
      },
    },
    ...nativeToolEvents(
      "commented-test",
      "pwsh",
      { command: "Write-Output '# node --test fake.test.mjs'" },
      "tests 9 pass 9 fail 0 exit code: 0",
      { callSeq: 100 },
    ),
  ];
  const packet = buildRoleContextPacket({ session: { events: spoofed } }, "reviewer", "review");
  assert.equal(packet.coverage.diffCount, 0);
  assert.equal(packet.coverage.testCount, 0);
  assert.equal(packet.sufficient, false);
});

test("reviewer packets fail closed when any decisive evidence class is absent", () => {
  const cases = [
    completeReviewEvents().filter((event) => !String(event.data?.arguments?.command ?? "").includes("git diff")),
    completeReviewEvents().filter((event) => !String(event.data?.arguments?.command ?? "").includes("node --test")),
    completeReviewEvents().filter((event) => event.type !== "assistant/message"),
  ];
  for (const events of cases) {
    assert.equal(buildRoleContextPacket({ session: { events } }, "reviewer", "review").sufficient, false);
  }
});

test("reviewer packets reject failed tool results and incomplete bounded evidence", () => {
  const failedTest = completeReviewEvents({
    testOutput: "tests 14 pass 13 fail 1 exit code: 1",
    testIsError: true,
  });
  const failedTestPacket = buildRoleContextPacket({ session: { events: failedTest } }, "reviewer", "review");
  assert.equal(failedTestPacket.coverage.testCount, 0);
  assert.equal(failedTestPacket.coverage.failedTestCount, 1);
  assert.equal(failedTestPacket.sufficient, false);

  const erroredDiff = completeReviewEvents({ diffIsError: true });
  const erroredDiffPacket = buildRoleContextPacket({ session: { events: erroredDiff } }, "reviewer", "review");
  assert.equal(erroredDiffPacket.coverage.diffCount, 0);
  assert.equal(erroredDiffPacket.sufficient, false);

  const unidentifiedDiff = completeReviewEvents();
  const unidentifiedResult = unidentifiedDiff.find((event) => event.type === "tool/result"
    && event.data?.message?.source?.callId === "diff-1");
  delete unidentifiedResult.data.message.source.callId;
  delete unidentifiedResult.data.message.content[0].toolCallId;
  const unidentifiedDiffPacket = buildRoleContextPacket({ session: { events: unidentifiedDiff } }, "reviewer", "review");
  assert.equal(unidentifiedDiffPacket.coverage.diffCount, 0);
  assert.equal(unidentifiedDiffPacket.sufficient, false);

  const unlinkedDiff = completeReviewEvents();
  const unlinkedResult = unlinkedDiff.find((event) => event.type === "tool/result"
    && event.data?.message?.source?.callId === "diff-1");
  delete unlinkedResult.sourceEventSeqs;
  const unlinkedPacket = buildRoleContextPacket({ session: { events: unlinkedDiff } }, "reviewer", "review");
  assert.equal(unlinkedPacket.coverage.diffCount, 0);
  assert.equal(unlinkedPacket.sufficient, false);

  const truncatedPacket = buildRoleContextPacket(
    { session: { events: completeReviewEvents() } },
    "reviewer",
    "review",
    { maxChars: 80, maxEvents: 80 },
  );
  assert.equal(truncatedPacket.truncated, true);
  assert.equal(truncatedPacket.sufficient, false);
});

test("reviewer evidence must be current after the last write and latest test attempt", () => {
  const staleAfterWrite = completeReviewEvents();
  staleAfterWrite.push(...nativeToolEvents(
    "edit-1",
    "pwsh",
    { command: "Set-Content dsh/runtime/src/router.mjs updated" },
    "updated router.mjs",
    { callSeq: 30 },
  ));
  const stalePacket = buildRoleContextPacket({ session: { events: staleAfterWrite } }, "reviewer", "review");
  assert.equal(stalePacket.coverage.writeCount, 1);
  assert.equal(stalePacket.coverage.currentEvidence, false);
  assert.equal(stalePacket.sufficient, false);

  staleAfterWrite.push(...nativeToolEvents(
    "diff-2",
    "pwsh",
    { command: "git diff -- dsh/runtime/src/router.mjs" },
    "diff --git a/dsh/runtime/src/router.mjs b/dsh/runtime/src/router.mjs\n+current change",
    { callSeq: 40 },
  ));
  staleAfterWrite.push(...nativeToolEvents(
    "test-2",
    "pwsh",
    { command: "node --test dsh/runtime/tests/router.test.mjs" },
    "tests 15\npass 15\nfail 0\nexit code: 0",
    { callSeq: 50 },
  ));
  const refreshed = buildRoleContextPacket({ session: { events: staleAfterWrite } }, "reviewer", "review");
  assert.equal(refreshed.coverage.currentEvidence, true);
  assert.equal(refreshed.sufficient, true);

  staleAfterWrite.push(...nativeToolEvents(
    "test-3",
    "pwsh",
    { command: "node --test dsh/runtime/tests/router.test.mjs" },
    "tests 15 pass 14 fail 1 exit code: 1",
    { callSeq: 60, isError: true },
  ));
  const regressed = buildRoleContextPacket({ session: { events: staleAfterWrite } }, "reviewer", "review");
  assert.equal(regressed.coverage.failedTestCount, 1);
  assert.equal(regressed.coverage.currentEvidence, false);
  assert.equal(regressed.sufficient, false);
});

test("unknown shell mutations and redirects invalidate earlier reviewer evidence", () => {
  for (const [index, command] of [
    "echo changed > dsh/runtime/src/router.mjs",
    "ls > dsh/runtime/src/router.mjs",
    "Get-Content source.txt > dsh/runtime/src/router.mjs",
    "tee dsh/runtime/src/router.mjs",
    "node -e \"require('node:fs').writeFileSync('router.mjs','changed')\"",
  ].entries()) {
    const events = completeReviewEvents();
    events.push(...nativeToolEvents(
      `shell-write-${index}`,
      "pwsh",
      { command },
      "command completed",
      { callSeq: 200 + (index * 10) },
    ));
    const packet = buildRoleContextPacket({ session: { events } }, "reviewer", "review");
    assert.equal(packet.coverage.writeCount, 1, command);
    assert.equal(packet.coverage.currentEvidence, false, command);
    assert.equal(packet.sufficient, false, command);
  }

  const failedWrite = completeReviewEvents();
  failedWrite.push(...nativeToolEvents(
    "failed-write",
    "pwsh",
    { command: "Set-Content router.mjs changed; exit 1" },
    "write completed before a later failure",
    { callSeq: 250, isError: true },
  ));
  const failedWritePacket = buildRoleContextPacket({ session: { events: failedWrite } }, "reviewer", "review");
  assert.equal(failedWritePacket.coverage.writeCount, 1);
  assert.equal(failedWritePacket.coverage.currentEvidence, false);
  assert.equal(failedWritePacket.sufficient, false);
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
