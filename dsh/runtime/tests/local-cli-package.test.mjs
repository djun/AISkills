import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");
for (const [surface, packagePath, runtimePath] of [
  ["plugin", "dsh/plugin/package.json", "runtime"],
  ["agent preset", "dsh/agent/preset/odai/package.json", "preset/odai/runtime"],
]) {
  test(`${surface} resolves local CLI from its own packaged skill copy`, async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), "odai-local-cli-import-"));
    try {
      const runtime = resolve(temporary, runtimePath);
      const packageRoot = dirname(runtime);
      await mkdir(runtime, { recursive: true });
      await writeFile(resolve(packageRoot, "package.json"), await readFile(resolve(root, packagePath)));
      const scripts = resolve(packageRoot, "skills/odai-orchestration/scripts");
      await mkdir(scripts, { recursive: true });
      await cp(resolve(root, "skills/odai-orchestration/scripts/local-cli.mjs"), resolve(scripts, "local-cli.mjs"));
      const probe = resolve(runtime, "probe.mjs");
      await writeFile(probe, 'export { buildLocalCliInvocation } from "#odai-local-cli"; export const target = import.meta.resolve("#odai-local-cli");\n');
      const loaded = await import(pathToFileURL(probe).href);
      assert.equal(loaded.target, pathToFileURL(await realpath(resolve(scripts, "local-cli.mjs"))).href);
      assert.equal(loaded.buildLocalCliInvocation({ backend: "local-cli", cli: "claude", model: "opus" }, {}).command, "claude");
    } finally {
      // This is the exact mkdtemp root created by this test, never an installed bundle.
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
