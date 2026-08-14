import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { spawnDsh } from "./dsh-process.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "../..");
const firstExisting = (label, candidates) => {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`cannot locate ${label}; checked: ${candidates.join(", ")}`);
  return found;
};
const pluginPath = firstExisting("Odai DSH runtime", [
  resolve(pluginRoot, "runtime/index.mjs"),
  resolve(pluginRoot, "../runtime/src/index.mjs"),
]);
const routingConfigModulePath = firstExisting("Odai routing configuration runtime", [
  resolve(pluginRoot, "runtime/routing-config.mjs"),
  resolve(pluginRoot, "../runtime/src/routing-config.mjs"),
]);
const skillPath = firstExisting("canonical Odai skill", [
  resolve(pluginRoot, "skills/odai/SKILL.md"),
  resolve(repoRoot, "skills/odai/SKILL.md"),
]);
const dsh = process.env.DSH_BIN ?? "dsh";
const scratch = await mkdtemp(resolve(tmpdir(), "odai-dsh-load-"));
const patchPath = resolve(scratch, "odai.patch.yml");
const wrapperPath = resolve(scratch, "load-probe.mjs");
const markerPath = resolve(scratch, "loaded.marker");
const deniedWritePath = resolve(scratch, "must-not-be-written.txt");
const protectedWritePath = resolve(scratch, "protected-controller-must-not-write.txt");
const routingConfigPath = resolve(scratch, "home", "odai", "routing.json");

const yamlString = (value) => JSON.stringify(value);
const wrapper = [
  "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
  `import { apply as applyOdai, inject, name } from ${JSON.stringify(pathToFileURL(pluginPath).href)};`,
  `import { createRoutingConfigTool } from ${JSON.stringify(pathToFileURL(routingConfigModulePath).href)};`,
  "export { inject, name };",
  "export function apply(ctx, config) {",
  "  applyOdai(ctx, config);",
  "  const child = { session: { header: { origin: 'subagent', delegationDepth: 1 }, append() {} } };",
  "  const protectedController = { session: { header: {}, events: [",
  "    { type: 'odai/route-decided', data: { turn: 1, step: 1 } },",
  "    { type: 'odai/route-protection', data: { turn: 1, step: 1, mode: 'read-only', reasonCode: 'PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE' } },",
  "  ], append() {} } };",
  "  const probes = [",
  `    { callId: 'odai-child-boundary-probe', path: ${JSON.stringify(deniedWritePath)}, agent: child, prefix: 'ODAI_SUBAGENT_BOUNDARY:' },`,
  `    { callId: 'odai-route-protection-probe', path: ${JSON.stringify(protectedWritePath)}, agent: protectedController, prefix: 'ODAI_HIGH_IMPACT_ROUTE_BLOCKED:' },`,
  "  ];",
  "  const guardsReady = Promise.all(probes.map((probe) => ctx.tools.execute({",
  "    callId: probe.callId,",
  "    name: 'write',",
  "    arguments: { file_path: probe.path, content: 'governance failed' },",
  "    agent: probe.agent,",
  "    signal: new AbortController().signal,",
  "  }).then((result) => {",
  "    if (!result.isError || !result.error.message.startsWith(probe.prefix)) {",
  "      throw new Error(`${probe.callId} was not denied by odai: ${JSON.stringify(result)}`);",
  "    }",
  "    if (existsSync(probe.path)) throw new Error(`${probe.callId} reached the write tool body`);",
  "  })));",
  "  const controller = { session: { header: {}, events: [], append(type, data) { this.events.push({ type, data }); } } };",
  `  const configProbe = createRoutingConfigTool(${JSON.stringify(routingConfigPath)}).execute({`,
  "    action: 'set', responsibility: 'reviewer', provider: 'probe-provider', model: 'probe-model', reasoningEffort: 'high',",
  "  }, { agent: controller }).then(() => {",
  `    const stored = JSON.parse(readFileSync(${JSON.stringify(routingConfigPath)}, 'utf8'));`,
  "    if (stored.roles?.reviewer?.provider !== 'probe-provider' || stored.roles?.reviewer?.model !== 'probe-model') {",
  "      throw new Error(`routing config was not persisted: ${JSON.stringify(stored)}`);",
  "    }",
  "  });",
  "  Promise.all([guardsReady, configProbe]).then(() => {",
  `    writeFileSync(${JSON.stringify(markerPath)}, 'loaded-guarded-and-configured\\n', 'utf8');`,
  "  }).catch((error) => process.stderr.write(`odai load probe: ${error.stack ?? error}\\n`));",
  "}",
  "",
].join("\n");
const patch = [
  "- id: headless-runner",
  "  disabled: true",
  "- insert:",
  "    - id: odai-governance-probe",
  `      name: ${yamlString(wrapperPath)}`,
  "      config:",
  `        skillPath: ${yamlString(skillPath)}`,
  "",
].join("\n");

try {
  await Promise.all([
    writeFile(patchPath, patch, "utf8"),
    writeFile(wrapperPath, wrapper, "utf8"),
  ]);
  const child = spawnDsh(dsh, [
    "--profile",
    "headless",
    "--patch",
    patchPath,
    "odai load probe",
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DSH_HOME: resolve(scratch, "home"),
      DSH_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let verified = false;
  const completed = new Promise((accept, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`timed out waiting for odai plugin load marker\n${output}`));
    }, 15_000);
    const markerPoll = setInterval(() => {
      if (!existsSync(markerPath)) return;
      verified = true;
      child.kill("SIGTERM");
    }, 50);

    const capture = (chunk) => {
      output += chunk.toString();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      clearTimeout(timeout);
      clearInterval(markerPoll);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      clearInterval(markerPoll);
      verified ||= existsSync(markerPath);
      if (verified) {
        accept();
      } else {
        reject(new Error(`dsh exited before odai plugin loaded (code=${code}, signal=${signal})\n${output}`));
      }
    });
  });

  await completed;

  process.stdout.write(`dsh plugin load verified with ${dsh}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
