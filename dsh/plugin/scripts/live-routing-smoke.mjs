import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnDsh } from "./dsh-process.mjs";
import { resolveControllerSelection, selectController } from "./live-routing-smoke-config.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "../..");
const pluginPath = [
  resolve(pluginRoot, "runtime/index.mjs"),
  resolve(pluginRoot, "../runtime/src/index.mjs"),
].find((candidate) => existsSync(candidate));
const args = parseArgs(process.argv.slice(2));
const workspaceRoot = resolve(args.cwd ?? process.env.INIT_CWD ?? process.cwd());
const skillPath = [
  resolve(pluginRoot, "skills/odai/SKILL.md"),
  resolve(repoRoot, "skills/odai/SKILL.md"),
].find((candidate) => existsSync(candidate));

if (!args.yes) {
  throw new Error("live routing calls external models; rerun with --yes after confirming cost and credentials");
}
if (!pluginPath) throw new Error("odai dsh runtime is unavailable in the package or source checkout");
if (!skillPath) throw new Error("odai canonical skill is unavailable in the package or source checkout");

const sourceHome = resolve(args.sourceHome ?? resolve(homedir(), ".dsh"));
const sourceSettings = resolve(sourceHome, "settings.yaml");
const sourceCredentials = resolve(sourceHome, ".credentials.yaml");
const scratch = await mkdtemp(resolve(tmpdir(), "odai-dsh-live-"));
const dshHome = resolve(scratch, "home");
const sessionRoot = resolve(dshHome, "sessions");
const evidenceRoot = resolve(dshHome, "odai", "session-evidence");
const patchPath = resolve(scratch, "routing.patch.yml");
const dsh = process.env.DSH_BIN ?? "dsh";

try {
  if (!existsSync(sourceSettings)) throw new Error(`dsh settings not found: ${sourceSettings}`);
  await mkdir(dshHome, { recursive: true });
  const sourceSettingsText = await readFile(sourceSettings, "utf8");
  const controller = resolveControllerSelection(sourceSettingsText, args);
  Object.assign(args, {
    controllerProvider: controller.provider,
    controllerModel: controller.model,
    controllerReasoning: controller.reasoningEffort,
  });
  await writeFile(resolve(dshHome, "settings.yaml"), selectController(sourceSettingsText, controller), "utf8");
  if (existsSync(sourceCredentials)) {
    await copyFile(sourceCredentials, resolve(dshHome, ".credentials.yaml"));
  }
  await writeFile(patchPath, renderPatch({
    pluginPath,
    skillPath,
    sessionRoot,
    plannerProvider: args.plannerProvider,
    plannerModel: args.plannerModel,
    plannerReasoning: args.plannerReasoning,
    mode: args.mode,
  }), "utf8");

  const startedAt = Date.now();
  const run = await runProcess(dsh, [
    "--profile",
    "headless",
    "--patch",
    patchPath,
    args.task,
  ], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: "DISABLED",
    },
    timeoutMs: args.timeoutMs,
  });
  const sessions = (await readSessions(sessionRoot, evidenceRoot)).map(summarizeSession);
  const verification = verifySmoke(sessions, args);
  const report = {
    ok: run.code === 0 && verification.ok,
    exitCode: run.code,
    signal: run.signal,
    elapsedMs: Date.now() - startedAt,
    requested: {
      mode: args.mode,
      controller: {
        provider: args.controllerProvider,
        model: args.controllerModel,
        reasoningEffort: args.controllerReasoning,
      },
      planner: args.plannerProvider === undefined ? null : {
        provider: args.plannerProvider,
        model: args.plannerModel,
        ...(args.plannerReasoning ? { reasoningEffort: args.plannerReasoning } : {}),
      },
    },
    verification,
    output: run.stdout.trim(),
    stderr: run.stderr.trim(),
    sessions,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function parseArgs(argv) {
  const parsed = {
    yes: false,
    sourceHome: undefined,
    cwd: undefined,
    controllerProvider: undefined,
    controllerModel: undefined,
    controllerReasoning: undefined,
    plannerProvider: undefined,
    plannerModel: undefined,
    plannerReasoning: undefined,
    mode: "default",
    timeoutMs: 360_000,
    task: "checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。请先核对当前工作区证据，不要修改文件。",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes") parsed.yes = true;
    else if (arg === "--source-home") parsed.sourceHome = argv[++index];
    else if (arg === "--cwd") parsed.cwd = argv[++index];
    else if (arg === "--controller-provider") parsed.controllerProvider = argv[++index];
    else if (arg === "--controller-model") parsed.controllerModel = argv[++index];
    else if (arg === "--controller-reasoning") parsed.controllerReasoning = argv[++index];
    else if (arg === "--planner-provider") parsed.plannerProvider = argv[++index];
    else if (arg === "--planner-model") parsed.plannerModel = argv[++index];
    else if (arg === "--planner-reasoning") parsed.plannerReasoning = argv[++index];
    else if (arg === "--mode") parsed.mode = argv[++index];
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number(argv[++index]);
    else if (arg === "--task") parsed.task = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }

  for (const field of [
    "controllerProvider",
    "controllerModel",
    "controllerReasoning",
    "plannerProvider",
    "plannerModel",
    "plannerReasoning",
  ]) {
    if (parsed[field] === undefined) continue;
    if (typeof parsed[field] !== "string" || parsed[field].trim() === "") {
      throw new Error(`${field} must be a non-empty string`);
    }
    parsed[field] = parsed[field].trim();
  }
  if (typeof parsed.task !== "string" || parsed.task.trim() === "") {
    throw new Error("task must be a non-empty string");
  }
  parsed.task = parsed.task.trim();
  if (!Number.isSafeInteger(parsed.timeoutMs) || parsed.timeoutMs < 1_000) {
    throw new Error("timeoutMs must be an integer of at least 1000");
  }
  if (!["default", "off", "observe", "auto", "execute"].includes(parsed.mode)) {
    throw new Error("mode must be default, off, observe, auto, or execute");
  }
  if ((parsed.controllerProvider === undefined) !== (parsed.controllerModel === undefined)) {
    throw new Error("controller provider and model must be supplied together");
  }
  if ((parsed.plannerProvider === undefined) !== (parsed.plannerModel === undefined)) {
    throw new Error("planner provider and model must be supplied together");
  }
  if (["auto", "execute"].includes(parsed.mode) && parsed.plannerProvider === undefined) {
    throw new Error(`${parsed.mode} mode requires an explicit --planner-provider and --planner-model`);
  }
  return parsed;
}

function renderPatch(input) {
  const quote = (value) => JSON.stringify(value);
  const planner = input.plannerProvider === undefined ? [] : [
    "          roles:",
    "            planner:",
    `              provider: ${quote(input.plannerProvider)}`,
    `              model: ${quote(input.plannerModel)}`,
    ...(input.plannerReasoning ? [`              reasoningEffort: ${quote(input.plannerReasoning)}`] : []),
    "              maxTokens: 2048",
  ];
  const routing = input.mode === "default" ? [] : [
    "        routing:",
    `          mode: ${input.mode}`,
    "          provider: spawn",
    ...planner,
  ];
  return [
    "- id: session-persistence-jsonl",
    "  config:",
    `    root: ${quote(input.sessionRoot)}`,
    "    compression: none",
    "    packChunks: false",
    "- insert:",
    "    - id: odai-governance-live-smoke",
    `      name: ${quote(input.pluginPath)}`,
    "      config:",
    `        skillPath: ${quote(input.skillPath)}`,
    ...routing,
    "",
  ].join("\n");
}

function verifySmoke(sessions, options) {
  const errors = [];
  const expectedMode = options.mode === "default" ? "auto-unconfigured" : options.mode;
  const expectedRoute = ["auto", "execute"].includes(options.mode)
    ? {
        provider: options.plannerProvider,
        model: options.plannerModel,
        reasoningEffort: options.plannerReasoning,
      }
    : {
        provider: options.controllerProvider,
        model: options.controllerModel,
        reasoningEffort: options.controllerReasoning,
      };
  const children = sessions.filter((session) => session.origin === "subagent");
  const controllers = sessions.filter((session) => session.origin !== "subagent");
  const events = controllers.flatMap((session) => session.routeEvents);
  const decision = events.find((event) => event.type === "odai/route-decided");
  const configMissing = events.find((event) => event.type === "odai/route-config-missing");
  const upgrade = events.find((event) => event.type === "odai/route-upgrade");
  const result = events.find((event) => event.type === "odai/route-result");
  const protection = events.find((event) => event.type === "odai/route-protection");
  const sameRoute = (route) => route?.provider === expectedRoute.provider
    && route?.model === expectedRoute.model
    && route?.reasoningEffort === expectedRoute.reasoningEffort;
  const controllerRoute = controllers
    .flatMap((session) => session.requestRoutes)
    .find(sameRoute);

  if (controllers.length !== 1) errors.push(`expected one controller session, found ${controllers.length}`);
  if (expectedMode === "off") {
    if (children.length !== 0) errors.push(`off mode started ${children.length} child sessions`);
    if (events.length !== 0) errors.push(`off mode emitted ${events.length} route events`);
  } else if (expectedMode === "observe") {
    if (children.length !== 0) errors.push(`observe mode started ${children.length} child sessions`);
    if (decision?.data?.role !== "controller"
      || decision?.data?.action !== "upgrade"
      || decision?.data?.targetRole !== "planner"
      || decision?.data?.mode !== "observe") {
      errors.push("observe mode did not record the expected controller-upgrade decision");
    }
    if (protection?.data?.mode !== "read-only") {
      errors.push("observe mode did not record read-only protection for the high-impact smoke task");
    }
  } else if (expectedMode === "auto-unconfigured") {
    if (children.length !== 0) errors.push(`unconfigured auto mode started ${children.length} child sessions`);
    if (decision?.data?.role !== "controller"
      || decision?.data?.action !== "upgrade"
      || decision?.data?.targetRole !== "planner"
      || decision?.data?.mode !== "auto") {
      errors.push("published default did not record the expected planner capability gap");
    }
    if (configMissing?.data?.role !== "planner" || configMissing?.data?.status !== "unconfigured") {
      errors.push("published default did not record the missing planner configuration");
    }
    if (upgrade || result) errors.push("unconfigured auto mode claimed an upgrade or child result");
    if (protection?.data?.mode !== "read-only" || protection?.data?.source !== "route-config-missing") {
      errors.push("unconfigured high-impact default did not fail closed");
    }
    if (!controllerRoute) errors.push("unconfigured auto mode did not remain on the base controller route");
  } else if (expectedMode === "auto") {
    if (children.length !== 0) errors.push(`auto mode started ${children.length} child sessions`);
    if (decision?.data?.role !== "controller"
      || decision?.data?.action !== "upgrade"
      || decision?.data?.targetRole !== "planner"
      || decision?.data?.mode !== "auto") {
      errors.push("auto mode did not record the expected controller-upgrade decision");
    }
    if (upgrade?.data?.status !== "requested" || !sameRoute(upgrade?.data?.requestedRoute)) {
      errors.push("auto mode did not record the expected requested controller route");
    }
    if (!controllerRoute) {
      errors.push("controller request/header did not match the configured planner route");
    } else if (controllerRoute.maxTokens !== undefined) {
      errors.push("in-place controller upgrade inherited the child maxTokens cap");
    }
  } else {
    if (children.length !== 1) errors.push(`execute mode expected one child session, found ${children.length}`);
    if (decision?.data?.role !== "controller"
      || decision?.data?.action !== "upgrade"
      || decision?.data?.targetRole !== "planner"
      || decision?.data?.mode !== "execute") {
      errors.push("execute mode did not record the expected upgrade gap before delegation");
    }
    if (result?.data?.status !== "completed" || !sameRoute(result?.data?.actualRoute)) {
      errors.push("execute mode did not complete with the expected verified planner route");
    }
    if (!children.some((session) => session.requestRoutes.some(
      (route) => sameRoute(route) && route.maxTokens === 2_048,
    ))) {
      errors.push("no child request/header matched the expected planner route and maxTokens cap");
    }
  }

  return { ok: errors.length === 0, expectedMode, expectedRoute, errors };
}

function runProcess(command, commandArgs, options) {
  return new Promise((accept, reject) => {
    const child = spawnDsh(command, commandArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      accept({
        code: timedOut ? 124 : (code ?? 1),
        signal,
        stdout,
        stderr: timedOut ? `${stderr}\nlive routing smoke timed out` : stderr,
      });
    });
  });
}

async function readSessions(root, evidenceRoot) {
  if (!existsSync(root)) return [];
  const evidence = await readEvidence(evidenceRoot);
  const files = await listFiles(root);
  const sessions = [];
  for (const file of files.filter((candidate) => candidate.endsWith("session.jsonl"))) {
    const lines = (await readFile(file, "utf8")).trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    const records = lines.map((line) => JSON.parse(line));
    sessions.push({
      header: records[0],
      events: [...records.slice(1), ...(evidence.get(records[0].id) ?? [])],
    });
  }
  return sessions;
}

async function readEvidence(root) {
  const bySession = new Map();
  if (!existsSync(root)) return bySession;
  for (const file of await listFiles(root)) {
    if (!file.endsWith(".jsonl")) continue;
    const text = await readFile(file, "utf8");
    const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    for (const line of complete.split("\n").filter(Boolean)) {
      const record = JSON.parse(line);
      if (record?.schemaVersion !== 1 || typeof record.sessionId !== "string") continue;
      const events = bySession.get(record.sessionId) ?? [];
      events.push({ type: record.type, time: record.time, data: record.data });
      bySession.set(record.sessionId, events);
    }
  }
  return bySession;
}

async function listFiles(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function summarizeSession(session) {
  const usageByStep = new Map();
  const requestRoutes = [];
  const routeEvents = [];
  let assistantText = "";
  for (const event of session.events) {
    if (event.type === "request/header") {
      const config = event.data?.header?.config;
      requestRoutes.push({
        provider: config?.provider,
        model: config?.model,
        reasoningEffort: config?.reasoningEffort,
        maxTokens: config?.maxTokens,
      });
    }
    if (["odai/route-decided", "odai/route-config-missing", "odai/route-upgrade", "odai/route-result", "odai/route-protection"].includes(event.type)) {
      routeEvents.push({ type: event.type, data: event.data });
    }
    if (event.type === "assistant/message") {
      const text = event.data?.message?.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "";
      if (text) assistantText = text;
      if (event.data?.usage) usageByStep.set(`${event.data.turn}:${event.data.step}`, event.data.usage);
    }
    if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
      usageByStep.set(`${event.data.turn}:${event.data.step}`, event.data.chunk.usage);
    }
  }

  return {
    id: session.header.id,
    origin: session.header.origin ?? "controller",
    delegationDepth: session.header.delegationDepth,
    parentSession: session.header.parentSession,
    requestRoutes,
    routeEvents,
    usage: sumUsage([...usageByStep.values()]),
    assistantText,
  };
}

function sumUsage(items) {
  const total = {};
  for (const usage of items) {
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
    }
  }
  return total;
}
