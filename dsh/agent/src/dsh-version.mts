import { execFileSync, spawn } from "node:child_process";
import type {
  ChildProcess,
  ExecFileSyncOptionsWithStringEncoding,
  SpawnOptions,
} from "node:child_process";

type VersionExecutor = (
  command: string,
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

type SpawnExecutor<TResult> = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => TResult;

export interface ReadDshVersionOptions {
  dsh?: string;
  platform?: NodeJS.Platform;
  execute?: VersionExecutor;
}

export interface SpawnDshDependencies<TResult = ChildProcess> {
  platform?: NodeJS.Platform;
  execute?: SpawnExecutor<TResult>;
}

export function readDshVersion({
  dsh = process.env.DSH_BIN ?? "dsh",
  platform = process.platform,
  execute = execFileSync,
}: ReadDshVersionOptions = {}): string {
  const options: ExecFileSyncOptionsWithStringEncoding = { encoding: "utf8" };
  return execute(normalizeDshCommand(dsh, platform), ["-V"], dshProcessOptions(options, platform)).trim();
}

export function spawnDsh<TResult = ChildProcess>(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
  dependencies: SpawnDshDependencies<TResult> = {},
): TResult {
  const platform = dependencies.platform ?? process.platform;
  const command_ = normalizeDshCommand(command, platform);
  const options_ = dshProcessOptions(options, platform);
  if (dependencies.execute) return dependencies.execute(command_, args, options_);
  return spawn(command_, args, options_) as TResult;
}

function normalizeDshCommand(command: string, platform: NodeJS.Platform): string {
  return platform === "win32" && command === "dsh" ? "dsh.cmd" : command;
}

function dshProcessOptions<T extends SpawnOptions | ExecFileSyncOptionsWithStringEncoding>(
  options: T,
  platform: NodeJS.Platform,
): T {
  return platform === "win32" ? { ...options, shell: true } : options;
}
