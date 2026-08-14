import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const pluginRoot = resolve(import.meta.dirname, "..");

test("bundle patch resolves the packaged runtime through the package export", async () => {
  const metadata = JSON.parse(await readFile(resolve(pluginRoot, "package.json"), "utf8"));
  const patch = await readFile(resolve(pluginRoot, "cordis.patch.yml"), "utf8");

  assert.equal(metadata.name, "odai-dsh-plugin");
  assert.equal(metadata.main, "./runtime/index.mjs");
  assert.equal(metadata.dsh.bundle.patch, "./cordis.patch.yml");
  assert.match(patch, /name: odai-dsh-plugin/u);
  assert.match(patch, /mode: auto/u);
  assert.doesNotMatch(patch, /roles:|planner:|executor:|reviewer:|model:|reasoningEffort:|maxTokens:/u);
  assert.doesNotMatch(patch, /name: \.\/runtime/u);
});
