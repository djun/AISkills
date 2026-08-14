#!/usr/bin/env node

import { readDshVersion } from "../src/dsh-version.mjs";
import {
  inspectAgentInstallation,
  installAgentPreset,
  SUPPORTED_DSH_VERSION,
  uninstallAgentPreset,
} from "../src/installer.mjs";

const HELP = `Usage: odai-dsh-agent <command> [options]

Commands:
  install       Install or update the managed Odai preset
  status        Inspect the managed Odai preset
  uninstall     Remove the preset when its managed files are unchanged

Options:
  --dsh-home <path>  Override DSH_HOME
  --json             Print JSON
  -h, --help         Show this help
`;

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
  } else if (args.command === "install") {
    assertDshVersion();
    print(await installAgentPreset({ dshHome: args.dshHome }), args.json);
  } else if (args.command === "status") {
    const result = await inspectAgentInstallation({ dshHome: args.dshHome });
    print(result, args.json);
    if (result.status === "drifted") process.exitCode = 2;
  } else if (args.command === "uninstall") {
    print(await uninstallAgentPreset({ dshHome: args.dshHome }), args.json);
  } else {
    throw new Error("a command is required\n\n" + HELP);
  }
} catch (error) {
  process.stderr.write(`odai-dsh-agent: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function assertDshVersion() {
  const dsh = process.env.DSH_BIN ?? "dsh";
  let actual;
  try {
    actual = readDshVersion({ dsh });
  } catch (error) {
    throw new Error(`cannot run ${dsh} -V; install DSH ${SUPPORTED_DSH_VERSION} before installing the preset`);
  }
  if (actual !== SUPPORTED_DSH_VERSION) {
    throw new Error(`unsupported DSH version ${actual || "<empty>"}; expected ${SUPPORTED_DSH_VERSION}`);
  }
}

function parseArgs(argv) {
  const parsed = { command: undefined, dshHome: undefined, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--dsh-home") parsed.dshHome = argv[++index];
    else if (!parsed.command && ["install", "status", "uninstall"].includes(arg)) parsed.command = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (parsed.dshHome !== undefined && (typeof parsed.dshHome !== "string" || parsed.dshHome.trim() === "")) {
    throw new Error("--dsh-home requires a non-empty path");
  }
  return parsed;
}

function print(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.status) {
    process.stdout.write(`${result.status}: ${result.target}\n`);
    for (const issue of result.issues ?? []) process.stdout.write(`- ${issue}\n`);
    return;
  }
  process.stdout.write(`${result.operation}: ${result.target}\n`);
  if (result.security) process.stdout.write(`security: ${result.security}\n`);
}
