#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HELP = `Usage: odai-dsh-plugin repair-sessions [options]

Repair historical DSH session logs written by older Odai Agent or Plugin versions.
The command adds the official ignorable marker to Odai-only audit events; it does
not delete messages or other session events. Stop DSH before running it; repair
also refuses when local DSH process inspection fails or finds an active process.

Options:
  --dsh-home <path>  Override DSH_HOME
  --json             Print JSON
  --yes              Confirm every DSH process is stopped; active processes still fail
  -h, --help         Show this help
`;

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
  } else {
    const modulePath = [
      resolve(import.meta.dirname, "../runtime/session-compat.mjs"),
      resolve(import.meta.dirname, "../../runtime/build/session-compat.mjs"),
    ].find(existsSync);
    if (!modulePath) throw new Error("session compatibility runtime is unavailable");
    const { repairLegacySessionLogs } = await import(pathToFileURL(modulePath).href);
    if (!args.yes) throw new Error("stop every DSH process, then rerun repair-sessions with --yes");
    const result = repairLegacySessionLogs({
      dshHome: args.dshHome,
      confirmDshStopped: true,
    });
    print(result, args.json);
    if (result.failures.length > 0) process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`odai-dsh-plugin: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = { command: undefined, dshHome: undefined, json: false, yes: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--yes") parsed.yes = true;
    else if (arg === "--dsh-home") parsed.dshHome = argv[++index];
    else if (!parsed.command && arg === "repair-sessions") parsed.command = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!parsed.help && parsed.command !== "repair-sessions") {
    throw new Error(`repair-sessions is required\n\n${HELP}`);
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
  process.stdout.write(`scanned ${result.scannedArtifacts} session artifact(s)\n`);
  process.stdout.write(`repaired ${result.repairedEvents} Odai event(s) in ${result.repairedArtifacts} artifact(s)\n`);
  if (result.backupPaths.length > 0) process.stdout.write(`retained ${result.backupPaths.length} verified backup artifact(s)\n`);
  for (const path of result.tornArtifacts) process.stdout.write(`warning: preserved DSH-recoverable torn tail: ${path}\n`);
  for (const failure of result.failures) {
    process.stdout.write(`warning: ${failure.path}: ${failure.error}\n`);
  }
}
