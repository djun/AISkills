import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  inspectAgentInstallation,
  installAgentPreset,
  resolveDshHome,
  uninstallAgentPreset,
} from "../src/installer.mjs";

test("managed preset installs, updates, reports status, and uninstalls", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-installer-"));
  const sourceRoot = resolve(scratch, "source");
  const dshHome = resolve(scratch, "home");
  try {
    await writeFixture(sourceRoot, "first runtime");
    const installed = await installAgentPreset({ dshHome, sourceRoot });
    assert.equal(installed.operation, "installed");
    assert.equal(installed.trust, "user");
    assert.match(installed.security, /same privileges as shell access/u);
    assert.equal((await inspectAgentInstallation({ dshHome })).status, "installed");
    const firstCompositionSize = Buffer.byteLength(await readFile(resolve(installed.target, "agent.cordis.yml")));
    if (process.platform !== "win32") {
      assert.equal((await stat(installed.target)).mode & 0o777, 0o700);
      assert.equal((await stat(resolve(installed.target, "runtime/index.mjs"))).mode & 0o777, 0o600);
      assert.equal((await stat(resolve(installed.target, ".odai-agent.json"))).mode & 0o777, 0o600);
    }

    await writeFile(resolve(sourceRoot, "runtime/index.mjs"), "export default 'second runtime';\n", "utf8");
    const updated = await installAgentPreset({ dshHome, sourceRoot });
    assert.equal(updated.operation, "updated");
    assert.match(await readFile(resolve(updated.target, "runtime/index.mjs"), "utf8"), /second runtime/u);
    const secondCompositionSize = Buffer.byteLength(await readFile(resolve(updated.target, "agent.cordis.yml")));
    assert.notEqual(secondCompositionSize, firstCompositionSize);

    const refreshed = await installAgentPreset({ dshHome, sourceRoot });
    const thirdCompositionSize = Buffer.byteLength(await readFile(resolve(refreshed.target, "agent.cordis.yml")));
    assert.notEqual(thirdCompositionSize, secondCompositionSize);

    const removed = await uninstallAgentPreset({ dshHome });
    assert.equal(removed.operation, "uninstalled");
    assert.equal((await inspectAgentInstallation({ dshHome })).status, "absent");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("managed preset refuses updates and removal after local drift", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-drift-"));
  const sourceRoot = resolve(scratch, "source");
  const dshHome = resolve(scratch, "home");
  try {
    await writeFixture(sourceRoot, "runtime");
    const installed = await installAgentPreset({ dshHome, sourceRoot });
    await writeFile(resolve(installed.target, "agent.cordis.yml"), "locally edited\n", "utf8");

    const status = await inspectAgentInstallation({ dshHome });
    assert.equal(status.status, "drifted");
    assert.ok(status.issues.includes("modified managed file agent.cordis.yml"));
    await assert.rejects(
      installAgentPreset({ dshHome, sourceRoot }),
      /refusing to replace modified preset/u,
    );
    await assert.rejects(
      uninstallAgentPreset({ dshHome }),
      /refusing to remove modified preset/u,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("uninstall refuses to leave an invalid default preset", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-default-"));
  const sourceRoot = resolve(scratch, "source");
  const dshHome = resolve(scratch, "home");
  try {
    await writeFixture(sourceRoot, "runtime");
    await installAgentPreset({ dshHome, sourceRoot });
    await writeFile(resolve(dshHome, "settings.yaml"), "agent-presets:\n  default: odai\n", "utf8");
    await assert.rejects(
      uninstallAgentPreset({ dshHome }),
      /select another agent-presets\.default first/u,
    );
    await writeFile(resolve(dshHome, "settings.yaml"), "agent-presets:\n  default: standard\n", "utf8");
    assert.equal((await uninstallAgentPreset({ dshHome })).operation, "uninstalled");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("DSH home resolution honors explicit path before the environment", () => {
  assert.equal(resolveDshHome("./explicit", { DSH_HOME: "./environment" }), resolve("./explicit"));
  assert.equal(resolveDshHome(undefined, { DSH_HOME: "./environment" }), resolve("./environment"));
});

test("installer writes through DSH_HOME when no explicit home is provided", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-env-home-"));
  const sourceRoot = resolve(scratch, "source");
  const previous = process.env.DSH_HOME;
  try {
    await writeFixture(sourceRoot, "runtime");
    process.env.DSH_HOME = resolve(scratch, "environment-home");
    const installed = await installAgentPreset({ sourceRoot });
    assert.equal(installed.target, resolve(process.env.DSH_HOME, ".agent-presets/odai"));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(scratch, { recursive: true, force: true });
  }
});

async function writeFixture(root, runtimeText) {
  await Promise.all([
    mkdir(resolve(root, "runtime"), { recursive: true }),
    mkdir(resolve(root, "skills/odai"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(root, "agent.cordis.yml"), "- id: odai\n  name: ./runtime/index.mjs\n", "utf8"),
    writeFile(resolve(root, "preset.yml"), "name: Odai\n", "utf8"),
    writeFile(resolve(root, "runtime/index.mjs"), `export default ${JSON.stringify(runtimeText)};\n`, "utf8"),
    writeFile(resolve(root, "skills/odai/SKILL.md"), "---\nname: odai\n---\n", "utf8"),
  ]);
}
