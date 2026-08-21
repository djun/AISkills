import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  createOutputConfigTool,
  effectiveOutputPolicy,
  readOutputPolicyStore,
  renderOutputPolicyPrompt,
  resolveInPlaceResponsibilityOutputBudgets,
  resolveOutputPolicy,
} from "../build/output-config.mjs";
import { selectSharedOutputPolicyForTurn } from "../build/output-policy-state.mjs";
import { acquireOwnedStoreLock } from "../build/store-lock.mjs";
import type { DshAgent, ToolExecution } from "../build/runtime-types.mjs";

function testExecution(): ToolExecution {
  return { name: "odai_output_config", agent: { session: { header: {}, events: [], append() {} } } };
}

test("output policy validates explicit user-owned values and renders bounded guidance", () => {
  assert.deepEqual(resolveOutputPolicy({ concise: true }), { concise: true });
  assert.deepEqual(resolveOutputPolicy({ concise: false }), { concise: false });
  assert.deepEqual(resolveOutputPolicy({ concise: false, maxTokens: 2_500 }), {
    concise: false,
    maxTokens: 2_500,
  });
  assert.throws(() => resolveOutputPolicy({ concise: true, maxTokens: 0 }), /positive integer/u);
  assert.throws(() => resolveOutputPolicy({ concise: true, model: "forbidden" }), /unknown fields: model/u);
  assert.throws(() => resolveOutputPolicy(Object.create({ concise: true })), /own boolean property/u);
  assert.equal(renderOutputPolicyPrompt({ concise: false }), "");
  assert.match(renderOutputPolicyPrompt({ concise: true }), /never permits omitting required results/u);
  assert.match(renderOutputPolicyPrompt({ concise: true }), /never reduces child-agent, compaction, checkpoint/u);
  assert.match(renderOutputPolicyPrompt({ concise: false, maxTokens: 2_500 }), /provider enforcement is not guaranteed/iu);
});

test("in-place responsibility budgets report unconfigured, inherited, and explicit ceilings", () => {
  assert.equal(resolveInPlaceResponsibilityOutputBudgets({ concise: true }, undefined), undefined);
  assert.deepEqual(
    resolveInPlaceResponsibilityOutputBudgets({ concise: true }, {
      planner: { provider: "planner", model: "model" },
      researcher: { provider: "researcher", model: "model", maxTokens: 512 },
    }),
    { planner: { source: "unbounded-by-odai" } },
  );
  assert.deepEqual(
    resolveInPlaceResponsibilityOutputBudgets({ concise: true, maxTokens: 500 }, {
      planner: { provider: "planner", model: "model" },
      executor: { provider: "executor", model: "model", maxTokens: 8_192 },
      frontend: { provider: "frontend", model: "model", maxTokens: 16_384 },
      reviewer: { provider: "reviewer", model: "model" },
    }),
    {
      planner: {
        source: "controller-policy",
        maxTokens: 500,
        warning: "responsibility-inherits-controller-ceiling",
      },
      executor: { source: "responsibility-override", maxTokens: 8_192 },
      frontend: { source: "responsibility-override", maxTokens: 16_384 },
    },
  );
});

test("output policy store is atomic, repairable, locked, and resettable", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-output-config-"));
  try {
    const configPath = resolve(root, "odai", "output.json");
    const events: unknown[] = [];
    const tool = createOutputConfigTool(configPath, {
      onConfigured(_agent, data) {
        events.push(data);
      },
    });
    assert.ok(tool.description);
    assert.match(tool.description, /economy mode.*defaults to 500/u);
    assert.match(tool.description, /Remove restores soft concise/u);
    const execution = testExecution();
    const lineageChildTool = createOutputConfigTool(configPath, { isChild: () => true });
    assert.throws(
      () => lineageChildTool.execute({ action: "set", concise: true }, execution),
      /child agents may not change/u,
    );

    mkdirSync(resolve(root, "odai"), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify({
      schemaVersion: 1,
      policy: { concise: false, maxTokens: 2_500 },
    })}\n`, "utf8");
    assert.deepEqual(readOutputPolicyStore(configPath).policy, { concise: false, maxTokens: 2_500 });
    rmSync(configPath);

    assert.deepEqual(effectiveOutputPolicy(configPath), {
      policy: { concise: true },
      source: "default",
    });
    const normal = await tool.execute({ action: "set", mode: "normal" }, execution);
    assert.deepEqual(normal.policy, { concise: false });
    assert.deepEqual(readOutputPolicyStore(configPath).policy, { concise: false });
    const concise = await tool.execute({ action: "set", mode: "concise" }, execution);
    assert.deepEqual(concise.policy, { concise: true });
    assert.deepEqual(readOutputPolicyStore(configPath).policy, { concise: true });
    const economy = await tool.execute({ action: "set", mode: "economy" }, execution);
    assert.deepEqual(economy.policy, { concise: true, maxTokens: 500 });
    assert.deepEqual(readOutputPolicyStore(configPath).policy, { concise: true, maxTokens: 500 });
    const adjustedEconomy = await tool.execute({
      action: "set",
      mode: "economy",
      maxTokens: 1_200,
    }, execution);
    assert.deepEqual(adjustedEconomy.policy, { concise: true, maxTokens: 1_200 });
    assert.deepEqual(readOutputPolicyStore(configPath).policy, { concise: true, maxTokens: 1_200 });
    assert.ok(tool.output);
    const rendered = tool.output.render({}, adjustedEconomy)[0]?.text;
    assert.ok(rendered);
    assert.match(rendered, /concise=on, maxTokens=1200/u);
    assert.match(rendered, /strict provider compliance is not guaranteed/u);
    assert.throws(
      () => tool.execute({ action: "set", mode: "normal", maxTokens: 500 }, execution),
      /accepted only with economy mode/u,
    );
    assert.throws(
      () => tool.execute({ action: "set", concise: false, maxTokens: 2_500 }, execution),
      /requires concise=true or mode=economy/u,
    );

    mkdirSync(resolve(root, "odai"), { recursive: true });
    writeFileSync(configPath, "{broken\n", "utf8");
    assert.throws(() => tool.execute({ action: "show" }, execution), /not valid JSON/u);
    const repaired = await tool.execute({ action: "set", concise: true }, execution);
    assert.equal(repaired.recoveredInvalidStore, true);
    assert.equal(readdirSync(resolve(root, "odai")).some((entry) => entry.startsWith("output.json.invalid-")), true);

    writeFileSync(`${configPath}.lock`, "other-process\n", "utf8");
    assert.throws(
      () => tool.execute({ action: "set", concise: true, maxTokens: 3_000 }, execution),
      /being updated; retry/u,
    );
    rmSync(`${configPath}.lock`, { force: true });

    const removed = await tool.execute({ action: "remove" }, execution);
    assert.deepEqual(removed.policy, { concise: true });
    assert.equal(removed.source, "default");
    assert.equal(events.length, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("output policy store fails closed on unreadable state instead of repairing it", () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-output-unreadable-"));
  try {
    const configPath = resolve(root, "output-as-directory");
    mkdirSync(configPath);
    const tool = createOutputConfigTool(configPath);
    const execution = testExecution();
    assert.throws(
      () => tool.execute({ action: "set", concise: true }, execution),
      /could not be read safely; no changes were made/u,
    );
    assert.equal(existsSync(configPath), true);
    assert.equal(readdirSync(root).some((entry) => entry.startsWith("output-as-directory.invalid-")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owned store locks reject live writers, reclaim dead owners, and preserve successors", () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-output-lock-"));
  try {
    const configPath = resolve(root, "odai", "output.json");
    mkdirSync(resolve(root, "odai"), { recursive: true });
    const lockPath = `${configPath}.lock`;
    writeFileSync(lockPath, `${process.pid}:live-owner\n`, "utf8");
    assert.throws(
      () => acquireOwnedStoreLock(configPath, "Odai output configuration"),
      /is being updated; retry/u,
    );
    rmSync(lockPath);

    writeFileSync(lockPath, "2147483647:dead-owner\n", "utf8");
    const releaseDeadReplacement = acquireOwnedStoreLock(configPath, "Odai output configuration");
    releaseDeadReplacement();
    assert.equal(existsSync(lockPath), false);

    const release = acquireOwnedStoreLock(configPath, "Odai output configuration");
    writeFileSync(lockPath, `${process.pid}:successor\n`, "utf8");
    assert.throws(() => release(), /ownership changed before release/u);
    assert.equal(existsSync(lockPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("output policy selection is single-flight for one agent turn", async () => {
  const agent: DshAgent = { session: { header: {}, events: [], append() {} } };
  let selections = 0;
  const select = async () => {
    selections += 1;
    return { policy: { concise: true }, source: "persisted" };
  };

  const [first, second] = await Promise.all([
    selectSharedOutputPolicyForTurn(agent, 1, select),
    selectSharedOutputPolicyForTurn(agent, 1, select),
  ]);
  assert.equal(selections, 1);
  assert.equal(first, second);
  await selectSharedOutputPolicyForTurn(agent, 2, select);
  assert.equal(selections, 2);
});
