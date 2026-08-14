import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { spawnDsh } from "../src/dsh-version.mjs";
import { installAgentPreset, SUPPORTED_DSH_VERSION } from "../src/installer.mjs";

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(agentRoot, "../..");
const dsh = process.env.DSH_BIN ?? "dsh";
const dshRoot = process.env.DSH_PACKAGE_ROOT
  ? resolve(process.env.DSH_PACKAGE_ROOT)
  : findDshPackageRoot(dsh);
const scopeModule = resolve(dshRoot, "node_modules/@deepseek-ai/dsh-scope/lib/index.js");
await verifyPinnedComposition();
const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-scope-"));
const home = resolve(scratch, "home");
const workspace = resolve(scratch, "workspace");
const sourceRoot = resolve(scratch, "source-preset");
const markerPath = resolve(scratch, "scope-results.json");
const probePluginPath = resolve(scratch, "scope-probe-plugin.mjs");
const patchPath = resolve(scratch, "scope-probe.patch.yml");

const yaml = (value) => JSON.stringify(value);

function findDshPackageRoot(command) {
  const locator = process.platform === "win32" ? "where" : "which";
  const located = execFileSync(locator, [command], { encoding: "utf8" }).trim().split(/\r?\n/u)[0];
  let current = dirname(realpathSync(located));
  while (dirname(current) !== current) {
    try {
      const metadata = JSON.parse(readFileSync(resolve(current, "package.json"), "utf8"));
      if (metadata.name === "@deepseek-ai/dsh") return current;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
  throw new Error(`cannot locate the @deepseek-ai/dsh package behind ${command}`);
}

async function verifyPinnedComposition() {
  const dshMetadata = JSON.parse(await readFile(resolve(dshRoot, "package.json"), "utf8"));
  if (dshMetadata.version !== SUPPORTED_DSH_VERSION) {
    throw new Error(`agent preset expects DSH ${SUPPORTED_DSH_VERSION}, found ${dshMetadata.version}`);
  }

  const standard = await readFile(resolve(dshRoot, "config/agent-presets/standard/agent.cordis.yml"), "utf8");
  const odaiSuffix = [
    "# Odai contributes scoped prompt, guard, routing, user-owned responsibility",
    "# mappings, and evidence listeners. Base controller selection stays host-owned.",
    "- id: odai-governance",
    "  name: ./runtime/index.mjs",
    "  config:",
    "    routing:",
    "      mode: auto",
    "      provider: spawn",
  ].join("\n");
  const expected = `${standard
    .replace(
      "# The preset's own persona, shadowing the deployment default for this agent.\n# `{{model}}` and `{{cwd}}` resolve from the agent's own route and workspace.",
      "# The preset's own model-neutral persona shadows the deployment default. Auto\n# routing can upgrade after prompt assembly; `{{cwd}}` remains workspace-local.",
    )
    .replace(
      "You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.",
      "You are Odai, a coding agent. Your working directory is {{cwd}}.",
    )
    .trimEnd()}\n\n${odaiSuffix}`;
  const actual = (await readFile(resolve(agentRoot, "preset/odai/agent.cordis.yml"), "utf8")).trimEnd();
  if (actual !== expected) {
    throw new Error("Odai Agent composition drifted from the pinned DSH standard preset");
  }
}

async function freePort() {
  return await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : accept(port));
    });
  });
}

async function rpc(baseUrl, method, payload) {
  const rpcId = randomUUID();
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${text}`);
  const body = JSON.parse(text);
  if (body.result?.ok !== true) throw new Error(`${method} failed: ${text}`);
  return body.result.value;
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dsh web exited early (${child.exitCode})\n${output()}`);
    try {
      await rpc(baseUrl, "agentPreset.list", {});
      return;
    } catch {
      await new Promise((accept) => setTimeout(accept, 75));
    }
  }
  throw new Error(`timed out waiting for dsh web\n${output()}`);
}

async function waitForMarker(child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) return JSON.parse(await readFile(markerPath, "utf8"));
    if (child.exitCode !== null) throw new Error(`dsh web exited before probe completed (${child.exitCode})\n${output()}`);
    await new Promise((accept) => setTimeout(accept, 50));
  }
  throw new Error(`timed out waiting for scope marker\n${output()}`);
}

await mkdir(workspace, { recursive: true });
await cp(resolve(agentRoot, "preset/odai"), sourceRoot, { recursive: true });
const developmentRuntime = resolve(repoRoot, "dsh/runtime/src");
const developmentSkill = resolve(repoRoot, "skills/odai");
if (existsSync(developmentRuntime) && existsSync(developmentSkill)) {
  await Promise.all([
    cp(developmentRuntime, resolve(sourceRoot, "runtime"), { recursive: true }),
    cp(developmentSkill, resolve(sourceRoot, "skills/odai"), { recursive: true }),
  ]);
} else if (!existsSync(resolve(sourceRoot, "runtime/index.mjs"))
  || !existsSync(resolve(sourceRoot, "skills/odai/SKILL.md"))) {
  throw new Error("Odai Agent verification requires either repository sources or packaged runtime and skill files");
}
await installAgentPreset({ dshHome: home, sourceRoot });

const probePlugin = `import { existsSync, readFileSync, writeFileSync } from "node:fs";\nimport { bindScopeParent } from ${JSON.stringify(pathToFileURL(scopeModule).href)};\n\nexport const name = "odai-agent-scope-probe";\nexport const inject = ["systemPrompt", "tools"];\n\nexport function apply(ctx, config) {\n  const results = {};\n  let writing = Promise.resolve();\n\n  ctx.on("agent/created", ({ agent }) => {\n    writing = writing.then(async () => {\n      const preset = agent.session?.header?.agentPreset;\n      if (preset !== "standard" && preset !== "odai") return;\n\n      const assembly = await ctx.systemPrompt.assemble({ scope: agent });\n      const canonicalSections = assembly.sections.filter((section) => section.name === "odai:canonical-governance");\n      const writePath = preset === "odai" ? config.odaiWritePath : config.standardWritePath;\n      const childSession = new Proxy(agent.session, {\n        get(target, property) {\n          if (property === "header") {\n            return { ...target.header, origin: "subagent", delegationDepth: 1 };\n          }\n          return Reflect.get(target, property, target);\n        },\n      });\n      const child = { id: agent.id, session: childSession };\n      bindScopeParent(child, agent);\n      const toolResult = await ctx.tools.execute({\n        callId: \`scope-probe-\${preset}\`,\n        name: "write",\n        arguments: { file_path: writePath, content: \`\${preset} child write reached body\\n\` },\n        agent: child,\n        signal: new AbortController().signal,\n      });\n\n      let routingConfigured;\n      if (preset === "odai") {\n        const routingResult = await ctx.tools.execute({\n          callId: "scope-probe-odai-routing-config",\n          name: "odai_routing_config",\n          arguments: { action: "set", responsibility: "executor", provider: "probe-provider", model: "probe-executor", reasoningEffort: "high" },\n          agent,\n          signal: new AbortController().signal,\n        });\n        if (routingResult.isError) throw new Error(\`odai routing config tool failed: \${routingResult.error?.message}\`);\n        const stored = JSON.parse(readFileSync(config.routingConfigPath, "utf8"));\n        routingConfigured = stored.roles?.executor?.provider === "probe-provider"\n          && stored.roles?.executor?.model === "probe-executor";\n      }\n\n      results[preset] = {\n        canonicalSectionCount: canonicalSections.length,\n        toolIsError: toolResult.isError === true,\n        toolError: toolResult.isError === true ? toolResult.error?.message : undefined,\n        writeReachedBody: existsSync(writePath),\n        ...(routingConfigured === undefined ? {} : { routingConfigured }),\n      };\n      if (results.standard && results.odai) {\n        writeFileSync(config.markerPath, JSON.stringify(results, null, 2) + "\\n", "utf8");\n      }\n    }).catch((error) => {\n      writeFileSync(config.markerPath, JSON.stringify({ probeError: error?.stack ?? String(error) }, null, 2) + "\\n", "utf8");\n    });\n  }, { global: true });\n}\n`;
await writeFile(probePluginPath, probePlugin, "utf8");
await writeFile(patchPath, [
  "- insert:",
  "    - id: odai-agent-scope-probe",
  `      name: ${yaml(probePluginPath)}`,
  "      config:",
  `        markerPath: ${yaml(markerPath)}`,
  `        standardWritePath: ${yaml(resolve(workspace, "standard-child-write.txt"))}`,
  `        odaiWritePath: ${yaml(resolve(workspace, "odai-child-write.txt"))}`,
  `        routingConfigPath: ${yaml(resolve(home, "odai/routing.json"))}`,
  "",
].join("\n"), "utf8");

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawnDsh(dsh, [
  "--profile", "web",
  "--patch", patchPath,
  "--host", "127.0.0.1",
  "--port", String(port),
], {
  cwd: workspace,
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_MODE: "DISABLED",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });
const capturedOutput = () => output;

try {
  await waitForServer(baseUrl, child, capturedOutput);
  const roster = await rpc(baseUrl, "agentPreset.list", {});
  const ids = roster.presets.map((preset) => preset.id);
  if (!ids.includes("standard") || !ids.includes("odai")) {
    throw new Error(`expected standard and odai presets, got ${JSON.stringify(ids)}`);
  }
  await rpc(baseUrl, "session.create", { cwd: workspace, agentPreset: "standard" });
  await rpc(baseUrl, "session.create", { cwd: workspace, agentPreset: "odai" });
  const results = await waitForMarker(child, capturedOutput);
  if (results.probeError) throw new Error(results.probeError);
  if (results.standard?.canonicalSectionCount !== 0) {
    throw new Error(`standard saw odai canonical prompt: ${JSON.stringify(results)}`);
  }
  if (results.standard?.toolError?.startsWith("ODAI_SUBAGENT_BOUNDARY:")) {
    throw new Error(`standard child call reached the odai guard: ${JSON.stringify(results)}`);
  }
  if (results.odai?.canonicalSectionCount !== 1) {
    throw new Error(`odai canonical prompt count was not exactly one: ${JSON.stringify(results)}`);
  }
  if (results.odai?.writeReachedBody !== false || results.odai?.toolIsError !== true
    || !results.odai?.toolError?.startsWith("ODAI_SUBAGENT_BOUNDARY:")) {
    throw new Error(`odai child write was not denied by odai guard: ${JSON.stringify(results)}`);
  }
  if (results.odai?.routingConfigured !== true) {
    throw new Error(`odai natural routing tool did not persist through DSH: ${JSON.stringify(results)}`);
  }
  process.stdout.write(`${JSON.stringify({ scratch, roster: ids, results }, null, 2)}\n`);
} finally {
  child.kill("SIGTERM");
  await new Promise((accept) => {
    if (child.exitCode !== null) return accept();
    const timeout = setTimeout(() => { child.kill("SIGKILL"); accept(); }, 3_000);
    child.once("exit", () => { clearTimeout(timeout); accept(); });
  });
  if (process.env.KEEP_ODAI_SCOPE_PROBE !== "1") {
    await rm(scratch, { recursive: true, force: true });
  }
}
