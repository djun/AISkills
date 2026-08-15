import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolve } from "node:path";

import { apply, resolveSkillPath } from "../src/index.mjs";
import {
  chooseSkillBundle,
  compareSkillVersions,
  loadSkillBundle,
} from "../src/skill-bundle.mjs";
import {
  createSkillSourceConfigTool,
  effectiveSkillSource,
  readSkillSourceStore,
} from "../src/skill-source-config.mjs";
import { resolveSkillSelection } from "../src/skill-selector.mjs";
import {
  selectSharedSkillForTurn,
  sharedSkillSelection,
} from "../src/skill-selection-state.mjs";

const canonicalRoot = resolve(import.meta.dirname, "../../../skills/odai");
const canonicalPath = resolve(canonicalRoot, "SKILL.md");
const bundled = loadSkillBundle(canonicalPath);

function fixtureRoot(label) {
  return mkdtempSync(resolve(tmpdir(), `odai-${label}-`));
}

function installBundle(root, version, marker = "") {
  cpSync(canonicalRoot, root, { recursive: true });
  const manifestPath = resolve(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.skillVersion = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (marker) {
    writeFileSync(resolve(root, "SKILL.md"), `${readFileSync(resolve(root, "SKILL.md"), "utf8").trimEnd()}\n\n${marker}\n`, "utf8");
    writeFileSync(
      resolve(root, "assets/routing-roles/planner.md"),
      `${readFileSync(resolve(root, "assets/routing-roles/planner.md"), "utf8").trimEnd()}\n\n${marker}_PLANNER\n`,
      "utf8",
    );
  }
  return resolve(root, "SKILL.md");
}

function userMessage(text) {
  return {
    id: "user-1",
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function fakeContext(extra = {}) {
  const captured = { handlers: new Map(), sections: [], guards: [], tools: [], logs: [] };
  return {
    ...extra,
    captured,
    systemPrompt: {
      section(value) {
        captured.sections.push(value);
      },
    },
    tools: {
      register(value) {
        captured.tools.push(value);
      },
      guard(value) {
        captured.guards.push(value);
      },
    },
    on(event, handler) {
      captured.handlers.set(event, handler);
    },
    logger() {
      return {
        info(message) {
          captured.logs.push(message);
        },
        warn(message) {
          captured.logs.push(message);
        },
      };
    },
  };
}

function assemblyFor(ctx) {
  return {
    sections: ctx.captured.sections.map(({ name, text }) => ({ name, text })),
    contexts: [],
    tools: [],
    variables: {},
  };
}

test("bundle manifest validates complete content and full SemVer precedence", () => {
  assert.equal(bundled.manifest.skillVersion, "0.1.0");
  assert.equal(bundled.manifest.runtimeContract, 1);
  assert.equal(bundled.manifest.requiredFiles.length, 25);
  assert.match(bundled.digest, /^[a-f0-9]{64}$/u);
  assert.equal(compareSkillVersions("1.0.0-alpha.2", "1.0.0-alpha.10"), -1);
  assert.equal(compareSkillVersions("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.equal(compareSkillVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareSkillVersions("999999999999999999999.0.0", "999999999999999999998.9.9"), 1);

  const scratch = fixtureRoot("bundle-conflict");
  try {
    const conflicting = loadSkillBundle(installBundle(resolve(scratch, "odai"), "0.1.0", "CONFLICT"), {
      source: "user-dsh",
    });
    const selection = chooseSkillBundle({ mode: "auto", bundled, candidate: conflicting });
    assert.equal(selection.bundle, bundled);
    assert.equal(selection.reasonCode, "same-version-content-conflict");
    writeFileSync(
      resolve(scratch, "odai", "SKILL.md"),
      "---\nname: not-odai\n---\n\nname: odai\n---\n",
      "utf8",
    );
    assert.throws(
      () => loadSkillBundle(resolve(scratch, "odai", "SKILL.md")),
      /does not declare name odai/u,
    );
    rmSync(resolve(scratch, "odai", "assets/routing-roles/planner.md"));
    assert.throws(() => loadSkillBundle(resolve(scratch, "odai", "SKILL.md")), /missing assets\/routing-roles\/planner\.md/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("auto source keeps project pins scoped and selects newer user installs elsewhere", async () => {
  const scratch = fixtureRoot("source-scope");
  try {
    const projectA = resolve(scratch, "project-a");
    const projectB = resolve(scratch, "project-b");
    const dshHome = resolve(scratch, "dsh-home");
    const agentsHome = resolve(scratch, "agents-home");
    mkdirSync(resolve(projectA, ".git"), { recursive: true });
    mkdirSync(resolve(projectB, ".git"), { recursive: true });
    installBundle(resolve(projectA, ".dsh/skills/odai"), "0.0.9", "PROJECT_A");
    installBundle(resolve(dshHome, "skills/odai"), "0.2.0", "USER_DSH");
    const env = { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome };

    const projectSelection = await resolveSkillSelection({
      mode: "auto",
      bundled,
      cwd: resolve(projectA, "src"),
      env,
    });
    assert.equal(projectSelection.bundle.source, "project-dsh");
    assert.equal(projectSelection.bundle.manifest.skillVersion, "0.0.9");
    assert.match(projectSelection.bundle.skillText, /PROJECT_A/u);

    const userSelection = await resolveSkillSelection({
      mode: "auto",
      bundled,
      cwd: projectB,
      env,
    });
    assert.equal(userSelection.bundle.source, "user-dsh");
    assert.equal(userSelection.bundle.manifest.skillVersion, "0.2.0");
    assert.doesNotMatch(userSelection.bundle.skillText, /PROJECT_A/u);

    const forcedUser = await resolveSkillSelection({
      mode: "user",
      bundled,
      cwd: projectA,
      env,
    });
    assert.equal(forcedUser.bundle.source, "user-dsh");
    assert.doesNotMatch(forcedUser.bundle.skillText, /PROJECT_A/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("invalid and conflicting candidates continue to the next compatible source", async () => {
  const scratch = fixtureRoot("source-fallback");
  try {
    const project = resolve(scratch, "project");
    const dshHome = resolve(scratch, "dsh-home");
    const agentsHome = resolve(scratch, "agents-home");
    mkdirSync(resolve(project, ".git"), { recursive: true });
    installBundle(resolve(project, ".dsh/skills/odai"), "0.3.0", "BROKEN_PROJECT");
    rmSync(resolve(project, ".dsh/skills/odai/assets/routing-roles/reviewer.md"));
    installBundle(resolve(dshHome, "skills/odai"), "0.1.0", "SAME_VERSION_CONFLICT");
    installBundle(resolve(agentsHome, "skills/odai"), "0.2.0", "USER_AGENTS");

    const selection = await resolveSkillSelection({
      mode: "auto",
      bundled,
      cwd: project,
      env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome },
    });
    assert.equal(selection.bundle.source, "user-agents");
    assert.equal(selection.bundle.manifest.skillVersion, "0.2.0");
    assert.deepEqual(selection.rejections.map(({ source, reasonCode }) => [source, reasonCode]), [
      ["project-dsh", "external-invalid"],
      ["user-dsh", "same-version-content-conflict"],
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("custom registry candidates participate without making bundled mode depend on skills", async () => {
  const scratch = fixtureRoot("custom-source");
  try {
    const customPath = installBundle(resolve(scratch, "custom/odai"), "0.4.0", "CUSTOM_SOURCE");
    let lookups = 0;
    const skills = {
      async get(name, options) {
        lookups += 1;
        assert.equal(name, "odai");
        assert.equal(options.cwd, undefined);
        return {
          name: "odai",
          source: "custom",
          provider: "fixture-custom",
          path: customPath,
        };
      },
    };
    const selected = await resolveSkillSelection({
      mode: "auto",
      bundled,
      cwd: scratch,
      skills,
      scope: {},
      env: { DSH_HOME: resolve(scratch, "empty-dsh"), DSH_AGENTS_HOME: resolve(scratch, "empty-agents") },
    });
    assert.equal(selected.bundle.source, "custom");
    assert.equal(lookups, 1);

    const pinned = await resolveSkillSelection({ mode: "bundled", bundled, skills });
    assert.equal(pinned.bundle, bundled);
    assert.equal(lookups, 1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("source configuration is atomic, explicit, repairable, and denied to child agents", async () => {
  const scratch = fixtureRoot("source-config");
  try {
    const configPath = resolve(scratch, "odai/source.json");
    const tool = createSkillSourceConfigTool(configPath, "bundled");
    const rootExecution = { agent: { session: { header: {} } } };
    assert.throws(() => tool.execute({ action: "set" }, rootExecution), /source must be bundled, auto, or user/u);
    assert.throws(() => tool.execute({ action: "show", source: "auto" }, rootExecution), /source must be omitted for show/u);
    assert.throws(() => tool.execute({ action: "show", extra: true }, rootExecution), /unknown arguments/u);
    assert.equal((await tool.execute({ action: "show" }, rootExecution)).source, "bundled");
    assert.equal((await tool.execute({ action: "set", source: "auto" }, rootExecution)).source, "auto");
    assert.equal(effectiveSkillSource(configPath, "bundled"), "auto");
    assert.deepEqual(readSkillSourceStore(configPath), { schemaVersion: 1, source: "auto" });
    assert.throws(
      () => tool.execute({ action: "set", source: "user" }, { agent: { session: { header: { origin: "subagent" } } } }),
      /child agents may not change/u,
    );

    writeFileSync(configPath, "{broken\n", "utf8");
    const repaired = await tool.execute({ action: "set", source: "user" }, rootExecution);
    assert.equal(repaired.recoveredInvalidStore, true);
    assert.equal(effectiveSkillSource(configPath, "bundled"), "user");
    assert.equal((await tool.execute({ action: "remove" }, rootExecution)).source, "bundled");
    assert.equal(effectiveSkillSource(configPath, "bundled"), "bundled");

    const explicitPathTool = createSkillSourceConfigTool(configPath, "bundled", { explicitPath: true });
    const explicitView = await explicitPathTool.execute({ action: "show" }, rootExecution);
    assert.equal(explicitView.source, "bundled");
    assert.equal(explicitView.effectiveSource, "path");
    assert.equal(explicitView.hostOverride, true);
    const explicitSet = await explicitPathTool.execute({ action: "set", source: "auto" }, rootExecution);
    assert.equal(explicitSet.source, "auto");
    assert.equal(explicitSet.effectiveSource, "path");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("shared selection is single-flight within a turn and refreshes on the next turn", async () => {
  const agent = { phase: { turn: 1 }, session: { events: [] } };
  let selections = 0;
  const select = async () => ({ generation: ++selections });
  const [first, second] = await Promise.all([
    selectSharedSkillForTurn(agent, select),
    selectSharedSkillForTurn(agent, select),
  ]);
  assert.equal(first, second);
  assert.equal(selections, 1);
  assert.equal(sharedSkillSelection(agent, 1), first);

  agent.phase.turn = 2;
  const nextTurn = await selectSharedSkillForTurn(agent, select);
  assert.equal(nextTurn.generation, 2);
  assert.equal(selections, 2);
  assert.equal(sharedSkillSelection(agent, 1), undefined);
  assert.equal(sharedSkillSelection(agent, 2), nextTurn);
});

test("scoped runtime selection wins once and the global runtime follows it", async () => {
  const scratch = fixtureRoot("dual-runtime-selection");
  const previousDshHome = process.env.DSH_HOME;
  try {
    const project = resolve(scratch, "project");
    const dshHome = resolve(scratch, "dsh-home");
    mkdirSync(resolve(project, ".git"), { recursive: true });
    installBundle(resolve(project, ".dsh/skills/odai"), "0.0.7", "SCOPED_SELECTION");
    process.env.DSH_HOME = dshHome;

    const globalCtx = fakeContext();
    const scopedCtx = fakeContext();
    apply(globalCtx, {
      governance: { skillSource: "bundled", skillConfigPath: resolve(dshHome, "global-source.json") },
      routing: { mode: "off" },
    });
    apply(scopedCtx, {
      governance: { skillSource: "auto", skillConfigPath: resolve(dshHome, "scoped-source.json") },
      routing: { mode: "off" },
    });
    const agent = { phase: { turn: 1 }, session: { header: { cwd: project }, events: [] } };
    const context = { agent, scope: agent, signal: new AbortController().signal };
    const assembly = assemblyFor(scopedCtx);
    const globalAssemble = globalCtx.captured.handlers.get("system-prompt/assemble");
    const scopedAssemble = scopedCtx.captured.handlers.get("system-prompt/assemble");
    const selected = await globalAssemble(assembly, context, () => scopedAssemble(
      assembly,
      context,
      async () => assembly,
    ));

    assert.equal(sharedSkillSelection(agent, 1).bundle.source, "project-dsh");
    assert.match(selected.sections[0].text, /Canonical source: project-dsh/u);
    assert.match(selected.sections[0].text, /SCOPED_SELECTION/u);
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("runtime injects one project snapshot into both prompt and routed role contract", async () => {
  const scratch = fixtureRoot("runtime-selection");
  const previousDshHome = process.env.DSH_HOME;
  try {
    const project = resolve(scratch, "project");
    const dshHome = resolve(scratch, "dsh-home");
    mkdirSync(resolve(project, ".git"), { recursive: true });
    installBundle(resolve(project, ".dsh/skills/odai"), "0.0.8", "PROJECT_RUNTIME");
    process.env.DSH_HOME = dshHome;
    let startRequest;
    const ctx = fakeContext({
      subagents: {
        async start(_provider, request) {
          startRequest = request;
          return {
            localAgent: {
              session: {
                events: [{
                  type: "request/header",
                  data: { header: { config: { provider: "fixture", model: "planner" } } },
                }],
              },
            },
            result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "planned" }] }),
            async dispose() {},
          };
        },
      },
    });
    const sourceConfigPath = resolve(dshHome, "odai/source.json");
    apply(ctx, {
      governance: { skillSource: "auto", skillConfigPath: sourceConfigPath },
      routing: {
        roles: { planner: { provider: "fixture", model: "planner" } },
      },
    });
    const agent = {
      phase: { turn: 1 },
      session: { header: { cwd: project }, events: [] },
    };
    const signal = new AbortController().signal;
    const assemble = ctx.captured.handlers.get("system-prompt/assemble");
    const baseAssembly = assemblyFor(ctx);
    const selectedAssembly = await assemble(baseAssembly, { agent, scope: agent, signal }, async () => baseAssembly);
    const governance = selectedAssembly.sections.find(({ name }) => name === "odai:canonical-governance");
    assert.match(governance.text, /Canonical source: project-dsh/u);
    assert.match(governance.text, /PROJECT_RUNTIME/u);

    const preStep = ctx.captured.handlers.get("agent/pre-step");
    await preStep({ agent, turn: 1, step: 1, signal }, async () => ({
      kind: "enter",
      messages: [userMessage("请独立规划一下架构选型")],
    }));
    assert.match(startRequest.prompt[0].text, /PROJECT_RUNTIME_PLANNER/u);

    const sourceTool = ctx.captured.tools.find(({ name }) => name === "odai_skill_source_config");
    await sourceTool.execute({ action: "set", source: "bundled" }, { agent });
    const sameTurn = await assemble(baseAssembly, { agent, scope: agent, signal }, async () => baseAssembly);
    assert.match(sameTurn.sections[0].text, /Canonical source: project-dsh/u);
    agent.phase.turn = 2;
    const nextTurn = await assemble(baseAssembly, { agent, scope: agent, signal }, async () => baseAssembly);
    assert.match(nextTurn.sections[0].text, /Canonical source: bundled/u);
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("explicit skill paths fail fast instead of silently falling back", () => {
  assert.throws(
    () => resolveSkillPath(resolve(tmpdir(), `missing-odai-${Date.now()}`, "SKILL.md"), {}),
    /explicit Odai canonical skill not found/u,
  );
});
