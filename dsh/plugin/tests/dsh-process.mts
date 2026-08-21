import { execFileSync, spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";

interface ChildProcessLike {
  exitCode: number | null;
  pid?: number;
  kill?(signal?: NodeJS.Signals): unknown;
}

interface SpawnDependencies<TResult> {
  platform?: NodeJS.Platform;
  execute?: (command: string, args: readonly string[], options: SpawnOptions) => TResult;
}

interface TerminateDependencies {
  platform?: NodeJS.Platform;
  execute?: (command: string, args: readonly string[], options: { stdio: "ignore" }) => unknown;
}

export function spawnDsh<TResult = ReturnType<typeof spawn>>(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
  dependencies: SpawnDependencies<TResult> = {},
): TResult {
  const platform = dependencies.platform ?? process.platform;
  const spawnOptions = platform === "win32" ? { ...options, shell: true } : options;
  const command_ = normalizeDshCommand(command, platform);
  if (dependencies.execute) return dependencies.execute(command_, args, spawnOptions);
  return spawn(command_, args, spawnOptions) as TResult;
}

function normalizeDshCommand(command: string, platform: NodeJS.Platform): string {
  return platform === "win32" && command === "dsh" ? "dsh.cmd" : command;
}

export function terminateDsh(
  child: ChildProcessLike | undefined,
  { platform = process.platform, execute = execFileSync }: TerminateDependencies = {},
): void {
  if (!child || child.exitCode !== null) return;
  if (platform === "win32" && child.pid) {
    try {
      execute("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {}
  }
  child.kill?.("SIGTERM");
}
