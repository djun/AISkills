import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { spawnDsh } from "./dsh-process.mjs";
import {
  resolveControllerSelection,
  selectController,
} from "./live-routing-smoke-config.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "../..");
const workspaceRoot = resolve(process.env.INIT_CWD ?? process.cwd());
const args = parseArgs(process.argv.slice(2));
if (!args.yes) {
  throw new Error("live compaction cache smoke calls an external model; rerun with --yes after confirming cost and credentials");
}

const sourceHome = resolve(args.sourceHome ?? resolve(homedir(), ".dsh"));
const sourceSettings = resolve(sourceHome, "settings.yaml");
const sourceCredentials = resolve(sourceHome, ".credentials.yaml");
const runtimePath = [
  resolve(pluginRoot, "runtime/index.mjs"),
  resolve(pluginRoot, "../runtime/src/index.mjs"),
].find((candidate) => existsSync(candidate));
const skillPath = [
  resolve(pluginRoot, "skills/odai/SKILL.md"),
  resolve(repoRoot, "skills/odai/SKILL.md"),
].find((candidate) => existsSync(candidate));
const scratch = await mkdtemp(resolve(tmpdir(), "odai-compaction-cache-"));
const dshHome = resolve(scratch, "home");
const probePath = resolve(scratch, "probe-plugin.mjs");
const reportPath = resolve(scratch, "report.json");
const patchPath = resolve(scratch, "probe.patch.yml");
const dsh = process.env.DSH_BIN ?? "dsh";

try {
  if (!existsSync(sourceSettings)) throw new Error(`dsh settings not found: ${sourceSettings}`);
  if (args.runtime && (!existsSync(runtimePath) || !existsSync(skillPath))) {
    throw new Error("source Odai runtime or canonical skill is unavailable");
  }

  await mkdir(dshHome, { recursive: true });
  const sourceSettingsText = await readFile(sourceSettings, "utf8");
  const controller = resolveControllerSelection(sourceSettingsText, {});
  await writeFile(resolve(dshHome, "settings.yaml"), selectController(sourceSettingsText, controller), "utf8");
  if (existsSync(sourceCredentials)) {
    await copyFile(sourceCredentials, resolve(dshHome, ".credentials.yaml"));
  }

  await writeFile(probePath, renderProbePlugin(), "utf8");
  await writeFile(patchPath, renderPatch({
    probePath: pathToFileURL(probePath).href,
    reportPath,
    runtimePath: pathToFileURL(runtimePath).href,
    skillPath,
    runtime: args.runtime,
    provider: controller.provider,
    model: controller.model,
    reasoningEffort: controller.reasoningEffort,
    marker: randomUUID(),
  }), "utf8");

  const run = await runProcess(dsh, [
    "--profile",
    "headless",
    "--patch",
    patchPath,
    "Reply with OK only.",
  ], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: "DISABLED",
    },
    timeoutMs: args.timeoutMs,
  });

  if (!existsSync(reportPath)) {
    throw new Error(`cache probe produced no report (exit ${run.code})\n${run.stderr}`);
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const verification = verifyReport(report, args.runtime);
  const output = {
    ok: run.code === 0 && verification.ok,
    mode: args.runtime ? "candidate-runtime" : "baseline",
    controller: {
      provider: controller.provider,
      model: controller.model,
      reasoningEffort: controller.reasoningEffort,
    },
    verification,
    calls: report.calls,
    dshExitCode: run.code,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.ok) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function parseArgs(argv) {
  const parsed = {
    yes: false,
    runtime: false,
    sourceHome: undefined,
    timeoutMs: 180_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes") parsed.yes = true;
    else if (arg === "--runtime") parsed.runtime = true;
    else if (arg === "--source-home") parsed.sourceHome = argv[++index];
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(parsed.timeoutMs) || parsed.timeoutMs < 1_000) {
    throw new Error("timeoutMs must be an integer of at least 1000");
  }
  return parsed;
}

function renderPatch(input) {
  const quote = (value) => JSON.stringify(value);
  return [
    "- insert:",
    ...(input.runtime ? [
      "    - id: odai-compaction-cache-candidate",
      `      name: ${quote(input.runtimePath)}`,
      "      config:",
      `        skillPath: ${quote(input.skillPath)}`,
      "        routing:",
      "          mode: off",
    ] : []),
    "    - id: odai-compaction-cache-probe",
    `      name: ${quote(input.probePath)}`,
    "      config:",
    `        reportPath: ${quote(input.reportPath)}`,
    `        provider: ${quote(input.provider)}`,
    `        model: ${quote(input.model)}`,
    `        reasoningEffort: ${quote(input.reasoningEffort)}`,
    `        marker: ${quote(input.marker)}`,
    ...(input.runtime ? [`        runtimeModule: ${quote(input.runtimePath)}`] : []),
    "",
  ].join("\n");
}

function renderProbePlugin() {
  return `import { writeFile } from "node:fs/promises";

export const name = "odai-compaction-cache-probe";
export const inject = ["llm"];

export function apply(ctx, config) {
  let ran = false;
  ctx.on("agent/pre-step", async ({ agent }, next) => {
    if (ran) return next();
    ran = true;
    const stablePrefix = config.marker + "\\n" + "stable compaction cache prefix ".repeat(2048);
    const base = {
      provider: config.provider,
      model: config.model,
      system: "You are a cache probe. Reply with OK only.",
      maxTokens: 16,
      sessionId: agent.session.id,
    };
    const prefix = message("prefix", stablePrefix);
    const calls = [];
    calls.push(await invoke(ctx, "warm", {
      ...base,
      reasoningEffort: config.reasoningEffort,
      messages: [prefix, message("warm-tail", "Warm this exact prefix. Reply OK.")],
    }));
    const compaction = {
      ...base,
      purpose: "compaction",
      messages: [prefix, message("compaction-tail", "Condense the prefix. Reply OK.")],
    };
    if (config.runtimeModule) {
      const runtime = await import(config.runtimeModule);
      runtime.inheritCompactionReasoning(compaction, {
        get(sessionId) {
          if (sessionId !== agent.session.id) return undefined;
          return {
            requestHeader() {
              return {
                config: {
                  provider: config.provider,
                  model: config.model,
                  reasoningEffort: config.reasoningEffort,
                },
              };
            },
          };
        },
      });
    }
    calls.push(await invoke(ctx, "compaction", compaction));
    calls.push(await invoke(ctx, "matched", {
      ...base,
      purpose: "compaction",
      reasoningEffort: config.reasoningEffort,
      messages: [prefix, message("matched-tail", "Confirm this prefix. Reply OK.")],
    }));
    await writeFile(config.reportPath, JSON.stringify({ calls }, null, 2) + "\\n", "utf8");
    return next();
  }, { prepend: true });
}

function message(id, text) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: name },
  };
}

async function invoke(ctx, label, options) {
  let usage;
  let finish;
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === "usage") usage = chunk.usage;
    if (chunk.type === "finish") finish = chunk.reason;
  }
  return {
    label,
    effectiveReasoningEffort: options.reasoningEffort ?? null,
    usage: usage ?? null,
    finish: finish ?? null,
  };
}
`;
}

function verifyReport(report, runtime) {
  const errors = [];
  const calls = Object.fromEntries((report.calls ?? []).map((call) => [call.label, call]));
  for (const label of ["warm", "compaction", "matched"]) {
    if (!calls[label]?.usage) errors.push(`${label} call has no usage`);
  }
  const compactionCache = calls.compaction?.usage?.cacheReadTokens ?? 0;
  const matchedCache = calls.matched?.usage?.cacheReadTokens ?? 0;
  if (runtime) {
    if (calls.compaction?.effectiveReasoningEffort !== calls.warm?.effectiveReasoningEffort) {
      errors.push("candidate runtime did not inherit the routed reasoning effort");
    }
    if (compactionCache < 1_024) errors.push(`candidate compaction cache read was only ${compactionCache}`);
  } else {
    if (calls.compaction?.effectiveReasoningEffort !== null) {
      errors.push("baseline compaction unexpectedly had a reasoning effort");
    }
    if (matchedCache < 1_024) errors.push(`matched reasoning cache read was only ${matchedCache}`);
    if (compactionCache >= matchedCache) {
      errors.push(`baseline mismatch did not reduce cache reuse (${compactionCache} >= ${matchedCache})`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    compactionCacheReadTokens: compactionCache,
    matchedCacheReadTokens: matchedCache,
  };
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
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
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
        stderr: timedOut ? `${stderr}\ncache smoke timed out` : stderr,
      });
    });
  });
}
