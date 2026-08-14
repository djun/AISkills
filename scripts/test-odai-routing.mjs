#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = path.join(repo, "skills", "odai");
const builder = path.join(skill, "scripts", "build-routing.mjs");
const installer = path.join(skill, "scripts", "install-routing.mjs");
const validator = path.join(repo, "scripts", "validate-odai-skill.mjs");
const roles = ["controller", "planner", "executor", "reviewer"];
const retired = ["advisor", "implementer", "worker"];

testBuilds();
testInstallLifecycle();
testStageRunnerDirect();
testNoRetiredArchitecture();

console.log("odai routing keeps one controller and uses planner, executor, or reviewer only where their independent responsibility can change the result.");

function testBuilds() {
  const root = temp("odai-routing-build-");
  try {
    const auto = runNode(builder, buildArgs("codex", path.join(root, "auto"), "auto"));
    assert.equal(auto.status, 0, auto.stderr);
    const autoRoot = path.join(root, "auto", "codex");
    const autoAdapter = json(path.join(autoRoot, "ADAPTER.json"));
    assert.equal(autoAdapter.routing_policy.mode, "conditional");
    assert.equal(autoAdapter.routing_policy.controller_identity, "persistent-task-thread");
    assert.equal(autoAdapter.routing_policy.sufficient_controller_defaults_to_single_pass, true);
    assert.deepEqual(Object.keys(autoAdapter.mapping), roles);
    assert.ok(!existsSync(path.join(autoRoot, ".codex", "hooks.json")), "auto must not install per-turn routing hooks");
    assert.ok(!existsSync(path.join(autoRoot, ".codex", "odai-route-hook.mjs")));
    assert.ok(!existsSync(path.join(autoRoot, ".codex", "odai-run-routing.mjs")));
    for (const role of roles.slice(1)) assert.ok(existsSync(path.join(autoRoot, ".codex", "agents", `odai-${role}.toml`)));
    for (const role of retired) assert.ok(!existsSync(path.join(autoRoot, ".codex", "agents", `odai-${role}.toml`)));
    assert.ok(existsSync(path.join(autoRoot, ".codex", "odai-run-role.mjs")));
    assert.ok(!existsSync(path.join(autoRoot, ".codex", "odai-run-provider-role.mjs")));

    const stage = runNode(builder, buildArgs("codex", path.join(root, "stage"), "stage"));
    assert.equal(stage.status, 0, stage.stderr);
    const stageAdapter = json(path.join(root, "stage", "codex", "ADAPTER.json"));
    assert.equal(stageAdapter.routing_policy.mode, "stage");
    assert.equal(stageAdapter.routing_policy.bounded_fresh_execution_context, true);
    assert.ok(!existsSync(path.join(root, "stage", "codex", ".codex", "hooks.json")), "stage must not inject a hidden per-turn hook");
    assert.ok(!existsSync(path.join(root, "stage", "codex", ".codex", "odai-route-hook.mjs")));
    assert.ok(existsSync(path.join(root, "stage", "codex", ".codex", "odai-run-routing.mjs")));

    for (const host of ["claude", "copilot"]) {
      const built = runNode(builder, buildArgs(host, path.join(root, host), "auto"));
      assert.equal(built.status, 0, built.stderr);
      const adapter = json(path.join(root, host, host, "ADAPTER.json"));
      assert.deepEqual(Object.keys(adapter.mapping), roles);
      for (const role of roles) {
        const relative = host === "claude" ? `.claude/agents/odai-${role}.md` : `.github/agents/odai-${role}.agent.md`;
        assert.ok(existsSync(path.join(root, host, host, relative)));
      }
      const rejected = runNode(builder, buildArgs(host, path.join(root, `${host}-stage`), "stage"));
      assert.notEqual(rejected.status, 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function testInstallLifecycle() {
  const project = temp("odai-routing-install-");
  try {
    const installed = runNode(installer, installArgs(project, "auto"));
    assert.equal(installed.status, 0, installed.stderr);
    const result = JSON.parse(installed.stdout);
    assert.equal(result.status, "installed");
    assert.equal(result.routingPolicy.mode, "conditional");
    const config = path.join(project, ".codex");
    const manifestFile = path.join(config, "odai-routing.json");
    const manifest = json(manifestFile);
    assert.deepEqual(Object.keys(manifest.mapping), roles);
    assert.ok(manifest.files["odai-run-role.mjs"]);
    assert.ok(!manifest.files["odai-run-provider-role.mjs"]);

    const oldHooks = Buffer.from('{"hooks":{"PreToolUse":[]}}\n');
    const oldRouteHook = Buffer.from("// retired transparent route hook\n");
    writeFileSync(path.join(config, "hooks.json"), oldHooks);
    writeFileSync(path.join(config, "odai-route-hook.mjs"), oldRouteHook);
    manifest.version = 10;
    manifest.files["hooks.json"] = sha256(oldHooks);
    manifest.files["odai-route-hook.mjs"] = sha256(oldRouteHook);
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const updated = runNode(installer, installArgs(project, "stage"));
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(JSON.parse(updated.stdout).status, "updated");
    assert.equal(json(manifestFile).routingPolicy.mode, "stage");
    assert.ok(existsSync(path.join(config, "odai-run-routing.mjs")));
    assert.ok(!existsSync(path.join(config, "hooks.json")), "stage must not install a hidden per-turn hook");
    assert.ok(!existsSync(path.join(config, "odai-route-hook.mjs")));
    const returned = runNode(installer, installArgs(project, "auto"));
    assert.equal(returned.status, 0, returned.stderr);
    assert.equal(json(manifestFile).routingPolicy.mode, "conditional");
    assert.ok(!existsSync(path.join(config, "odai-run-routing.mjs")));

    const managed = path.join(config, "agents", "odai-planner.toml");
    writeFileSync(managed, `${readFileSync(managed, "utf8")}\n# external drift\n`);
    const refused = runNode(installer, ["--host", "codex", "--scope", "project", "--target", project, "--uninstall", "--yes"]);
    assert.notEqual(refused.status, 0, "uninstall must refuse externally changed managed files");
    writeFileSync(managed, readFileSync(path.join(project, ".codex", "role-contracts", "odai-planner.md"), "utf8"));
    assert.notEqual(runNode(installer, ["--host", "codex", "--scope", "project", "--target", project, "--uninstall", "--yes"]).status, 0);
  } finally { rmSync(project, { recursive: true, force: true }); }

  const clean = temp("odai-routing-uninstall-");
  try {
    mkdirSync(path.join(clean, ".codex"), { recursive: true });
    writeFileSync(path.join(clean, ".codex", "hooks.json"), "{\"projectHook\":true}\n");
    const originalConfig = `model = "existing-model"\ndeveloper_instructions = """\nexisting instructions\nkeep this line\n"""\n\n[features]\nweb_search = true\nmulti_agent = false\n\n[mcp_servers.example]\ncommand = "example"\n`;
    writeFileSync(path.join(clean, ".codex", "config.toml"), originalConfig);
    assert.equal(runNode(installer, installArgs(clean, "auto")).status, 0);
    const mergedConfig = readFileSync(path.join(clean, ".codex", "config.toml"), "utf8");
    assert.match(mergedConfig, /model = "controller-model"/);
    assert.match(mergedConfig, /existing instructions/);
    assert.match(mergedConfig, /keep this line/);
    assert.match(mergedConfig, /web_search = true/);
    assert.match(mergedConfig, /multi_agent = true/);
    assert.match(mergedConfig, /\[mcp_servers\.example\]/);
    const removed = runNode(installer, ["--host", "codex", "--scope", "project", "--target", clean, "--uninstall", "--yes"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(JSON.parse(removed.stdout).status, "uninstalled");
    assert.ok(!existsSync(path.join(clean, ".codex", "odai-routing.json")));
    assert.equal(readFileSync(path.join(clean, ".codex", "hooks.json"), "utf8"), "{\"projectHook\":true}\n");
    assert.equal(readFileSync(path.join(clean, ".codex", "config.toml"), "utf8"), originalConfig);
  } finally { rmSync(clean, { recursive: true, force: true }); }

  for (const host of ["claude", "copilot"]) {
    const target = temp(`odai-routing-${host}-install-`);
    try {
      const installed = runNode(installer, installHostArgs(host, target, "auto"));
      assert.equal(installed.status, 0, installed.stderr);
      assert.equal(JSON.parse(installed.stdout).status, "installed");
      const root = path.join(target, host === "claude" ? ".claude" : ".github");
      for (const role of roles) {
        const name = host === "claude" ? `agents/odai-${role}.md` : `agents/odai-${role}.agent.md`;
        assert.ok(existsSync(path.join(root, name)));
      }
      if (host === "claude") assert.equal(json(path.join(root, "settings.local.json")).agent, "odai-controller");
      const removed = runNode(installer, ["--host", host, "--scope", "project", "--target", target, "--uninstall", "--yes"]);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(JSON.parse(removed.stdout).status, "uninstalled");
      if (host === "claude") assert.ok(!existsSync(path.join(root, "settings.local.json")));
    } finally { rmSync(target, { recursive: true, force: true }); }
  }
}

function testStageRunnerDirect() {
  const project = temp("odai-stage-runner-");
  try {
    const installed = runNode(installer, installArgs(project, "stage"));
    assert.equal(installed.status, 0, installed.stderr);
    const config = path.join(project, ".codex");
    const fakeRoleRunner = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const role = value("--role");
const input = readFileSync(0, "utf8");
const manifest = JSON.parse(readFileSync(value("--manifest"), "utf8"));
const model = manifest.mapping[role].model;
mkdirSync(path.dirname(value("--output")), { recursive: true });
if (args.includes("--route-card")) {
  const route = input.includes("独立实施")
    ? "mode: planned\\ntarget: 完成有界结果\\nevidence: 已冻结\\nscope: 只做目标\\ndecision: 路线成立\\nexecute: executor\\nreview: none\\naccept:\\n- A1: 结果存在\\nstop: 路线改变时停止\\n"
    : input.includes("总控实施")
      ? "mode: planned\\ntarget: 完成有界结果\\nevidence: 已冻结\\nscope: 只做目标\\ndecision: 路线成立\\nexecute: controller\\nreview: none\\naccept:\\n- A1: 结果存在\\nstop: 路线改变时停止\\n"
      : "mode: direct\\n完整交付\\n";
  writeFileSync(value("--output"), route);
  writeFileSync(value("--evidence"), JSON.stringify({ requested: { role, model }, observed: { provider: "codex", models: [model], model_verified: true, thread_id: "controller-thread", usage: { total_tokens: 10 }, duration_ms: 1, tool_evidence: [] } }));
  process.exit(0);
}
const output = role === "executor" || role === "controller"
  ? "已完成有界结果\\n<odai_closeout>{\\\"A1\\\":{\\\"status\\\":\\\"verified\\\",\\\"evidence\\\":\\\"结果存在\\\"}}</odai_closeout>\\n"
  : "mode: direct\\n完整交付\\n";
writeFileSync(value("--output"), output);
const sessionId = args.includes("--session-id") ? value("--session-id") : "";
writeFileSync(value("--evidence"), JSON.stringify({ requested: { role, model }, observed: { provider: "codex", models: [model], model_verified: true, thread_id: sessionId || (role === "controller" ? "controller-thread" : role + "-thread"), usage: { total_tokens: 10 }, duration_ms: 1, tool_evidence: [] } }));
`;
    writeFileSync(path.join(config, "odai-run-role.mjs"), fakeRoleRunner);
    const evidence = path.join(project, "evidence");
    const result = spawnSync(process.execPath, [path.join(config, "odai-run-routing.mjs"), "--cwd", project, "--evidence-dir", evidence], {
      cwd: project, input: "给我一个直接结果", encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "完整交付");
    const summary = json(path.join(evidence, "routing-run.json"));
    assert.equal(summary.execute, "controller");
    assert.equal(summary.roles.length, 1);
    const controllerEvidence = path.join(project, "controller-evidence");
    const controller = spawnSync(process.execPath, [path.join(config, "odai-run-routing.mjs"), "--cwd", project, "--evidence-dir", controllerEvidence], {
      cwd: project, input: "由总控实施一次有界任务", encoding: "utf8",
    });
    assert.equal(controller.status, 0, controller.stderr);
    assert.match(controller.stdout, /已完成有界结果/);
    const controllerSummary = json(path.join(controllerEvidence, "routing-run.json"));
    assert.equal(controllerSummary.execute, "controller");
    assert.equal(controllerSummary.execution_context, "controller-resumed-same-context");
    assert.deepEqual(controllerSummary.roles.map((item) => item.role), ["controller-route", "controller"]);
    assert.equal(controllerSummary.roles[0].observed.thread_id, controllerSummary.roles[1].observed.thread_id);

    const plannedEvidence = path.join(project, "planned-evidence");
    const planned = spawnSync(process.execPath, [path.join(config, "odai-run-routing.mjs"), "--cwd", project, "--evidence-dir", plannedEvidence], {
      cwd: project, input: "交给独立实施完成一次有界任务", encoding: "utf8",
    });
    assert.equal(planned.status, 0, planned.stderr);
    assert.match(planned.stdout, /已完成有界结果/);
    assert.doesNotMatch(planned.stdout, /odai_closeout/);
    const plannedSummary = json(path.join(plannedEvidence, "routing-run.json"));
    assert.equal(plannedSummary.execute, "executor");
    assert.deepEqual(plannedSummary.roles.map((item) => item.role), ["controller-route", "executor"]);
    assert.notEqual(plannedSummary.roles[0].observed.thread_id, plannedSummary.roles[1].observed.thread_id);
  } finally { rmSync(project, { recursive: true, force: true }); }
}

function testNoRetiredArchitecture() {
  const checked = runNode(validator, []);
  assert.equal(checked.status, 0, checked.stderr);
  const sources = [
    "skills/odai/scripts/build-routing.mjs", "skills/odai/scripts/run-routing.mjs",
    "skills/odai/scripts/run-role.mjs", "skills/odai/references/leverage.md",
  ].map((file) => readFileSync(path.join(repo, file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /external-controller|provider_profile|cc-switch:/i);
  assert.match(sources, /不遍历父目录|不向父目录/);
  assert.match(readFileSync(path.join(repo, "skills/odai/scripts/run-routing.mjs"), "utf8"), /Math\.min\(args\.timeout, 240\)/);
  const builderSource = readFileSync(path.join(repo, "skills/odai/scripts/build-routing.mjs"), "utf8");
  assert.doesNotMatch(builderSource, /route-hook\.mjs|codexRouteHooks|hooks\.json/, "routing must not reintroduce a hidden per-turn hook");
}

function buildArgs(host, out, policy) {
  return ["--host", host, "--out", out, "--controller-model", "controller-model", "--planner-model", "planner-model", "--executor-model", "executor-model", "--reviewer-model", "reviewer-model", "--planning-policy", policy];
}
function installArgs(project, policy) {
  return installHostArgs("codex", project, policy);
}
function installHostArgs(host, project, policy) {
  return ["--host", host, "--scope", "project", "--target", project, ...buildArgs(host, project, policy).slice(4), "--yes"];
}
function runNode(file, args) { return spawnSync(process.execPath, [file, ...args], { cwd: repo, encoding: "utf8" }); }
function json(file) { return JSON.parse(readFileSync(file, "utf8")); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function temp(prefix) { return mkdtempSync(path.join(tmpdir(), prefix)); }
