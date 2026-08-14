#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Usage:
  node skills/odai/scripts/build-routing.mjs --host <codex|claude|copilot> --out <directory> \\
    --controller-model <model> --planner-model <model> [--executor-model <model>] --reviewer-model <model> \\
    [--planning-policy <auto|stage>] [--controller-effort <effort>] [--planner-effort <effort>] \\
    [--executor-effort <effort>] [--reviewer-effort <effort>] [--verifier-command <command>]

生成 odai 的可选宿主路由适配器。auto 保留一个持续总控，只在独立规划、有界执行或独立验收能改变结果时调用相应责任。stage 仅生成从任务起点显式运行的 Codex 实验 runner，不注入每轮 Hook。这里不跨 provider 、不增加第二总控。`);
  process.exit(0);
}

const host = option("--host");
const out = option("--out");
const requestedPolicy = option("--planning-policy") || "auto";
const models = {
  controller: option("--controller-model"),
  planner: option("--planner-model"),
  executor: option("--executor-model") || option("--controller-model"),
  reviewer: option("--reviewer-model"),
};
const efforts = {
  controller: option("--controller-effort"),
  planner: option("--planner-effort"),
  executor: option("--executor-effort") || option("--controller-effort"),
  reviewer: option("--reviewer-effort"),
};
const verifierCommand = option("--verifier-command") || "node .codex/odai-verify-routing.mjs";
const roles = ["controller", "planner", "executor", "reviewer"];
const descriptions = {
  controller: "持续持有用户目标、全局状态、修正回路与最终交付。",
  planner: "只在独立判断能改变路线时形成有界的证据化规划。",
  executor: "只按冻结方案实施，不重新解释请求、选路或批准交付。",
  reviewer: "只在独立判断能改变放行结果时依据真实证据验收。",
};

if (!new Set(["codex", "claude", "copilot"]).has(host)) throw new Error(`Unsupported routing host: ${host || "(missing)"}`);
if (!out) throw new Error("--out requires a directory");
for (const role of roles) if (!models[role]) throw new Error(`--${role}-model is required`);
if (!new Set(["auto", "stage"]).has(requestedPolicy)) throw new Error(`Unsupported --planning-policy: ${requestedPolicy}`);
if (requestedPolicy === "stage" && host !== "codex") throw new Error("stage routing currently requires Codex");
if (host === "copilot" && Object.values(efforts).some(Boolean)) {
  throw new Error("Copilot custom-agent profiles do not provide a portable reasoning-effort field");
}

const policy = requestedPolicy === "stage" ? "stage" : "conditional";
const target = path.resolve(out, host);
mkdirSync(target, { recursive: true });
if (host === "codex") buildCodex(target);
else if (host === "claude") buildClaude(target);
else buildCopilot(target);

const metadata = {
  id: `odai-routing-${host}`,
  host,
  generatedFrom: "skills/odai/scripts/build-routing.mjs",
  mode: policy === "stage" ? "single-controller-stage-routing" : "single-controller-conditional-routing",
  mapping: Object.fromEntries(roles.map((role) => [role, {
    provider: host,
    model: models[role],
    reasoning_effort: efforts[role] || null,
  }])),
  routing_policy: {
    mode: policy,
    requested_mode: requestedPolicy,
    controller_identity: "persistent-task-thread",
    controller_owns_final_delivery: true,
    planner_activation: "only-when-independent-judgment-can-change-route",
    executor_activation: "only-after-plan-is-frozen-and-handoff-has-net-value",
    reviewer_activation: "only-when-independent-judgment-can-change-release",
    bounded_fresh_execution_context: policy === "stage",
    controller_reentry_on_failure: policy === "stage",
    sufficient_controller_defaults_to_single_pass: true,
    shared_evidence_chain: policy === "stage",
  },
  runtime_verification: host === "codex"
    ? { mode: "post-run-executable", command: verifierCommand }
    : { mode: "host-native-evidence-required", command: null },
  activation: activation(host),
  profiles: roles.map((role) => ({ name: `odai-${role}`, purpose: descriptions[role] })),
};
writeFileSync(path.join(target, "ADAPTER.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
console.log(target);

function buildCodex(root) {
  const sourceDir = path.join(skillRoot, "assets", "codex-agents");
  const configRoot = path.join(root, ".codex");
  const agentsRoot = path.join(configRoot, "agents");
  const contractsRoot = path.join(configRoot, "role-contracts");
  mkdirSync(agentsRoot, { recursive: true });
  mkdirSync(contractsRoot, { recursive: true });
  writeRendered(path.join(sourceDir, "config.toml"), path.join(configRoot, "config.toml"), {
    __ODAI_CONTROLLER_MODEL_LINE__: `model = ${JSON.stringify(models.controller)}`,
    __ODAI_CONTROLLER_EFFORT_LINE__: tomlEffortLine(efforts.controller),
    __ODAI_CONTROLLER_BODY__: roleBody("controller", "codex"),
    __ODAI_AGENT_SECTIONS__: codexAgentSections(),
  });
  for (const role of roles.slice(1)) {
    writeRendered(path.join(sourceDir, "role.toml"), path.join(agentsRoot, `odai-${role}.toml`), {
      __ODAI_ROLE_MODEL__: JSON.stringify(models[role]),
      __ODAI_ROLE_EFFORT_LINE__: tomlEffortLine(efforts[role]),
      __ODAI_ROLE_BODY__: roleBody(role, "codex"),
    });
  }
  copyScript("verify-routing.mjs", path.join(configRoot, "odai-verify-routing.mjs"));
  copyScript("run-role.mjs", path.join(configRoot, "odai-run-role.mjs"));
  if (policy === "stage") {
    copyScript("run-routing.mjs", path.join(configRoot, "odai-run-routing.mjs"));
  }
  for (const role of roles) writeFileSync(path.join(contractsRoot, `odai-${role}.md`), roleBody(role, "codex"), "utf8");
}

function buildClaude(root) {
  const source = path.join(skillRoot, "assets", "claude-agents", "agent.md");
  const agentsRoot = path.join(root, ".claude", "agents");
  mkdirSync(agentsRoot, { recursive: true });
  for (const role of roles) {
    writeRendered(source, path.join(agentsRoot, `odai-${role}.md`), {
      __ODAI_ROLE__: role,
      __ODAI_ROLE_DESCRIPTION__: descriptions[role],
      __ODAI_ROLE_MODEL__: models[role],
      __ODAI_ROLE_EFFORT_LINE__: yamlEffortLine(efforts[role]),
      __ODAI_PERMISSION_MODE__: role === "planner" || role === "reviewer" ? "plan" : "default",
      __ODAI_TOOLS_LINE__: "",
      __ODAI_ROLE_BODY__: roleBody(role, "claude"),
    });
  }
  writeFileSync(path.join(root, ".claude", "settings.patch.json"), `${JSON.stringify({ agent: "odai-controller" }, null, 2)}\n`, "utf8");
}

function buildCopilot(root) {
  const source = path.join(skillRoot, "assets", "copilot-agents", "agent.md");
  const agentsRoot = path.join(root, ".github", "agents");
  mkdirSync(agentsRoot, { recursive: true });
  for (const role of roles) {
    writeRendered(source, path.join(agentsRoot, `odai-${role}.agent.md`), {
      __ODAI_ROLE__: role,
      __ODAI_ROLE_DESCRIPTION__: descriptions[role],
      __ODAI_ROLE_MODEL__: models[role],
      __ODAI_DISABLE_MODEL_INVOCATION__: role === "controller" ? "true" : "false",
      __ODAI_USER_INVOCABLE__: role === "controller" ? "true" : "false",
      __ODAI_TOOLS__: role === "planner" || role === "reviewer" ? '["view", "glob", "grep", "shell"]' : '["*"]',
      __ODAI_ROLE_BODY__: roleBody(role, "copilot"),
    });
  }
  writeFileSync(path.join(root, "LAUNCH.json"), `${JSON.stringify({
    command: ["copilot", `--model=${models.controller}`, "--agent=odai-controller"],
    reason: "Copilot has no portable project setting that makes a custom agent the default main controller.",
    autoModelUnsupported: true,
  }, null, 2)}\n`, "utf8");
}

function roleBody(role, hostName) {
  const source = path.join(skillRoot, "assets", "routing-roles", `${role}.md`);
  if (!existsSync(source)) throw new Error(`Missing canonical routing role body: ${source}`);
  const names = hostName === "codex"
    ? { planner: "odai_planner", executor: "odai_executor", reviewer: "odai_reviewer" }
    : { planner: "odai-planner", executor: "odai-executor", reviewer: "odai-reviewer" };
  const rendered = renderText(readFileSync(source, "utf8"), {
    __ODAI_POLICY__: policy,
    __ODAI_PLANNER_ROLE__: names.planner,
    __ODAI_EXECUTOR_ROLE__: names.executor,
    __ODAI_REVIEWER_ROLE__: names.reviewer,
    __ODAI_RUNTIME_VERIFICATION__: hostName === "codex"
      ? "实际路由必须用宿主返回的线程、角色、模型与用量证据核对，不从调用请求推断成功。"
      : "只有宿主原生运行证据能识别实际角色与模型时，路由才算已核实。",
    __ODAI_HOST_NOTE__: hostName === "copilot" ? "Copilot Auto 会覆盖角色模型选择；需要区分角色时不使用 Auto。" : "",
  }, source);
  if (hostName !== "codex") return rendered;
  const canonical = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  const responsibility = role === "controller"
    ? "你是唯一总控，持有完整目标、全局状态、修正回路与最终交付。"
    : `你只承担 ${role} 责任，不是第二个总控。`;
  return `以下 canonical odai 是所有责任共享的内核；宿主角色契约只限制本责任，不得另建流程。${responsibility}\n\n${canonical}\n\n## 宿主角色契约\n\n${rendered}`;
}

function codexAgentSections() {
  return roles.slice(1).flatMap((role) => [
    `[agents.odai_${role}]`,
    `description = ${JSON.stringify(descriptions[role])}`,
    `config_file = ${JSON.stringify(`agents/odai-${role}.toml`)}`,
    "",
  ]).join("\n").trimEnd();
}

function activation(value) {
  if (value === "claude") return { main: "新会话由托管设置选择 odai-controller。", reload: "重启 Claude Code 或重新加载配置。" };
  if (value === "copilot") return {
    main: `使用 copilot --model=${models.controller} --agent=odai-controller 启动。`,
    reload: "安装或更新后重启 Copilot CLI。",
    limitation: "Copilot Auto 会覆盖角色模型选择。",
  };
  return {
    main: policy === "stage"
      ? "通过生成的 odai-run-routing.mjs 从任务起点运行一次显式 stage 实验；日常会话不由隐藏 Hook 接管。"
      : "普通会话由托管配置选择单一总控，其余责任按真实缺口调用。",
    reload: "修改后开启新的 Codex 会话。",
  };
}

function copyScript(name, targetFile) {
  const source = path.join(skillRoot, "scripts", name);
  if (!existsSync(source)) throw new Error(`Missing canonical routing script: ${source}`);
  writeFileSync(targetFile, readFileSync(source), "utf8");
}

function option(name) {
  const index = argv.indexOf(name);
  if (index < 0) return "";
  const value = argv[index + 1] || "";
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function tomlEffortLine(value) { return value ? `model_reasoning_effort = ${JSON.stringify(value)}` : ""; }
function yamlEffortLine(value) { return value ? `effort: ${value}\n` : ""; }
function writeRendered(source, targetFile, replacements) {
  if (!existsSync(source)) throw new Error(`Missing canonical routing source: ${source}`);
  mkdirSync(path.dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, renderText(readFileSync(source, "utf8"), replacements, source), "utf8");
}
function renderText(input, replacements, source = "generated routing text") {
  let text = input;
  for (const [key, value] of Object.entries(replacements)) text = text.replaceAll(key, value);
  const unresolved = text.match(/__ODAI_[A-Z0-9_]+__/g);
  if (unresolved) throw new Error(`Unresolved routing template fields in ${source}: ${[...new Set(unresolved)].join(", ")}`);
  return text;
}
