import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  createCompactionConfigTool,
  invalidatePersistedCompactionTarget,
  readCompactionModelStore,
} from "../src/compaction-config.mjs";
import {
  createRoutingConfigTool,
  invalidatePersistedRoleRoute,
  readRoutingStore,
} from "../src/routing-config.mjs";

const execution = { agent: { session: { header: {} } } };

function rejectingResolver(code, message = code) {
  return async () => {
    const error = new Error(message);
    error.code = code;
    throw error;
  };
}

test("responsibility mappings are probed before persistence and invalidated with a backup only on exact match", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-routing-health-"));
  try {
    const path = resolve(root, "routing.json");
    const rejected = createRoutingConfigTool(path, { resolveCallConfig: rejectingResolver("UNKNOWN_MODEL") });
    await assert.rejects(
      rejected.execute({ action: "set", responsibility: "planner", provider: "openai", model: "missing" }, execution),
      (error) => error.code === "UNKNOWN_MODEL" && error.routeFailureKind === "deterministic",
    );
    assert.equal(existsSync(path), false);

    const route = { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "xhigh" };
    const tool = createRoutingConfigTool(path, { resolveCallConfig: async (config) => ({ config }) });
    await tool.execute({ action: "set", responsibility: "planner", ...route }, execution);
    assert.deepEqual(readRoutingStore(path).roles.planner, route);
    assert.equal(invalidatePersistedRoleRoute(path, "planner", { ...route, model: "other" }).invalidated, false);
    const invalidated = invalidatePersistedRoleRoute(path, "planner", route);
    assert.equal(invalidated.invalidated, true);
    assert.equal(existsSync(invalidated.backupPath), true);
    assert.equal(readRoutingStore(path).roles.planner, undefined);
    assert.equal(readdirSync(root).some((name) => name.startsWith("routing.json.invalidated-")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction targets are probed before persistence and exact invalidation restores inheritance", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-compaction-health-"));
  try {
    const path = resolve(root, "compaction.json");
    const rejected = createCompactionConfigTool(path, { resolveCallConfig: rejectingResolver("NO_ADAPTER") });
    await assert.rejects(
      rejected.execute({ action: "set", provider: "missing", model: "summary" }, execution),
      (error) => error.code === "NO_ADAPTER" && error.routeFailureKind === "deterministic",
    );
    assert.equal(existsSync(path), false);

    const target = { provider: "openai", model: "gpt-5.6-luna" };
    const tool = createCompactionConfigTool(path, { resolveCallConfig: async (config) => ({ config }) });
    await tool.execute({ action: "set", ...target }, execution);
    assert.deepEqual(readCompactionModelStore(path).target, target);
    assert.equal(invalidatePersistedCompactionTarget(path, { ...target, model: "other" }).invalidated, false);
    const invalidated = invalidatePersistedCompactionTarget(path, target);
    assert.equal(invalidated.invalidated, true);
    assert.equal(existsSync(invalidated.backupPath), true);
    assert.equal(existsSync(path), false);
    assert.deepEqual(readCompactionModelStore(path), { schemaVersion: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
