#!/usr/bin/env node

import { readDshVersion } from "../src/dsh-version.mjs";
import {
  inspectAgentInstallation,
  installAgentPreset,
  SUPPORTED_DSH_VERSIONS,
  uninstallAgentPreset,
} from "../src/installer.mjs";
import type { SessionCompatResult } from "../../runtime/build/session-compat.mjs";

interface CliArguments {
  command?: "install" | "status" | "uninstall";
  dshHome?: string;
  json: boolean;
  yes: boolean;
  help: boolean;
}

interface DisplayResult {
  status?: string;
  operation?: string;
  target: string;
  issues?: readonly string[];
  security?: string;
  sessionCompatibility?: SessionCompatResult;
}

const HELP = `Usage: odai-dsh-agent <command> [options]

Commands:
  install       Install or update the managed Odai preset
  status        Inspect the managed Odai preset
  uninstall     Remove the preset when its managed files are unchanged

Options:
  --dsh-home <path>  Override DSH_HOME
  --json             Print JSON
  --yes              Confirm DSH is stopped; active-process verification still applies
  -h, --help         Show this help
`;

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
  } else if (args.command === "install") {
    const dshVersion = assertDshVersion();
    print(await installAgentPreset({
      dshHome: args.dshHome,
      dshVersion,
      confirmDshStopped: args.yes,
    }), args.json);
  } else if (args.command === "status") {
    const result = await inspectAgentInstallation({ dshHome: args.dshHome });
    print(result, args.json);
    if (result.status === "drifted") process.exitCode = 2;
  } else if (args.command === "uninstall") {
    print(await uninstallAgentPreset({
      dshHome: args.dshHome,
      confirmDshStopped: args.yes,
    }), args.json);
  } else {
    throw new Error("a command is required\n\n" + HELP);
  }
} catch (error) {
  process.stderr.write(`odai-dsh-agent: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function assertDshVersion(): string {
  const dsh = process.env.DSH_BIN ?? "dsh";
  let actual: string;
  try {
    actual = readDshVersion({ dsh });
  } catch (error) {
    throw new Error(`cannot run ${dsh} -V; install one of ${SUPPORTED_DSH_VERSIONS.join(", ")} before installing the preset`);
  }
  if (!SUPPORTED_DSH_VERSIONS.includes(actual)) {
    throw new Error(`unsupported DSH version ${actual || "<empty>"}; expected one of ${SUPPORTED_DSH_VERSIONS.join(", ")}`);
  }
  return actual;
}

function parseArgs(argv: readonly string[]): CliArguments {
  const parsed: CliArguments = { json: false, yes: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--yes") parsed.yes = true;
    else if (arg === "--dsh-home") parsed.dshHome = argv[++index];
    else if (!parsed.command && (arg === "install" || arg === "status" || arg === "uninstall")) parsed.command = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (parsed.dshHome !== undefined && parsed.dshHome.trim() === "") {
    throw new Error("--dsh-home requires a non-empty path");
  }
  return parsed;
}

function print(result: DisplayResult, json: boolean): void {
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
  const compatibility = result.sessionCompatibility;
  if ((compatibility?.repairedEvents ?? 0) > 0) {
    process.stdout.write(`session compatibility: made ${compatibility?.repairedEvents ?? 0} legacy Odai event(s) ignorable in ${compatibility?.repairedArtifacts ?? 0} session artifact(s)\n`);
  }
  if ((compatibility?.backupPaths?.length ?? 0) > 0) {
    process.stdout.write(`session compatibility: retained ${compatibility?.backupPaths.length ?? 0} verified backup artifact(s)\n`);
  }
  for (const path of compatibility?.tornArtifacts ?? []) {
    process.stdout.write(`session compatibility warning: preserved DSH-recoverable torn tail: ${path}\n`);
  }
  for (const failure of compatibility?.failures ?? []) {
    process.stdout.write(`session compatibility warning: ${failure.path}: ${failure.error}\n`);
  }
  if (result.security) process.stdout.write(`security: ${result.security}\n`);
}
