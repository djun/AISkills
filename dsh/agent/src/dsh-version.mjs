import { execFileSync, spawn } from "node:child_process";

export function readDshVersion({
  dsh = process.env.DSH_BIN ?? "dsh",
  platform = process.platform,
  execute = execFileSync,
} = {}) {
  return execute(normalizeDshCommand(dsh, platform), ["-V"], dshProcessOptions({ encoding: "utf8" }, platform)).trim();
}

export function spawnDsh(command, args, options = {}, {
  platform = process.platform,
  execute = spawn,
} = {}) {
  return execute(normalizeDshCommand(command, platform), args, dshProcessOptions(options, platform));
}

function normalizeDshCommand(command, platform) {
  return platform === "win32" && command === "dsh" ? "dsh.cmd" : command;
}

function dshProcessOptions(options, platform) {
  return platform === "win32" ? { ...options, shell: true } : options;
}
