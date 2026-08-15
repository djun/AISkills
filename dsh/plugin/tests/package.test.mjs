import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { spawnDsh } from "../scripts/dsh-process.mjs";

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
  assert.equal(metadata.bin["odai-dsh-plugin"], "./bin/odai-dsh-plugin.mjs");
  assert.equal(metadata.engines.node, ">=22.15.0");
  assert.ok(metadata.files.includes("bin"));
  assert.ok(metadata.files.includes("scripts/dsh-process.mjs"));
  assert.ok(metadata.files.includes("scripts/verify-session-compat.mjs"));
});

test("DSH process spawn supports Windows npm command shims", () => {
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    return {};
  };

  spawnDsh("dsh", ["--profile", "web"], { cwd: pluginRoot }, {
    platform: "win32",
    execute,
  });
  spawnDsh("dsh", ["--profile", "web"], { cwd: pluginRoot }, {
    platform: "linux",
    execute,
  });

  assert.deepEqual(calls, [
    {
      command: "dsh",
      args: ["--profile", "web"],
      options: { cwd: pluginRoot, shell: true },
    },
    {
      command: "dsh",
      args: ["--profile", "web"],
      options: { cwd: pluginRoot },
    },
  ]);
});
