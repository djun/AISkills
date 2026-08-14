import { spawn } from "node:child_process";

export function spawnDsh(command, args, options = {}, {
  platform = process.platform,
  execute = spawn,
} = {}) {
  const spawnOptions = platform === "win32" ? { ...options, shell: true } : options;
  return execute(command, args, spawnOptions);
}
