import { execFileSync, spawn } from "node:child_process";

export function spawnDsh(command, args, options = {}, {
  platform = process.platform,
  execute = spawn,
} = {}) {
  const spawnOptions = platform === "win32" ? { ...options, shell: true } : options;
  return execute(normalizeDshCommand(command, platform), args, spawnOptions);
}

function normalizeDshCommand(command, platform) {
  return platform === "win32" && command === "dsh" ? "dsh.cmd" : command;
}

export function terminateDsh(child, {
  platform = process.platform,
  execute = execFileSync,
} = {}) {
  if (!child || child.exitCode !== null) return;
  if (platform === "win32" && child.pid) {
    try {
      execute("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {}
  }
  child.kill?.("SIGTERM");
}
