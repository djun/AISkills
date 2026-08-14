#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.on("uncaughtException", (error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`用已安装的 Codex odai stage 路由处理一次真实任务。一个持续总控 thread 负责目标、定路、修正与最终交付；只在规划冻结且交接有净收益时启动 executor，只在独立验收能改变放行结果时启动 reviewer。

Usage:
  printf '%s' '<request>' | node .codex/odai-run-routing.mjs [--cwd PATH] [--output FILE]
    [--sandbox MODE] [--manifest FILE] [--codex-bin FILE] [--evidence-dir DIR]

输入从 stdin 读取。总控必须返回 direct 或 planned，execute 与 review 由宿主机械执行。`);
  process.exit(0);
}

const manifestFile = path.resolve(args.manifest || path.join(scriptDir, "odai-routing.json"));
const manifest = readJson(manifestFile, "路由清单");
if (manifest.host !== "codex") fail(`确定性规划入口当前只支持 Codex，收到：${manifest.host || "unknown"}`);
const routingMode = manifest.routingPolicy?.mode || "conditional";
if (routingMode !== "stage") fail("当前安装未启用 Codex stage 路由");

const request = readFileSync(0, "utf8").trim();
if (!request) fail("stdin 中没有用户请求");
const workdir = path.resolve(args.cwd || process.cwd());
const decisionRole = "controller";
const decisionMapping = manifest.mapping?.[decisionRole];
if (!decisionMapping?.model) fail(`路由清单缺少 ${decisionRole} 映射`);
if (routingMode === "stage" && (decisionMapping.provider || manifest.host) !== "codex") {
  fail("stage 路由要求 controller 由 Codex 承载，以便在同一任务线程换档");
}

const roleRunner = path.join(scriptDir, "odai-run-role.mjs");
if (!existsSync(roleRunner)) fail(`缺少角色 runner：${roleRunner}`);
const temporary = mkdtempSync(path.join(tmpdir(), "odai-routing-run-"));
const evidenceDir = args.evidenceDir ? path.resolve(args.evidenceDir) : temporary;
mkdirSync(evidenceDir, { recursive: true });
const planFile = path.join(evidenceDir, `${decisionRole}-route.txt`);
const plannerLog = path.join(evidenceDir, `${decisionRole}-route.jsonl`);
const plannerEvidence = path.join(evidenceDir, `${decisionRole}-runtime.json`);
const outputFile = path.resolve(args.output || path.join(evidenceDir, "last-message.txt"));
const summaryFile = path.join(evidenceDir, "routing-run.json");

try {
  const runStarted = Date.now();
  const runSummary = { version: 2, mode: routingMode, started_at: new Date().toISOString(), roles: [], stage_transitions: [] };
  const directOwner = "controller";
  const plannerPrompt = `这是 odai 同一总控线程的首次定路。你就是用户任务的总控，不是总控之前的另一个角色；后续可以恢复这个 thread，不创建第二份目标与全局状态。本轮只读定路：不得编辑项目、实施、运行实施后验证或创建 agent；宿主会执行你选定的后续责任。当前 cwd 就是完整项目根；调查只限于该目录内的项目文件，不遍历父目录、兄弟目录、用户目录或其他工作区，也不盘点 .git 与路由器自身的 .codex 产物。

先从完整请求判断当前责任。用户给出的原因、手段、数值或完成标准会改变路线时，必须先读取足以裁决它的最少权威原件；未经核实的前提不得冻结进 target、decision 或 accept。用户当前要求的完整结果能在回复中交付时必须 direct，其中描述的组成部分或未来实施切片不改变本轮交付类型；只有当前获授权的交付本身在最小契约核对后仍需多个相互依赖的实施产物时才 planned，不读取实现和测试来预做。一项外部动作受阻而其余结果可当轮交付时仍 direct。高后果提高证据和验收强度，但不自动制造交接。

准备 direct 写入时，按目标对象在既有项目约定与验证入口中做一次有界发现；不能只看实现文件或通用启动配置，就宣称项目没有专用契约或测试。现成验证入口须原样运行，验证需求本身不授权修改其载体。

若结果依赖尚不可用的能力，且下一步涉及安装、启用、联网、凭据或更高权限，按 odai leverage 规则和项目权威来源处理。同意前让用户看到会改变决定的真实影响、继续动作、验证和替代差异，不把关键信息只留在内部路由中。

当前请求只需回答或只读交付，并且本轮已取得充分证据时才用 direct，直接给面向用户的完整结果。当前请求需要写入时必须 planned：同一总控上下文继续实施更可靠或更省时，写 execute: controller；只有决定已经冻结、实施有界可验且新上下文有可观察净收益时，才写 execute: executor。高后果本身只提高证据和验收强度，不强制拆开实施。新证据推翻路线时回到总控，只改受影响部分。

验收已定义结果、范围与保持项时，低风险、可逆且可测试的局部实现选择由执行责任自主决定；不要因缺少唯一先例而停止。只有选择会改变业务语义、公共契约、用户取舍或高代价后果时才升级决定。

已安装能力映射：
${JSON.stringify(manifest.mapping, null, 2)}

用户请求：
${request}`;
  const plannerRepositoryBefore = captureRepositoryState();
  const decisionArgs = [
    "--role", decisionRole, "--manifest", manifestFile, "--cwd", workdir,
    "--output", planFile, "--evidence", plannerEvidence, "--sandbox", args.sandbox,
    "--route-card",
  ];
  if (decisionRole === "planner") decisionArgs.push("--planner-may-complete-direct");
  const plannerResult = runProviderRole(decisionArgs, plannerPrompt, Math.min(args.timeout, 240));
  writeFileSync(plannerLog, plannerResult.output, "utf8");
  if (plannerResult.status !== 0) fail(`${decisionRole} 定路失败：${tail(plannerResult.output)}`);
  const plannerObserved = readJson(plannerEvidence, `${decisionRole} 运行证据`);
  requireObservedRole(decisionRole, plannerObserved);
  const controllerThreadId = routingMode === "stage" ? plannerObserved.observed?.thread_id : "";
  if (routingMode === "stage" && !controllerThreadId) fail("controller 没有形成可核实的 Codex thread ID");
  runSummary.controller_thread_id = controllerThreadId || null;
  const decisionRoleLabel = "controller-route";
  runSummary.roles.push(roleSummary(decisionRoleLabel, plannerObserved));
  runSummary.stage_transitions.push({ stage: "decision", role: decisionRole, reason: "initial-capable-first" });

  let plan = existsSync(planFile) ? normalizePlanCard(readFileSync(planFile, "utf8").trim()) : "";
  let planState = validatePlan(plan, directOwner);
  const plannerRepositoryAfter = captureRepositoryState();
  if (planState.mode === "planned" && repositoryStateChanged(plannerRepositoryBefore, plannerRepositoryAfter)) {
    fail(`${decisionRole} 选择 planned 却提前修改了项目；复杂任务只能交付方案，不能预做实现`);
  }
  let activePlannerObserved = plannerObserved;
  const initialExecute = planState.execute;
  const initialReviewIds = [...planState.reviewIds];
  let executionResult;
  if (planState.mode === "direct") {
    executionResult = captureDirectCompletion({
      plan, planState, plannerObserved: activePlannerObserved,
      repositoryBefore: plannerRepositoryBefore, repositoryAfter: plannerRepositoryAfter,
      directRole: directOwner,
    });
  } else {
    try {
      executionResult = runSelectedExecution({
        plan, planState, plannerObserved: activePlannerObserved, runSummary, suffix: "",
        sessionId: planState.execute === "controller" ? controllerThreadId : "",
      });
    } catch (error) {
      if (routingMode !== "stage" || planState.execute !== "executor" || !isRecoverableExecutionError(error)) throw error;
      executionResult = runControllerRecovery({
        plan, planState, plannerObserved: activePlannerObserved, runSummary,
        sessionId: controllerThreadId, failure: error?.message || String(error),
      });
    }
  }
  let rawOutput = executionResult.output;
  let reviewState = null;
  if (planState.reviewIds.length > 0) {
    reviewState = runReview({
      request, plan, planState, executionResult, plannerObserved: activePlannerObserved, runSummary, round: 1,
    });
    if (reviewState.route === "execution") {
      executionResult = runExecutionCorrection({
        request, plan, planState, reviewState, plannerObserved: activePlannerObserved, runSummary,
        sessionId: executionResult.observed?.observed?.thread_id || "",
      });
      rawOutput = executionResult.output;
      reviewState = runReview({
        request, plan, planState, executionResult, plannerObserved: activePlannerObserved, runSummary, round: 2,
      });
    } else if (reviewState.route === "planning") {
      const replanned = runIncrementalReplan({
        request, plan, planState, reviewState, plannerObserved: activePlannerObserved, runSummary,
        sessionId: controllerThreadId, role: routingMode === "stage" ? "controller" : "planner",
        directOwner,
      });
      plan = replanned.plan;
      planState = replanned.planState;
      activePlannerObserved = replanned.observed;
      if (planState.reviewIds.length === 0) {
        fail("增量重规划必须保留 finding 所涉验收 ID 的独立复验");
      }
      executionResult = runSelectedExecution({
        plan, planState, plannerObserved: activePlannerObserved, runSummary, suffix: "-recovery",
        sessionId: planState.execute === "controller" ? controllerThreadId : "",
      });
      rawOutput = executionResult.output;
      reviewState = runReview({
        request, plan, planState, executionResult, plannerObserved: activePlannerObserved, runSummary, round: 2,
      });
    }
  }
  const output = planState.mode === "direct"
    ? `${String(rawOutput || "").trim()}\n`
    : renderDelivery(rawOutput, planState.acceptance, reviewState, planState.reviewIds);
  writeFileSync(outputFile, output, "utf8");
  runSummary.completed_at = new Date().toISOString();
  runSummary.initial_execute = initialExecute;
  runSummary.execute = planState.execute;
  runSummary.initial_review_ids = initialReviewIds;
  runSummary.review_ids = planState.reviewIds;
  runSummary.execution_context = planState.mode === "direct"
    ? `${directOwner}-direct-same-context`
    : planState.execute === "controller"
      ? "controller-resumed-same-context"
      : "bounded-fresh-execution-context";
  runSummary.controller_context = routingMode === "stage" ? "persistent-task-thread" : "host-owned-no-model-call";
  runSummary.review_status = reviewState?.status || "not-requested";
  runSummary.review_route = reviewState?.route || "none";
  runSummary.duration_ms = Date.now() - runStarted;
  runSummary.totals = summarizeRoles(runSummary.roles);
  writeFileSync(summaryFile, `${JSON.stringify(runSummary, null, 2)}\n`, "utf8");
  process.stdout.write(output);
  if (!output.endsWith("\n")) process.stdout.write("\n");
  if (reviewState?.status === "fail") process.exitCode = 1;
  else if (reviewState?.status === "unresolved") process.exitCode = 2;
} finally {
  if (!args.evidenceDir) rmSync(temporary, { recursive: true, force: true });
}

function runProviderRole(commandArgs, input, timeout = args.timeout) {
  if (args.codexBin) commandArgs.push("--codex-bin", args.codexBin);
  commandArgs.push("--timeout", String(timeout));
  const result = spawnSync(process.execPath, [roleRunner, ...commandArgs], {
    cwd: workdir,
    input,
    env: { ...process.env, ODAI_ROUTING_ACTIVE: "1" },
    encoding: "utf8",
    windowsHide: true,
    timeout: timeout * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(result.error.message);
  return { status: result.status, output: `${result.stdout || ""}${result.stderr || ""}` };
}

function executionContext() {
  return `原始用户请求由总控、planner 与 reviewer 保管，用于防遗漏、修正路由和最终验收；受托执行者只接收已经覆盖该请求的冻结方案，不重新解释或扩写需求。`;
}

function buildExecutionPrompt(role, plan, planState, plannerObserved) {
  return `按 odai 宿主已经核实的规划承担一次 ${role} 执行切片。只在规划的允许范围内形成真实产物，不重新规划、不扩大目标、不批准最终交付。

${executionContext()}

已核实规划（这是决定与边界的 owner，不要求重新证明）：
${plan}

planner 已核实的来源指针如下。不要为了复述规划而重读；只读取完成实际产物仍必需的实现原件：
${formatCapturedEvidence(plannerObserved, plan)}

${planState.reviewIds.length > 0
    ? `独立 reviewer 负责 ${planState.reviewIds.join(", ")} 的最终判定。不要先跑基线检查；完成改动后，每项必要验证只运行一次。只有检查失败并完成针对性修正后才可重跑。`
    : "不要先跑基线检查；完成改动后，每项闭合验收所需的检查只运行一次，失败并修正后才可重跑。"}
决定性验证成功且没有新的失败证据时立即停止分析与检索，直接形成回交和 closeout；不为再次解释、安心复核或等待 reviewer 继续推理。
回交时点名每份改变决定的权威来源路径；宿主会把未修改的来源原件纳入证据包，不能只说“已查阅”。执行中从权威来源取得的、会改变复验结果的准确对象、条件、输入或位置须保留，不能被规划中的宽泛说法或简洁摘要稀释。需要验证不自动授权修改测试、基准、文档或其他证据源；项目已点名现成验证入口时先原样运行，不能为了产生更漂亮或更完整的证据改变它。用户当前就要审阅或使用的正文、判断或其他内容必须在回交中自足给出；除非契约明确只交文件，文件路径不能替代实际内容。写入持久文件必须有请求、项目契约或规划对该载体的明确需要，不为暂存内容或证明完成自造文件。
新建或替换持久 owner 时，规划捕获的既有 owner 查找结果必须进入对应验收项与最终回交；没有可追溯证据才补最小查找，不重复已经捕获的调查。
指定验证器因当前入口或依赖失败时，先尝试用现有兼容入口运行同一验证器；不得把自写近似检查称为等价。权威项目原件已明确某项环境、入口或数据不存在，且当前授权不包含补建时，不再加载外部能力、安装工具或广泛搜索来重复证明缺失；准确保留未决与继续条件。规划中执行后仍成立的 stop 必须保留在面向用户的回交中。
完成后按宿主提供的结构化输出契约回交：delivery 是面向用户的简洁结果；acceptance 覆盖全部验收 ID：${planState.acceptance.map((item) => item.id).join(", ")}，每项给 status、实际 evidence 与 next。verified 的 next 必须为空，未决或失败必须给继续条件；未来仍需观察的属性写 unresolved。不得把 reviewer 尚未作出的判断写成独立验收通过。`;
}

function captureDirectCompletion({ plan, planState, plannerObserved, repositoryBefore, repositoryAfter, directRole = "planner" }) {
  const output = directExecutionOutput(plan);
  const packet = buildEvidencePacket({
    plan,
    planState,
    plannerObserved,
    executionObserved: plannerObserved,
    executionOutput: output,
    repositoryBefore,
    repositoryAfter,
  });
  const packetFile = path.join(evidenceDir, "evidence-packet-direct.json");
  writeFileSync(packetFile, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  return {
    role: directRole,
    output,
    evidence: plannerEvidence,
    observed: plannerObserved,
    packet,
    packetFile,
  };
}

function directExecutionOutput(plan) {
  const lines = String(plan || "").trim().split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim());
  if (first < 0 || !/^\s*mode\s*[:：]\s*direct\s*$/i.test(lines[first])) {
    fail("direct 交付的首个非空行必须且只能是 mode: direct");
  }
  const output = lines.slice(first + 1).join("\n").trim();
  if (!output) fail("direct 没有形成面向用户的完整交付");
  if (/<odai_(?:delivery|closeout|plan)>/i.test(output)) {
    fail("direct 交付不得包含内部路由标签");
  }
  return output;
}

function runSelectedExecution({ plan, planState, plannerObserved, runSummary, suffix, sessionId = "" }) {
  const role = planState.execute;
  const roleOutput = path.join(evidenceDir, `${role}-result${suffix}.txt`);
  const roleEvidence = path.join(evidenceDir, `${role}-runtime${suffix}.json`);
  const roleLog = path.join(evidenceDir, `${role}${suffix}.log`);
  const before = captureRepositoryState();
  const rolePrompt = buildExecutionPrompt(role, plan, planState, plannerObserved);
  const command = [
    "--role", role, "--manifest", manifestFile, "--cwd", workdir,
    "--output", roleOutput, "--evidence", roleEvidence, "--sandbox", args.sandbox,
    "--closeout-ids", planState.acceptance.map((item) => item.id).join(","),
  ];
  if (sessionId) command.push("--session-id", sessionId);
  const executed = runProviderRole(command, rolePrompt);
  writeFileSync(roleLog, executed.output, "utf8");
  if (executed.status !== 0) fail(`${role} 执行失败：${tail(executed.output)}`);
  const observed = readJson(roleEvidence, `${role} 运行证据`);
  requireObservedRole(role, observed);
  if (sessionId) requireSameThread(sessionId, observed, role);
  runSummary.roles.push(roleSummary(`${role}${suffix}`, observed));
  if (routingMode === "stage") {
    runSummary.stage_transitions.push({
      stage: "implementation",
      role,
      reason: sessionId
        ? role === "controller" ? "same-controller-continued-after-read-only-route" : "finding-correction-in-original-execution-context"
        : "frozen-bounded-work-in-fresh-context",
      thread_id: observed.observed?.thread_id || null,
    });
  }
  const output = existsSync(roleOutput) ? readFileSync(roleOutput, "utf8").trim() : executed.output.trim();
  validateCloseout(output, planState.acceptance, `${role} 回交`);
  const packet = buildEvidencePacket({
    plan,
    planState,
    plannerObserved,
    executionObserved: observed,
    executionOutput: output,
    repositoryBefore: before,
    repositoryAfter: captureRepositoryState(),
  });
  const packetFile = path.join(evidenceDir, `evidence-packet${suffix}.json`);
  writeFileSync(packetFile, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  return {
    role,
    output,
    evidence: roleEvidence,
    observed,
    packet,
    packetFile,
  };
}

function runControllerRecovery({ plan, planState, plannerObserved, runSummary, sessionId, failure }) {
  const roleOutput = path.join(evidenceDir, "controller-recovery-result.txt");
  const roleEvidence = path.join(evidenceDir, "controller-recovery-runtime.json");
  const roleLog = path.join(evidenceDir, "controller-recovery.log");
  const before = captureRepositoryState();
  const prompt = `执行阶段出现了可观察失败，宿主现已把同一任务线程升回 controller 档。你仍是原总控；不要重做完整调查，也不要为失败扩大目标。

冻结路线：
${plan}

执行失败：
${failure}

只检查失败实际暴露的缺口。路线仍成立时，在原边界内完成最小修正与必要验证；新证据推翻决定时，只修正受影响决定后继续完成。不得丢失验收 ID：${planState.acceptance.map((item) => item.id).join(", ")}。
按宿主提供的结构化输出契约回交，delivery 给面向用户的简洁结果，acceptance 覆盖全部验收 ID；每项包含 status、实际 evidence 与 next，verified 的 next 为空，未决或失败时给真实继续条件。`;
  const recovered = runProviderRole([
    "--role", "controller", "--manifest", manifestFile, "--cwd", workdir,
    "--output", roleOutput, "--evidence", roleEvidence, "--sandbox", args.sandbox,
    "--closeout-ids", planState.acceptance.map((item) => item.id).join(","),
    "--session-id", sessionId,
  ], prompt);
  writeFileSync(roleLog, recovered.output, "utf8");
  if (recovered.status !== 0) fail(`controller 升档恢复失败：${tail(recovered.output)}`);
  const observed = readJson(roleEvidence, "controller 升档恢复证据");
  requireObservedRole("controller", observed);
  requireSameThread(sessionId, observed, "controller");
  runSummary.roles.push(roleSummary("controller-recovery", observed));
  runSummary.stage_transitions.push({ stage: "recovery", role: "controller", reason: "execution-failure", thread_id: sessionId });
  const output = existsSync(roleOutput) ? readFileSync(roleOutput, "utf8").trim() : recovered.output.trim();
  validateCloseout(output, planState.acceptance, "controller 恢复回交");
  const packet = buildEvidencePacket({
    plan,
    planState,
    plannerObserved,
    executionObserved: observed,
    executionOutput: output,
    repositoryBefore: before,
    repositoryAfter: captureRepositoryState(),
    executionFailure: failure,
  });
  const packetFile = path.join(evidenceDir, "evidence-packet-controller-recovery.json");
  writeFileSync(packetFile, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  return { role: "controller", output, evidence: roleEvidence, observed, packet, packetFile };
}

function isRecoverableExecutionError(error) {
  const message = String(error?.message || error || "");
  return !/(实际模型不匹配|恢复了错误线程|没有恢复总控线程|路由清单|托管安装)/.test(message);
}

function runReview({ request: userRequest, plan, planState, executionResult, plannerObserved, runSummary, round }) {
  const suffix = round === 1 ? "" : `-${round}`;
  const resultFile = path.join(evidenceDir, `reviewer-result${suffix}.txt`);
  const evidenceFile = path.join(evidenceDir, `reviewer-runtime${suffix}.json`);
  const logFile = path.join(evidenceDir, `reviewer${suffix}.log`);
  const reviewPrompt = `独立验收当前实际产物。宿主已经提供自足的不可变证据包；不得调用工具、读取仓库或重复运行已经成功的确定性检查。先核对完整 accept 是否覆盖原始请求中每个会改变结果的要求；遗漏属于方案或验收设计缺陷，使用 route: planning。覆盖成立后，只检查定路中点名的这些 ID：${planState.reviewIds.join(", ")}。

宿主不可变证据包（${executionResult.packetFile}，其中用户请求、规划与执行回交各只有一份）：
${JSON.stringify(executionResult.packet, null, 2)}

只依据以上方案、回交与证据包作出判断。执行输出和执行者新写的验证记录都只是主张；命令、退出码与输出只认 execution.observed.verification_evidence，且命令本身必须能产生所声称的观察。证据缺失或互相冲突时，不自行重新取证：方案或验收设计有误用 route: planning，实施偏差用 route: execution，缺用户决定或外部条件用 unresolved 的相应 route。finding 不授权新增证明文件，只指出原产物的最小修正或应取得的真实观察。首行只写 pass、fail 或 unresolved；第二行按角色契约只写 route。随后逐项给出证据、最小修正或继续条件。不得自行修复。`;
  const reviewed = runProviderRole([
    "--role", "reviewer", "--manifest", manifestFile, "--cwd", workdir,
    "--output", resultFile, "--evidence", evidenceFile,
  ], reviewPrompt);
  writeFileSync(logFile, reviewed.output, "utf8");
  if (reviewed.status !== 0) fail(`reviewer 验收失败：${tail(reviewed.output)}`);
  const observed = readJson(evidenceFile, "reviewer 运行证据");
  requireObservedRole("reviewer", observed);
  if (observed.observed?.tool_use_detected === true) {
    fail("reviewer 已收到完整宿主证据包却仍调用工具，拒绝把重复取证计作有效验收");
  }
  runSummary.roles.push(roleSummary(`reviewer-${round}`, observed));
  runSummary.stage_transitions.push({ stage: "review", role: "reviewer", reason: "independent-acceptance-can-change-release" });
  const output = existsSync(resultFile) ? readFileSync(resultFile, "utf8").trim() : reviewed.output.trim();
  return { ...parseReviewDecision(output), output, round };
}

function runIncrementalReplan({ request: userRequest, plan, planState, reviewState, plannerObserved, runSummary, sessionId = "", role = "planner", directOwner = "planner" }) {
  const resultFile = path.join(evidenceDir, `${role}-replan.txt`);
  const evidenceFile = path.join(evidenceDir, `${role}-replan-runtime.json`);
  const logFile = path.join(evidenceDir, `${role}-replan.log`);
  const prompt = `这是 reviewer 已判定为 route: planning 的增量重规划。只处理 finding 推翻的决定；不要重做首次调查、编辑文件或实施。

用户请求：
${userRequest}

当前规划：
${plan}

首次规划已取得的证据：
${formatCapturedEvidence(plannerObserved, plan)}

独立验收 finding：
${reviewState.output}

只利用已有证据做增量修正，不重复首次调查；仅当 finding 明确指出证据包缺少一个会改变路线的事实时，才补取该事实。返回同一格式的完整替换路由。保留未受影响验收 ID；为 finding 涉及且现已可取得证据的属性继续点名 reviewer。`;
  const command = [
    "--role", role, "--manifest", manifestFile, "--cwd", workdir,
    "--output", resultFile, "--evidence", evidenceFile,
  ];
  if (sessionId) command.push("--session-id", sessionId);
  else if (role === "planner") command.push("--planner-may-complete-direct");
  const replanned = runProviderRole(command, prompt);
  writeFileSync(logFile, replanned.output, "utf8");
  if (replanned.status !== 0) fail(`${role} 增量重规划失败：${tail(replanned.output)}`);
  const observed = readJson(evidenceFile, `${role} 增量重规划证据`);
  requireObservedRole(role, observed);
  if (sessionId) requireSameThread(sessionId, observed, role);
  runSummary.roles.push(roleSummary(`${role}-replan`, observed));
  if (sessionId) runSummary.stage_transitions.push({ stage: "decision", role, reason: "review-invalidated-route", thread_id: sessionId });
  const nextPlan = existsSync(resultFile) ? readFileSync(resultFile, "utf8").trim() : replanned.output.trim();
  const nextState = validatePlan(nextPlan, directOwner);
  const nextIds = new Set(nextState.acceptance.map((item) => item.id));
  const lost = planState.reviewIds.filter((id) => !nextIds.has(id));
  if (lost.length > 0) fail(`增量重规划丢失 finding 所涉验收 ID：${lost.join(", ")}`);
  return { plan: nextPlan, planState: nextState, observed };
}

function runExecutionCorrection({ plan, planState, reviewState, plannerObserved, runSummary, sessionId = "" }) {
  const role = planState.execute;
  const resultFile = path.join(evidenceDir, `${role}-repair-result.txt`);
  const evidenceFile = path.join(evidenceDir, `${role}-repair-runtime.json`);
  const logFile = path.join(evidenceDir, `${role}-repair.log`);
  const prompt = `reviewer 已将 finding 判定为实施偏差，原规划仍成立。你是原执行承载 ${role}；只修正 finding 指向的实际产物，不重新规划、不扩大范围、不改写验收源，也不批准最终交付。

已核实规划：
${plan}

[首次规划证据]
${formatCapturedEvidence(plannerObserved, plan)}

[独立验收 finding]
${reviewState.output}

finding 只授权修正原产物，不授权新建验证报告、检查日志或其他交付外文件。需要补证时运行能真实判定该属性的现有检查并回交宿主捕获的原始命令结果；检查不存在或当前不可运行就保留未决，不能用注释、示例输出、自写记录或叙述替代执行证据。

不要重复首次调查或已经成功且未受 finding 影响的检查。完成最小修正与相称验证后，按宿主提供的结构化输出契约回交：delivery 给面向用户的简洁结果，acceptance 覆盖 ${planState.acceptance.map((item) => item.id).join(", ")}；每项含 status、实际 evidence 与 next，verified 的 next 为空，未闭合项给真实继续条件。宿主与 reviewer 负责最终收口。`;
  const before = captureRepositoryState();
  const command = [
    "--role", role, "--manifest", manifestFile, "--cwd", workdir,
    "--output", resultFile, "--evidence", evidenceFile, "--sandbox", args.sandbox,
    "--closeout-ids", planState.acceptance.map((item) => item.id).join(","),
  ];
  if (sessionId) command.push("--session-id", sessionId);
  const repaired = runProviderRole(command, prompt);
  writeFileSync(logFile, repaired.output, "utf8");
  if (repaired.status !== 0) fail(`${role} 修正失败：${tail(repaired.output)}`);
  const observed = readJson(evidenceFile, `${role} 修正证据`);
  requireObservedRole(role, observed);
  if (sessionId) requireSameThread(sessionId, observed, role);
  runSummary.roles.push(roleSummary(`${role}-repair`, observed));
  if (sessionId) runSummary.stage_transitions.push({ stage: "implementation", role, reason: "review-found-execution-defect", thread_id: sessionId });
  const output = existsSync(resultFile) ? readFileSync(resultFile, "utf8").trim() : repaired.output.trim();
  validateCloseout(output, planState.acceptance, `${role} 修正回交`);
  const packet = buildEvidencePacket({
    plan,
    planState,
    plannerObserved,
    executionObserved: observed,
    executionOutput: output,
    repositoryBefore: before,
    repositoryAfter: captureRepositoryState(),
    reviewFinding: reviewState.output,
  });
  const packetFile = path.join(evidenceDir, "evidence-packet-repair.json");
  writeFileSync(packetFile, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  return {
    role,
    output,
    evidence: evidenceFile,
    observed,
    packet,
    packetFile,
  };
}

function formatCapturedEvidence(evidence, plan) {
  const observed = evidence?.observed || {};
  const compact = {
    provider: observed.provider || evidence?.requested?.provider || null,
    models: observed.models || [],
    cited_paths: plannerEvidencePointers(plan),
  };
  return JSON.stringify(compact, null, 2);
}

function plannerEvidencePointers(plan) {
  const seen = new Set();
  const pointers = [];
  const source = String(plan || "");
  const candidates = [
    ...[...source.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1]),
    ...[...source.matchAll(/\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g)].map((match) => match[1]),
    ...[...source.matchAll(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b/g)].map((match) => match[0]),
  ];
  for (const rawCandidate of candidates) {
    const raw = String(rawCandidate || "").trim().replace(/(?::\d+)?(?:#.*)?$/, "");
    if (!raw || raw.includes(" ") || raw.includes("*") || /^[a-z]+:\/\//i.test(raw)) continue;
    const file = path.resolve(workdir, raw.replace(/^\.\//, ""));
    if (file !== workdir && !file.startsWith(`${workdir}${path.sep}`)) continue;
    if (!existsSync(file)) continue;
    const candidate = path.relative(workdir, file) || ".";
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    pointers.push(candidate);
  }
  return pointers;
}

function captureCitedSources(value, repositoryBefore, repositoryAfter) {
  const changed = repositoryChangedPaths(repositoryBefore, repositoryAfter);
  let remaining = 50000;
  return plannerEvidencePointers(value).flatMap((relativePath) => {
    if (changed.has(relativePath)) return [];
    if (remaining <= 0) return [];
    try {
      const data = readFileSync(path.resolve(workdir, relativePath));
      if (data.includes(0)) return [{ path: relativePath, content: "[binary file omitted]" }];
      const content = clip(data.toString("utf8"), Math.min(remaining, 20000));
      remaining -= content.length;
      return [{ path: relativePath, content }];
    } catch {
      return [{ path: relativePath, content: "[unreadable file]" }];
    }
  });
}

function repositoryChangedPaths(before, after) {
  const candidates = new Set();
  for (const state of [before, after]) {
    for (const item of state?.untracked_files || []) candidates.add(item.path);
    for (const line of String(state?.status?.output || "").split(/\r?\n/)) {
      if (line.length < 4) continue;
      const pathText = line.slice(3).trim();
      const parts = pathText.includes(" -> ") ? pathText.split(" -> ") : [pathText];
      for (const item of parts) if (item) candidates.add(item.replace(/^"|"$/g, ""));
    }
  }
  return new Set([...candidates].filter((relativePath) => repositoryPathSignature(before, relativePath) !== repositoryPathSignature(after, relativePath)));
}

function repositoryPathSignature(state, relativePath) {
  const statusLines = String(state?.status?.output || "").split(/\r?\n/)
    .filter((line) => line.slice(3).trim().split(" -> ").some((item) => item.replace(/^"|"$/g, "") === relativePath));
  const diffBlocks = [state?.unstaged_diff?.output, state?.staged_diff?.output]
    .flatMap((value) => String(value || "").split(/(?=^diff --git )/m))
    .filter((block) => block.startsWith("diff --git ") && block.split(/\r?\n/, 1)[0].includes(` b/${relativePath}`));
  const untracked = (state?.untracked_files || []).find((item) => item.path === relativePath) || null;
  return JSON.stringify({ statusLines, diffBlocks, untracked });
}

function buildEvidencePacket({
  plan,
  planState,
  plannerObserved,
  executionObserved,
  executionOutput,
  repositoryBefore,
  repositoryAfter,
  reviewFinding = null,
  executionFailure = null,
}) {
  return {
    version: 1,
    immutable: true,
    request,
    plan,
    acceptance: planState.acceptance,
    review_ids: planState.reviewIds,
    planner: {
      requested: plannerObserved?.requested || null,
      observed: pickRoleIdentityEvidence(plannerObserved?.observed),
    },
    execution: {
      requested: executionObserved?.requested || null,
      observed: {
        ...pickRoleIdentityEvidence(executionObserved?.observed),
        verification_evidence: pickExecutionVerificationEvidence(executionObserved?.observed?.tool_evidence || []),
        cited_sources: captureCitedSources(executionOutput, repositoryBefore, repositoryAfter),
      },
      output: executionOutput,
    },
    repository: {
      before: repositoryBefore,
      after: repositoryAfter,
    },
    prior_review_finding: reviewFinding,
    prior_execution_failure: executionFailure,
  };
}

function pickRoleIdentityEvidence(observed = {}) {
  return {
    provider: observed.provider || null,
    models: observed.models || [],
    model_verified: observed.model_verified === true,
    reasoning_efforts: observed.reasoning_efforts || [],
    tool_use_detected: observed.tool_use_detected ?? null,
    usage: observed.usage || null,
    cost_usd: observed.cost_usd ?? null,
    duration_ms: observed.duration_ms ?? null,
    exit_code: observed.exit_code ?? null,
  };
}

function pickExecutionVerificationEvidence(items) {
  const lastChange = items.reduce((latest, item, index) => item?.type === "file_change" ? index : latest, -1);
  return items.flatMap((item, index) => {
    if (item?.type !== "command_execution" || item.status !== "completed") return [];
    const command = String(item.command || "").trim();
    if (!isVerificationCommand(command)) return [];
    return [{
      sequence: index,
      after_last_file_change: index > lastChange,
      command,
      status: item.status,
      exit_code: item.exit_code,
      output: clip(String(item.output || ""), 30000),
    }];
  });
}

function isVerificationCommand(command) {
  if (!command) return false;
  return /\bgit\s+(?:diff\s+--check|status\b)|\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|check|verify|lint|build|typecheck))\b|\b(?:pytest|go\s+test|cargo\s+test|make\s+(?:test|check|verify|lint|build))\b|\bnode\s+(?:--check|tests?\/|[^\s;|&]*?(?:test|check|verify|validate)[^\s;|&]*\.m?js\b)|\b(?:python3?|py\s+-3)\b[^\n]*(?:test|check|verify|validate)|\bassert(?:\.|\s|\()/i.test(command);
}

function captureRepositoryState() {
  const status = runGit(["status", "--short", "--untracked-files=all"]);
  return {
    status,
    unstaged_diff: runGit(["diff", "--no-ext-diff", "--binary", "--"]),
    staged_diff: runGit(["diff", "--cached", "--no-ext-diff", "--binary", "--"]),
    untracked_files: captureUntrackedFiles(),
  };
}

function captureUntrackedFiles() {
  const result = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--"], {
    cwd: workdir,
    encoding: "buffer",
    windowsHide: true,
    timeout: Math.min(args.timeout, 60) * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return [];
  const paths = result.stdout.toString("utf8").split("\0").filter(Boolean);
  let remaining = 100000;
  return paths.flatMap((relativePath) => {
    if (remaining <= 0) return [];
    const absolutePath = path.resolve(workdir, relativePath);
    if (absolutePath !== workdir && !absolutePath.startsWith(`${workdir}${path.sep}`)) return [];
    try {
      const data = readFileSync(absolutePath);
      if (data.includes(0)) return [{ path: relativePath, content: "[binary file omitted]" }];
      const content = clip(data.toString("utf8"), Math.min(remaining, 50000));
      remaining -= content.length;
      return [{ path: relativePath, content }];
    } catch {
      return [{ path: relativePath, content: "[unreadable file]" }];
    }
  });
}

function repositoryStateChanged(before, after) {
  return JSON.stringify(before || {}) !== JSON.stringify(after || {});
}

function runGit(commandArgs) {
  const result = spawnSync("git", commandArgs, {
    cwd: workdir,
    encoding: "utf8",
    windowsHide: true,
    timeout: Math.min(args.timeout, 60) * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    command: `git ${commandArgs.join(" ")}`,
    exit_code: result.status,
    output: clip(`${result.stdout || ""}${result.stderr || ""}`, 100000),
  };
}

function validateCloseout(value, acceptance, label) {
  const parsed = parseCloseout(value, label);
  const expected = new Set(acceptance.map((item) => item.id));
  const unknown = Object.keys(parsed).filter((id) => !expected.has(id));
  if (unknown.length > 0) fail(`${label} 的 closeout 含未知验收 ID：${unknown.join(", ")}`);
  for (const item of acceptance) {
    const report = parsed[item.id];
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      fail(`${label} 的 closeout 缺少 ${item.id}`);
    }
    const unknownFields = Object.keys(report).filter((name) => !new Set(["status", "evidence", "next"]).has(name));
    if (unknownFields.length > 0) {
      fail(`${label} 的 closeout 中 ${item.id} 含未知字段：${unknownFields.join(", ")}`);
    }
    if (!new Set(["verified", "unresolved", "failed"]).has(report.status)) {
      fail(`${label} 的 closeout 中 ${item.id} 状态无效`);
    }
    if (!cleanInline(report.evidence)) fail(`${label} 的 closeout 中 ${item.id} 缺少实际证据`);
    const next = cleanInline(report.next);
    if (report.status === "verified" && next) {
      fail(`${label} 的 closeout 中 ${item.id} 已写 verified 却仍有继续条件`);
    }
    if (report.status !== "verified" && !next) {
      fail(`${label} 的 closeout 中 ${item.id} 未闭合却缺少继续条件`);
    }
  }
  return parsed;
}

function parseCloseout(value, label = "交付") {
  const blocks = [...String(value || "").matchAll(/<odai_closeout>\s*([\s\S]*?)\s*<\/odai_closeout>/gi)];
  if (blocks.length !== 1) fail(`${label} 必须且只能包含一个 <odai_closeout>`);
  try {
    const parsed = parseCloseoutJson(blocks[0][1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("根节点不是对象");
    return parsed;
  } catch (error) {
    fail(`${label} 的 closeout 不是有效 JSON：${error.message}`);
  }
}

function parseCloseoutJson(value) {
  const text = String(value || "").trim();
  try {
    return JSON.parse(text);
  } catch (originalError) {
    if (!text.startsWith("{")) throw originalError;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      if (depth !== 0) continue;
      const trailing = text.slice(index + 1).trim();
      if (!trailing || !/^}+$/.test(trailing)) throw originalError;
      return JSON.parse(text.slice(0, index + 1));
    }
    throw originalError;
  }
}

function clip(value, limit) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

function parseReviewDecision(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines[0] || "";
  const match = /^(pass|fail|unresolved)\b/i.exec(first);
  if (!match) fail("reviewer 回执首行必须是 pass、fail 或 unresolved");
  const routeMatch = /^route\s*:\s*(none|execution|planning|user|blocked)\s*$/i.exec(lines[1] || "");
  if (!routeMatch) fail("reviewer 回执第二行必须是 route: none、execution、planning、user 或 blocked");
  const status = match[1].toLowerCase();
  const route = routeMatch[1].toLowerCase();
  const allowed = {
    pass: new Set(["none"]),
    fail: new Set(["execution", "planning"]),
    unresolved: new Set(["planning", "user", "blocked"]),
  };
  if (!allowed[status].has(route)) fail(`reviewer 回执组合无效：${status} / ${route}`);
  return { status, route };
}

function requireObservedRole(role, evidence) {
  const expected = manifest.mapping?.[role];
  const observed = evidence?.observed || {};
  if (!observed.model_verified || !Array.isArray(observed.models) || observed.models.length === 0) {
    fail(`${role} 没有形成可核实的实际模型证据`);
  }
  if ((expected?.provider || manifest.host) === "codex" && !observed.models.includes(expected.model)) {
    fail(`${role} 实际模型不匹配：期望 ${expected.model}，实际 ${observed.models.join(", ")}`);
  }
}

function requireSameThread(expected, evidence, role) {
  const actual = String(evidence?.observed?.thread_id || "");
  if (!actual || actual !== expected) {
    fail(`${role} 没有恢复总控线程：期望 ${expected}，实际 ${actual || "unknown"}`);
  }
}

function roleSummary(role, evidence) {
  return {
    role,
    requested: evidence.requested || null,
    observed: evidence.observed || null,
  };
}

function summarizeRoles(roles) {
  const total = {
    calls: roles.length,
    duration_ms: 0,
    cost_usd_known: 0,
    cost_usd_complete: true,
    usage: {},
    models: [],
  };
  const models = new Set();
  for (const item of roles) {
    const observed = item?.observed || {};
    total.duration_ms += Number(observed.duration_ms) || 0;
    if (Number.isFinite(Number(observed.cost_usd))) total.cost_usd_known += Number(observed.cost_usd);
    else total.cost_usd_complete = false;
    for (const model of observed.models || []) models.add(model);
    for (const [key, value] of Object.entries(observed.usage || {})) {
      if (Number.isFinite(Number(value))) total.usage[key] = (total.usage[key] || 0) + Number(value);
    }
  }
  total.models = [...models];
  total.cost_usd_known = Number(total.cost_usd_known.toFixed(6));
  return total;
}

function normalizePlanCard(value) {
  const source = String(value || "").trim();
  const wrapped = /<odai_(delivery|plan)(?:\s+[^>]*)?>\s*([\s\S]*?)\s*<\/odai_\1>/i.exec(source);
  if (!wrapped) return normalizeAcceptanceIds(normalizeReviewField(source));
  let parsed;
  try {
    parsed = JSON.parse(wrapped[2]);
  } catch {
    return normalizeAcceptanceIds(source);
  }
  const declaredMode = String(parsed?.status || parsed?.mode || parsed?.route
    || (wrapped[1].toLowerCase() === "plan" ? "planned" : "")).toLowerCase();
  if (declaredMode !== "planned") return source;
  const required = ["target", "evidence", "scope", "decision", "execute", "review", "accept", "stop"];
  if (required.some((key) => parsed[key] == null)) return source;
  const list = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
  const scalar = (value) => typeof value === "string" ? value : JSON.stringify(value);
  const rawReview = parsed.review && typeof parsed.review === "object" && !Array.isArray(parsed.review)
    ? parsed.review.accept_ids ?? parsed.review.ids ?? []
    : parsed.review;
  const reviewIds = list(rawReview).flatMap((value) => String(value).match(/\b[A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b/g) || []);
  const acceptance = parsed.accept && typeof parsed.accept === "object" && !Array.isArray(parsed.accept)
    ? Object.entries(parsed.accept)
    : list(parsed.accept).map((condition, index) => [`A${index + 1}`, condition]);
  const steps = list(parsed.steps ?? parsed.slices);
  return normalizeAcceptanceIds(normalizeReviewField([
    "mode: planned",
    `target: ${scalar(parsed.target)}`,
    `evidence: ${scalar(parsed.evidence)}`,
    `scope: ${scalar(parsed.scope)}`,
    `decision: ${scalar(parsed.decision)}`,
    `execute: ${scalar(parsed.execute)}`,
    `review: ${reviewIds.length > 0 ? `reviewer ${reviewIds.join(" ")}` : "none"}`,
    "accept:",
    ...acceptance.map(([id, condition]) => `- ${id}: ${scalar(condition)}`),
    `stop: ${scalar(parsed.stop)}`,
    ...(steps.length > 0 ? ["steps:", ...steps.map((item) => `- ${scalar(item)}`)] : []),
  ].join("\n")));
}

function normalizeReviewField(value) {
  const source = String(value || "").trim();
  if (field(source, "mode").toLowerCase() !== "planned") return source;
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => topLevelFieldLine("review").test(line));
  if (start < 0) return source;
  const inline = /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?review\s*[:：]\s*(\S[\s\S]*)?\s*$/i.exec(lines[start]);
  if (inline?.[1]) return source;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (["target", "evidence", "scope", "decision", "execute", "accept", "stop", "steps?", "slices?"]
      .some((name) => topLevelFieldLine(name).test(lines[index]))) {
      end = index;
      break;
    }
  }
  const section = lines.slice(start + 1, end).join("\n");
  if (/^\s*(?:[-*]\s*)?none\s*$/im.test(section)) {
    lines.splice(start, end - start, "review: none");
    return lines.join("\n");
  }
  const ids = [...new Set(expandReviewIds(section))];
  if (!/\breviewer\b/i.test(section) || ids.length === 0) return source;
  lines.splice(start, end - start, "review: reviewer " + ids.join(" "));
  return lines.join("\n");
}

function normalizeAcceptanceIds(value) {
  const source = String(value || "").trim();
  if (field(source, "mode").toLowerCase() !== "planned") return source;
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => topLevelFieldLine("accept").test(line));
  if (start < 0) return source;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (["stop", "steps?", "slices?"].some((name) => topLevelFieldLine(name).test(lines[index]))) {
      end = index;
      break;
    }
  }
  const explicit = new Set();
  for (const line of lines.slice(start + 1, end)) {
    const match = /^\s*(?:[-*]\s*)?([A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)(?:\s*[:：]\s*|\s+)(\S[\s\S]*)$/i.exec(line);
    if (match) explicit.add(match[1].toUpperCase());
  }
  let next = 1;
  const generatedId = () => {
    while (explicit.has(`A${next}`)) next += 1;
    const id = `A${next}`;
    explicit.add(id);
    next += 1;
    return id;
  };
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*(?:[-*]\s*)?([A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)(?:\s*[:：]\s*|\s+)\S/i.test(lines[index])) continue;
    const implicit = /^\s*(?:[-*]\s+|\d+[.)]\s+)(\S[\s\S]*)$/.exec(lines[index]);
    if (implicit) lines[index] = `- ${generatedId()}: ${implicit[1].trim()}`;
  }
  return lines.join("\n");
}

function stripInternalBlocks(value) {
  return String(value || "")
    .replace(/<odai_(?:plan|closeout)(?:\s+[^>]*)?>[\s\S]*?<\/odai_(?:plan|closeout)>/gi, "")
    .trim();
}

function validatePlan(value, directOwner = "planner") {
  if (!value) fail("planner 没有形成路由或交付");
  const first = String(value).split(/\r?\n/).find((line) => line.trim()) || "";
  if (!/^\s*mode\s*[:：]\s*(direct|planned)\s*$/i.test(first)) {
    fail("planner 规划路由无效：首个非空行必须且只能是 mode: direct 或 mode: planned");
  }
  const mode = field(value, "mode").toLowerCase();
  if (mode === "direct") {
    if (countTopLevelFields(value, "mode") !== 1) fail("direct 交付的 mode 不得重复");
    directExecutionOutput(value);
    return { mode, acceptance: [], execute: directOwner, reviewIds: [] };
  }
  const requiredFields = ["mode", "target", "evidence", "scope", "decision", "execute", "review", "accept", "stop"];
  const missing = requiredFields.filter((name) => !hasTopLevelField(value, name));
  if (missing.length > 0) fail(`planner 规划路由无效，缺少：${missing.join(", ")}`);
  const duplicated = requiredFields.filter((name) => {
    return countTopLevelFields(value, name) > 1;
  });
  if (duplicated.length > 0) {
    fail(`planner 规划路由无效：顶层字段不得重复：${duplicated.join(", ")}`);
  }
  const normalizedMode = mode;
  const execute = field(value, "execute").toLowerCase().match(/^(?:controller|executor)\b/)?.[0] || "";
  if (!execute) fail("规划路由无效：planned 的 execute 只能是 controller 或 executor");
  const acceptance = parseAcceptance(value);
  if (acceptance.length === 0) fail("planner 规划路由无效：accept 下必须有逐项、非空的验收条件");
  const reviewIds = validateReview(value, acceptance);
  if (/<odai_(?:delivery|closeout)>/i.test(value)) {
    fail("planner 规划路由无效：planned 尚未实施，不能输出交付或 closeout");
  }
  return { mode: normalizedMode, acceptance, execute, reviewIds };
}

function validateReview(value, acceptance) {
  const review = field(value, "review");
  if (/^none(?:\b|[；;])/i.test(review)) return [];
  if (!/\breviewer\b/i.test(review)) {
    fail("planner 规划路由无效：review 只能是 none，或点名 reviewer 与验收 ID");
  }
  if (/\bnone\b/i.test(review)) fail("planner 规划路由无效：reviewer 路由不能混入 none");
  if (/\b[A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\s*(?:等|等等|及其他)(?:\s|$|[，,；;])|(?:全部|所有)验收/i.test(review)) {
    fail("planner 规划路由无效：reviewer 路由不能使用开放式验收缩写");
  }
  const known = new Set(acceptance.map((item) => item.id));
  const ids = expandReviewIds(review);
  if (ids.length === 0) fail("planner 规划路由无效：reviewer 路由必须点名待判定的验收 ID");
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) fail(`planner 规划路由无效：review 引用了未知验收 ID ${[...new Set(unknown)].join(", ")}`);
  return [...new Set(ids)];
}

function expandReviewIds(value) {
  const source = String(value || "");
  const ids = [];
  const ranges = [];
  const rangePattern = /\b([A-Za-z][A-Za-z0-9_-]*?)(\d+)\s*[-–—]\s*\1(\d+)\b/gi;
  let match;
  while ((match = rangePattern.exec(source))) {
    const start = Number(match[2]);
    const end = Number(match[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 99) {
      fail(`planner 规划路由无效：无法展开验收范围 ${match[0]}`);
    }
    const prefix = match[1].toUpperCase();
    for (let index = start; index <= end; index += 1) ids.push(`${prefix}${index}`);
    ranges.push([match.index, match.index + match[0].length]);
  }
  const outsideRanges = [...source]
    .map((character, index) => ranges.some(([start, end]) => index >= start && index < end) ? " " : character)
    .join("");
  for (const exact of outsideRanges.matchAll(/\b[A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b/g)) {
    ids.push(exact[0].toUpperCase());
  }
  return ids;
}

function parseAcceptance(value) {
  const lines = String(value || "").split(/\r?\n/);
  const start = lines.findIndex((line) => topLevelFieldLine("accept").test(line));
  if (start < 0) return [];
  const result = [];
  const seen = new Set();
  for (const line of lines.slice(start + 1)) {
    if (["stop", "steps?", "slices?"].some((name) => topLevelFieldLine(name).test(line))) break;
    const match = /^\s*(?:[-*]\s*)?([A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)(?:\s*[:：]\s*|\s+)(\S[\s\S]*)$/i.exec(line);
    if (!match) continue;
    const id = match[1].toUpperCase();
    if (seen.has(id)) fail(`planner 规划路由无效：重复验收 ID ${id}`);
    seen.add(id);
    result.push({ id, condition: match[2].trim() });
  }
  return result;
}

function renderDelivery(raw, acceptance, reviewState = null, reviewIds = []) {
  const source = String(raw || "");
  const closeout = parseCloseout(source, "最终执行回交");
  const message = source.replace(/<odai_closeout>[\s\S]*?<\/odai_closeout>/gi, "").trim();
  const passedReviewIds = new Set(reviewState?.status === "pass" ? reviewIds : []);
  const verified = [];
  const open = [];
  for (const item of acceptance) {
    const report = closeout[item.id] && typeof closeout[item.id] === "object" ? closeout[item.id] : {};
    const promotedByReview = passedReviewIds.has(item.id) && report.status !== "verified";
    const status = passedReviewIds.has(item.id)
      ? "verified"
      : new Set(["verified", "unresolved", "failed"]).has(report.status)
      ? report.status
      : "unresolved";
    const evidence = promotedByReview
      ? ""
      : cleanInline(report.evidence || (status === "unresolved" ? "尚未提供足以闭合该项的证据" : ""));
    const next = cleanInline(report.next || "");
    if (status === "verified") {
      if (evidence && !includesLoose(message, evidence)) verified.push(evidence);
      continue;
    }
    const label = status === "failed" ? "未通过" : "未验证";
    const missingEvidence = evidence && !includesLoose(message, evidence) ? evidence : "";
    const missingNext = next && !includesLoose(message, next) ? next : "";
    if (!missingEvidence && !missingNext) continue;
    const details = [missingEvidence && `原因：${missingEvidence}`, missingNext && `继续条件：${missingNext}`].filter(Boolean).join("；");
    open.push(`- ${item.id} ${label}${details ? `：${details}` : ""}`);
  }
  const sections = [message];
  if (passedReviewIds.size > 0) sections.push(`独立验收：${[...passedReviewIds].join(", ")} 全部通过。`);
  if (verified.length > 0) sections.push(`验证：\n${verified.map((item) => `- ${item}`).join("\n")}`);
  if (open.length > 0) sections.push(`尚未闭合：\n${open.join("\n")}`);
  if (reviewState && reviewState.status !== "pass") {
    sections.push(`独立验收未闭合：\n${reviewState.output}`);
  }
  return `${sections.filter(Boolean).join("\n\n").trim()}\n`;
}

function cleanInline(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function includesLoose(message, value) {
  const normalize = (text) => String(text || "").toLowerCase().replace(/[\s`*_，。；：、,:;.!?()[\]{}'"“”‘’-]+/g, "");
  const needle = normalize(value);
  return needle.length >= 8 && normalize(message).includes(needle);
}

function field(value, name) {
  const match = new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${name}\\s*[:：]\\s*([^\\n]+)`, "i").exec(value);
  return String(match?.[1] || "").trim();
}

function topLevelFieldLine(name, flags = "i") {
  return new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:[-*]\\s*)?${name}(?:\\s*[:：]\\s*[^\\n]*)?\\s*$`, flags);
}

function hasTopLevelField(value, name) {
  return String(value || "").split(/\r?\n/).some((line) => topLevelFieldLine(name).test(line));
}

function countTopLevelFields(value, name) {
  return String(value || "").split(/\r?\n/).filter((line) => topLevelFieldLine(name).test(line)).length;
}

function readJson(file, label) {
  if (!existsSync(file)) fail(`缺少${label}：${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`无法读取${label}：${error.message}`);
  }
}

function parseArgs(argv) {
  const result = { cwd: "", output: "", sandbox: "workspace-write", manifest: "", codexBin: "", evidenceDir: "", timeout: 900, help: false };
  const fields = new Map([
    ["--cwd", "cwd"], ["--output", "output"], ["--sandbox", "sandbox"], ["--manifest", "manifest"],
    ["--codex-bin", "codexBin"],
    ["--evidence-dir", "evidenceDir"], ["--timeout", "timeout"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") result.help = true;
    else if (fields.has(value)) {
      const next = argv[++index] || "";
      if (!next || next.startsWith("--")) fail(`${value} 需要一个值`);
      result[fields.get(value)] = fields.get(value) === "timeout" ? Number(next) : next;
    } else fail(`未知参数：${value}`);
  }
  if (!Number.isFinite(result.timeout) || result.timeout <= 0) fail("--timeout 必须是正数秒数");
  return result;
}

function tail(value) {
  return String(value || "").trim().slice(-2000);
}

function fail(message) {
  throw new Error(message);
}
