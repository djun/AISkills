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
  resolveOutputPolicy,
} from "../src/output-config.mjs";
import { selectSharedOutputPolicyForTurn } from "../src/output-policy-state.mjs";
import { acquireOwnedStoreLock } from "../src/store-lock.mjs";

test("output policy validates explicit user-owned values and renders bounded guidance", () => {
  assert.deepEqual(resolveOutputPolicy({ concise: true }), { concise: true });
  assert.deepEqual(resolveOutputPolicy({ concise: false, maxTokens: 2_500 }), {
    concise: false,
    maxTokens: 2_500,
  });
  assert.throws(() => resolveOutputPolicy({ concise: false }), /would have no effect/u);
  assert.throws(() => resolveOutputPolicy({ concise: true, maxTokens: 0 }), /positive integer/u);
  assert.throws(() => resolveOutputPolicy({ concise: true, model: "forbidden" }), /unknown fields: model/u);
  assert.throws(() => resolveOutputPolicy(Object.create({ concise: true })), /own boolean property/u);
  assert.equal(renderOutputPolicyPrompt({ concise: false }), "");
  assert.match(renderOutputPolicyPrompt({ concise: true }), /never permits omitting required results/u);
  assert.match(renderOutputPolicyPrompt({ concise: false, maxTokens: 2_500 }), /may include reasoning/u);
});

test("output policy store is atomic, repairable, locked, and resettable", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-output-config-"));
  try {
    const configPath = resolve(root, "odai", "output.json");
    const events = [];
    const tool = createOutputConfigTool(configPath, {
      onConfigured(_agent, data) {
        events.push(data);
      },
    });
    const execution = { agent: { session: { header: {} } } };
    const lineageChildTool = createOutputConfigTool(configPath, { isChild: () => true });
    assert.throws(
      () => lineageChildTool.execute({ action: "set", concise: true }, execution),
      /child agents may not change/u,
    );

    assert.deepEqual(effectiveOutputPolicy(configPath), {
      policy: { concise: false },
      source: "default",
    });
    const hardOnly = await tool.execute({ action: "set", concise: false, maxTokens: 2_500 }, execution);
    assert.deepEqual(hardOnly.policy, { concise: false, maxTokens: 2_500 });
    assert.deepEqual(readOutputPolicyStore(configPath).policy, { concise: false, maxTokens: 2_500 });
    assert.match(tool.output.render({}, hardOnly)[0].text, /concise=off, maxTokens=2500/u);

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
    assert.deepEqual(removed.policy, { concise: false });
    assert.equal(removed.source, "default");
    assert.equal(events.length, 3);
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
    const execution = { agent: { session: { header: {} } } };
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
  const agent = {};
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
