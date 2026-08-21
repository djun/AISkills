import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, parse, resolve } from "node:path";

import {
  chooseSkillBundle,
  loadSkillBundle,
  type SkillBundle,
  type SkillBundleSelection,
  type SkillSourceMode,
} from "./skill-bundle.mjs";
import type { SkillRegistry } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

const PROJECT_SOURCES = new Set<string>(["project-dsh", "project-agents"]);
const REGISTRY_SOURCES = new Set<string>(["custom", "user-dsh", "user-agents"]);

export interface SkillCandidate {
  readonly source: string;
  readonly provider: string;
  readonly path?: string;
  readonly error?: unknown;
}

export interface SkillRejection {
  readonly source: string;
  readonly reasonCode: string;
  readonly detail?: string;
}

export interface ResolvedSkillSelection extends SkillBundleSelection {
  readonly rejections: readonly SkillRejection[];
}

export interface ResolveSkillSelectionOptions {
  mode?: SkillSourceMode;
  bundled?: SkillBundle;
  cwd?: string;
  scope?: unknown;
  signal?: AbortSignal;
  skills?: SkillRegistry;
  env?: Readonly<Record<string, string | undefined>>;
}

export function findProjectRoot(cwd: unknown): string | undefined {
  if (typeof cwd !== "string" || cwd.trim() === "") return undefined;
  let current = resolve(cwd);
  const root = parse(current).root;
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    if (current === root) return resolve(cwd);
    current = dirname(current);
  }
}

function defaultDshHome(env: Readonly<Record<string, string | undefined>>): string {
  return typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== ""
    ? resolve(env.DSH_HOME.trim())
    : resolve(homedir(), ".dsh");
}

function defaultAgentsHome(env: Readonly<Record<string, string | undefined>>): string {
  return typeof env.DSH_AGENTS_HOME === "string" && env.DSH_AGENTS_HOME.trim() !== ""
    ? resolve(env.DSH_AGENTS_HOME.trim())
    : resolve(homedir(), ".agents");
}

async function registryCandidate(
  skills: SkillRegistry | undefined,
  scope: unknown,
  signal?: AbortSignal,
): Promise<Readonly<SkillCandidate> | undefined> {
  if (!skills || typeof skills.get !== "function") return undefined;
  const definition: unknown = await skills.get("odai", { scope, signal });
  if (!isUnknownRecord(definition) || !REGISTRY_SOURCES.has(String(definition.source))) return undefined;
  if (typeof definition.source !== "string") return undefined;
  if (typeof definition.path !== "string" || definition.path.trim() === "") {
    throw new Error(`${definition.source} Odai skill does not expose a local bundle path`);
  }
  return Object.freeze({
    path: definition.path,
    source: definition.source,
    provider: typeof definition.provider === "string" ? definition.provider : "dsh-skill-registry",
  });
}

function directCandidate(path: string, source: string): Readonly<SkillCandidate> {
  return Object.freeze({ path, source, provider: "odai-filesystem-resolver" });
}

function decorate(
  selection: Readonly<SkillBundleSelection>,
  rejections: readonly SkillRejection[],
): Readonly<ResolvedSkillSelection> {
  return Object.freeze({
    ...selection,
    rejections: Object.freeze(rejections.map((rejection) => Object.freeze({ ...rejection }))),
  });
}

function rejectionFor(
  candidate: Pick<SkillCandidate, "source">,
  reasonCode: string,
  detail?: string,
): SkillRejection {
  return {
    source: candidate.source,
    reasonCode,
    ...(detail === undefined ? {} : { detail }),
  };
}

export async function resolveSkillSelection(
  options: ResolveSkillSelectionOptions = {},
): Promise<Readonly<ResolvedSkillSelection>> {
  const {
    mode,
    bundled,
    cwd,
    scope,
    signal,
    skills,
    env = process.env,
  } = options;
  if (mode === "bundled") return decorate(chooseSkillBundle({ mode, bundled }), []);
  signal?.throwIfAborted();

  const candidates: SkillCandidate[] = [];
  if (mode === "auto") {
    const projectRoot = findProjectRoot(cwd);
    if (projectRoot) {
      candidates.push(
        directCandidate(resolve(projectRoot, ".dsh", "skills", "odai", "SKILL.md"), "project-dsh"),
        directCandidate(resolve(projectRoot, ".agents", "skills", "odai", "SKILL.md"), "project-agents"),
      );
    }
  }

  try {
    const registrySkill = await registryCandidate(skills, scope, signal);
    if (registrySkill) candidates.push(registrySkill);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    candidates.push(Object.freeze({ source: "custom", provider: "dsh-skill-registry", error }));
  }

  candidates.push(
    directCandidate(resolve(defaultDshHome(env), "skills", "odai", "SKILL.md"), "user-dsh"),
    directCandidate(resolve(defaultAgentsHome(env), "skills", "odai", "SKILL.md"), "user-agents"),
  );

  const rejections: SkillRejection[] = [];
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    if (candidate.error) {
      rejections.push(rejectionFor(candidate, "external-discovery-failed", candidate.error instanceof Error ? candidate.error.message : String(candidate.error)));
      continue;
    }
    if (!candidate.path || !existsSync(candidate.path)) continue;

    let bundle: Readonly<SkillBundle>;
    try {
      bundle = loadSkillBundle(candidate.path, candidate);
    } catch (error) {
      rejections.push(rejectionFor(candidate, "external-invalid", error instanceof Error ? error.message : String(error)));
      continue;
    }
    if (mode === "user" && PROJECT_SOURCES.has(bundle.source)) continue;

    const selection = chooseSkillBundle({ mode, bundled, candidate: bundle });
    if (selection.bundle === bundle && selection.status === "selected") {
      return decorate(selection, rejections);
    }
    if (selection.reasonCode === "external-equivalent") {
      return decorate(selection, rejections);
    }
    rejections.push(rejectionFor(bundle, selection.reasonCode, selection.detail));
  }

  const fallback = chooseSkillBundle({ mode, bundled });
  if (rejections.length === 0) return decorate(fallback, rejections);
  return decorate({
    ...fallback,
    status: "fallback",
    reasonCode: mode === "user" ? "user-source-unusable" : "external-candidates-rejected",
    detail: rejections.map((rejection) => `${rejection.source}:${rejection.reasonCode}`).join(", "),
  }, rejections);
}
