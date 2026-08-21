import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { SKILL_SOURCE_MODES, type SkillSourceMode } from "./skill-bundle.mjs";
import type { DshAgent, RuntimeTool } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

export const SKILL_SOURCE_CONFIG_PROMPT = [
  "## Odai skill source configuration",
  "When the user naturally asks how the DSH Agent or Plugin selects Odai governance, or explicitly asks to inspect, set, or reset that source, use odai_skill_source_config.",
  "Set a source only when the user explicitly chooses bundled, auto, or user. Never enable project or user skill overrides by inference.",
  "bundled uses the Agent/Plugin release copy. auto allows compatible project/custom overrides and newer compatible user installs with bundled fallback. user requires a valid user/custom install and reports a visible bundled fallback when that source cannot be used.",
  "Do not ask the user to edit YAML, JSON, managed Agent files, or Plugin configuration. The tool owns persistence. Changes apply from the next user turn.",
  "An explicit deployment skillPath or ODAI_SKILL_PATH remains host-owned and takes precedence over this setting.",
].join("\n");

const STORE_SCHEMA_VERSION = 1;
export type SkillSourceConfigAction = "show" | "set" | "remove";

export interface SkillSourceStore {
  readonly schemaVersion: 1;
  readonly source?: SkillSourceMode;
}

export interface SkillSourceConfigResult {
  action: SkillSourceConfigAction;
  configPath: string;
  source: SkillSourceMode;
  effectiveSource: SkillSourceMode | "path";
  configuredSource: SkillSourceMode;
  requiresNextTurn: boolean;
  hostOverride?: true;
  recoveredInvalidStore?: true;
}

export interface SkillSourceConfiguredEvent {
  action: "set" | "remove";
  source: SkillSourceMode;
  recoveredInvalidStore?: true;
}

export interface SkillSourceConfigToolOptions {
  explicitPath?: boolean;
  onConfigured?(agent: DshAgent, event: SkillSourceConfiguredEvent): void;
}

function isSkillSourceMode(value: unknown): value is SkillSourceMode {
  return typeof value === "string" && (SKILL_SOURCE_MODES as readonly string[]).includes(value);
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function resolveSkillSourceConfigPath(
  configuredPath: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (configuredPath !== undefined) {
    if (typeof configuredPath !== "string" || configuredPath.trim() === "") {
      throw new TypeError("config.governance.skillConfigPath must be a non-empty string");
    }
    return resolve(configuredPath.trim());
  }
  const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== ""
    ? resolve(env.DSH_HOME.trim())
    : resolve(homedir(), ".dsh");
  return resolve(dshHome, "odai", "source.json");
}

export function readSkillSourceStore(configPath: string): Readonly<SkillSourceStore> {
  if (!existsSync(configPath)) return Object.freeze({ schemaVersion: STORE_SCHEMA_VERSION });
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`cannot read Odai skill source config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isUnknownRecord(parsed)) throw new TypeError(`Odai skill source config ${configPath} must be an object`);
  const unknownFields = Object.keys(parsed).filter((field) => !["schemaVersion", "source"].includes(field));
  if (unknownFields.length > 0) {
    throw new TypeError(`Odai skill source config ${configPath} has unknown fields: ${unknownFields.join(", ")}`);
  }
  if (parsed.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new TypeError(`Odai skill source config ${configPath} has unsupported schemaVersion ${String(parsed.schemaVersion)}`);
  }
  if (!isSkillSourceMode(parsed.source)) {
    throw new TypeError(`Odai skill source config ${configPath}.source must be bundled, auto, or user`);
  }
  return Object.freeze({ schemaVersion: STORE_SCHEMA_VERSION, source: parsed.source });
}

export function effectiveSkillSource(configPath: string, configuredSource: SkillSourceMode): SkillSourceMode {
  return readSkillSourceStore(configPath).source ?? configuredSource;
}

function writeSkillSourceStore(configPath: string, source: SkillSourceMode): void {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  const value = `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, source }, null, 2)}\n`;
  try {
    writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, configPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function acquireStoreLock(configPath: string): () => void {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const lockPath = `${configPath}.lock`;
  const create = (): void => writeFileSync(lockPath, `${process.pid}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    create();
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    let stale = false;
    try {
      stale = Date.now() - statSync(lockPath).mtimeMs > 30_000;
    } catch {}
    if (!stale) throw new Error("Odai skill source configuration is being updated; retry the tool call");
    rmSync(lockPath, { force: true });
    create();
  }
  return () => rmSync(lockPath, { force: true });
}

function preserveInvalidStore(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  renameSync(configPath, `${configPath}.invalid-${Date.now()}-${randomUUID()}`);
  return true;
}

function resultFor(
  configPath: string,
  action: SkillSourceConfigAction,
  source: SkillSourceMode,
  configuredSource: SkillSourceMode,
  recoveredInvalidStore = false,
  explicitPath = false,
): SkillSourceConfigResult {
  return {
    action,
    configPath,
    source,
    effectiveSource: explicitPath ? "path" : source,
    configuredSource,
    requiresNextTurn: action !== "show",
    ...(explicitPath ? { hostOverride: true } : {}),
    ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
  };
}

export function createSkillSourceConfigTool(
  configPath: string,
  configuredSource: SkillSourceMode,
  options: SkillSourceConfigToolOptions = {},
): RuntimeTool<unknown, SkillSourceConfigResult> {
  const onConfigured = typeof options.onConfigured === "function" ? options.onConfigured : () => {};
  const explicitPath = options.explicitPath === true;
  return {
    name: "odai_skill_source_config",
    description: [
      "Inspect, set, or reset how the Odai DSH Agent and Plugin select their governance skill bundle.",
      "Use only when the user naturally asks about this source or explicitly chooses bundled, auto, or user.",
      "Never enable project/user overrides by inference. The persisted setting is shared by Agent and Plugin and applies from the next user turn.",
    ].join(" "),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["show", "set", "remove"],
          description: "Show the effective source, set a user-selected source, or remove the persisted override.",
        },
        source: {
          type: "string",
          enum: [...SKILL_SOURCE_MODES],
          description: "Required only for set; bundled, auto, or user must be explicitly chosen by the user.",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "configPath", "source", "effectiveSource", "configuredSource", "requiresNextTurn"],
        properties: {
          action: { type: "string", enum: ["show", "set", "remove"] },
          configPath: { type: "string" },
          source: { type: "string", enum: [...SKILL_SOURCE_MODES] },
          effectiveSource: { type: "string", enum: [...SKILL_SOURCE_MODES, "path"] },
          configuredSource: { type: "string", enum: [...SKILL_SOURCE_MODES] },
          requiresNextTurn: { type: "boolean" },
          hostOverride: { type: "boolean" },
          recoveredInvalidStore: { type: "boolean" },
        },
      },
      render(_arguments, value) {
        return [{
          type: "text",
          text: [
            `${value.action === "show" ? "Current" : "Updated"} Odai skill source: ${value.effectiveSource}.`,
            ...(value.hostOverride ? [` The stored ${value.source} choice is inactive while an explicit host skill path is configured.`] : []),
            ...(value.recoveredInvalidStore ? [" An invalid prior store was preserved and replaced."] : []),
            ...(value.requiresNextTurn ? [" The change applies from the next user turn."] : []),
          ].join(""),
        }];
      },
    },
    execute(arguments_, execution) {
      if (!execution.agent) throw new Error("odai_skill_source_config requires an owning agent session");
      const header = execution.agent.session?.header;
      if (header?.origin === "subagent" || (Number.isSafeInteger(header?.delegationDepth) && (header?.delegationDepth ?? 0) > 0)) {
        throw new Error("child agents may not change Odai skill source configuration");
      }
      if (!isUnknownRecord(arguments_)) throw new TypeError("arguments must be an object");
      const unknownFields = Object.keys(arguments_).filter((field) => !["action", "source"].includes(field));
      if (unknownFields.length > 0) throw new TypeError(`unknown arguments: ${unknownFields.join(", ")}`);
      const action = arguments_.action;
      if (action !== "show" && action !== "set" && action !== "remove") throw new TypeError("action must be show, set, or remove");
      if (action === "show") {
        if (arguments_.source !== undefined) throw new TypeError("source must be omitted for show");
        return Promise.resolve(resultFor(
          configPath,
          "show",
          effectiveSkillSource(configPath, configuredSource),
          configuredSource,
          false,
          explicitPath,
        ));
      }
      if (action === "set" && !isSkillSourceMode(arguments_.source)) {
        throw new TypeError("source must be bundled, auto, or user for set");
      }
      if (action === "remove" && arguments_.source !== undefined) {
        throw new TypeError("source must be omitted for remove");
      }

      const releaseLock = acquireStoreLock(configPath);
      try {
        let recoveredInvalidStore = false;
        try {
          readSkillSourceStore(configPath);
        } catch {
          recoveredInvalidStore = preserveInvalidStore(configPath);
        }
        const source = action === "set" && isSkillSourceMode(arguments_.source)
          ? arguments_.source
          : configuredSource;
        if (action === "set") writeSkillSourceStore(configPath, source);
        else rmSync(configPath, { force: true });
        onConfigured(execution.agent, {
          action,
          source,
          ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
        });
        return Promise.resolve(resultFor(
          configPath,
          action,
          source,
          configuredSource,
          recoveredInvalidStore,
          explicitPath,
        ));
      } finally {
        releaseLock();
      }
    },
  };
}
