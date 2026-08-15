import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const ODAI_RUNTIME_CONTRACT = 1;
export const SKILL_MANIFEST_FILE = "manifest.json";
export const SKILL_SOURCE_MODES = Object.freeze(["bundled", "auto", "user"]);

const MANIFEST_FIELDS = new Set([
  "schemaVersion",
  "name",
  "skillVersion",
  "runtimeContract",
  "requiredFiles",
]);
const REQUIRED_RUNTIME_FILES = Object.freeze([
  "SKILL.md",
  "assets/routing-roles/controller.md",
  "assets/routing-roles/planner.md",
  "assets/routing-roles/executor.md",
  "assets/routing-roles/reviewer.md",
]);
const PROJECT_SOURCES = new Set(["project-dsh", "project-agents", "custom"]);
const USER_SOURCES = new Set(["user-dsh", "user-agents"]);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function assertPlainObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

export function parseSkillVersion(value, field = "skillVersion") {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const match = value.match(VERSION_PATTERN);
  if (!match) throw new TypeError(`${field} must use SemVer 2.0.0 syntax`);
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  for (const identifier of prerelease) {
    if (/^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
      throw new TypeError(`${field} has a numeric prerelease identifier with a leading zero`);
    }
  }
  return Object.freeze({
    core: Object.freeze(match.slice(1, 4)),
    prerelease: Object.freeze(prerelease),
  });
}

function compareNumericIdentifier(left, right) {
  if (left.length < right.length) return -1;
  if (left.length > right.length) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined) return -1;
    if (rightValue === undefined) return 1;
    const leftNumeric = /^\d+$/u.test(leftValue);
    const rightNumeric = /^\d+$/u.test(rightValue);
    if (leftNumeric && rightNumeric) {
      const difference = compareNumericIdentifier(leftValue, rightValue);
      if (difference !== 0) return difference;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

export function compareSkillVersions(left, right) {
  const leftVersion = typeof left === "string" ? parseSkillVersion(left, "left skillVersion") : left;
  const rightVersion = typeof right === "string" ? parseSkillVersion(right, "right skillVersion") : right;
  for (let index = 0; index < 3; index += 1) {
    const difference = compareNumericIdentifier(leftVersion.core[index], rightVersion.core[index]);
    if (difference !== 0) return difference;
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function resolveBundleFile(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new TypeError("skill manifest requiredFiles entries must be non-empty strings");
  }
  const segments = relativePath.split("/");
  if (relativePath !== relativePath.trim()
    || relativePath.includes("\\")
    || isAbsolute(relativePath)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError(`skill manifest contains unsafe required file ${JSON.stringify(relativePath)}`);
  }
  const target = resolve(root, ...segments);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new TypeError(`skill manifest required file escapes its bundle: ${relativePath}`);
  }
  return target;
}

function assertRealPathInside(rootRealPath, target, label) {
  const targetRealPath = realpathSync(target);
  const fromRoot = relative(rootRealPath, targetRealPath);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Odai skill bundle path escapes through a symlink: ${label}`);
  }
  return targetRealPath;
}

export function readSkillManifest(skillRoot) {
  const rootRealPath = realpathSync(skillRoot);
  const manifestPath = resolve(skillRoot, SKILL_MANIFEST_FILE);
  let parsed;
  try {
    const manifestRealPath = assertRealPathInside(rootRealPath, manifestPath, SKILL_MANIFEST_FILE);
    parsed = JSON.parse(readFileSync(manifestRealPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read Odai skill manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = assertPlainObject(parsed, `Odai skill manifest ${manifestPath}`);
  const unknown = Object.keys(manifest).filter((field) => !MANIFEST_FIELDS.has(field));
  if (unknown.length > 0) {
    throw new TypeError(`Odai skill manifest ${manifestPath} has unknown fields: ${unknown.join(", ")}`);
  }
  if (manifest.schemaVersion !== 1) {
    throw new TypeError(`Odai skill manifest ${manifestPath} has unsupported schemaVersion ${String(manifest.schemaVersion)}`);
  }
  if (manifest.name !== "odai") throw new TypeError(`Odai skill manifest ${manifestPath} must name odai`);
  const versionParts = parseSkillVersion(manifest.skillVersion, `Odai skill manifest ${manifestPath}.skillVersion`);
  if (!Number.isSafeInteger(manifest.runtimeContract) || manifest.runtimeContract <= 0) {
    throw new TypeError(`Odai skill manifest ${manifestPath}.runtimeContract must be a positive integer`);
  }
  if (!Array.isArray(manifest.requiredFiles) || manifest.requiredFiles.length === 0) {
    throw new TypeError(`Odai skill manifest ${manifestPath}.requiredFiles must be a non-empty array`);
  }
  const requiredFiles = manifest.requiredFiles.map((file) => {
    resolveBundleFile(skillRoot, file);
    return file;
  });
  if (new Set(requiredFiles).size !== requiredFiles.length) {
    throw new TypeError(`Odai skill manifest ${manifestPath}.requiredFiles contains duplicates`);
  }
  for (const required of REQUIRED_RUNTIME_FILES) {
    if (!requiredFiles.includes(required)) {
      throw new TypeError(`Odai skill manifest ${manifestPath} is missing required runtime file ${required}`);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    name: "odai",
    skillVersion: manifest.skillVersion,
    versionParts,
    runtimeContract: manifest.runtimeContract,
    requiredFiles: Object.freeze(requiredFiles),
  });
}

export function loadSkillBundle(skillPath, options = {}) {
  const entryPath = resolve(skillPath);
  const root = dirname(entryPath);
  const rootRealPath = realpathSync(root);
  const manifest = readSkillManifest(root);
  const digest = createHash("sha256");
  const contents = new Map();
  digest.update(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    name: manifest.name,
    skillVersion: manifest.skillVersion,
    runtimeContract: manifest.runtimeContract,
    requiredFiles: manifest.requiredFiles,
  }));

  for (const relativePath of [...manifest.requiredFiles].sort()) {
    const path = resolveBundleFile(root, relativePath);
    if (!existsSync(path)) throw new Error(`Odai skill bundle ${root} is missing ${relativePath}`);
    const realPath = assertRealPathInside(rootRealPath, path, relativePath);
    const content = readFileSync(realPath);
    contents.set(relativePath, content);
    digest.update("\0");
    digest.update(relativePath);
    digest.update("\0");
    digest.update(content);
  }

  const skillText = contents.get("SKILL.md").toString("utf8").trim();
  if (!skillText) throw new Error(`Odai canonical skill is empty: ${entryPath}`);
  const frontmatter = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
  if (!frontmatter || !/^name:\s*odai\s*$/mu.test(frontmatter)) {
    throw new Error(`Odai canonical skill entry does not declare name odai: ${entryPath}`);
  }

  const roleContracts = Object.freeze(Object.fromEntries(["controller", "planner", "executor", "reviewer"].map((role) => {
    const relativePath = `assets/routing-roles/${role}.md`;
    const text = contents.get(relativePath).toString("utf8").trim();
    if (!text) throw new Error(`Odai canonical ${role} role is unavailable: ${resolve(root, relativePath)}`);
    return [role, text];
  })));

  return Object.freeze({
    path: entryPath,
    root,
    source: typeof options.source === "string" && options.source ? options.source : "bundled",
    provider: typeof options.provider === "string" && options.provider ? options.provider : "odai-dsh-runtime",
    manifest,
    skillText,
    roleContracts,
    digest: digest.digest("hex"),
  });
}

function fallbackSelection(mode, bundled, reasonCode, detail, candidate) {
  return Object.freeze({
    mode,
    status: "fallback",
    reasonCode,
    detail,
    bundle: bundled,
    ...(candidate ? { candidate } : {}),
  });
}

function selected(mode, bundle, reasonCode, candidate) {
  return Object.freeze({
    mode,
    status: "selected",
    reasonCode,
    bundle,
    ...(candidate ? { candidate } : {}),
  });
}

export function chooseSkillBundle({ mode, bundled, candidate, candidateError } = {}) {
  if (!SKILL_SOURCE_MODES.includes(mode)) throw new TypeError(`unknown Odai skill source mode: ${String(mode)}`);
  if (!bundled) throw new TypeError("bundled Odai skill is required");
  if (mode === "bundled") return selected(mode, bundled, "bundled-configured");
  if (candidateError) {
    return fallbackSelection(mode, bundled, "external-invalid", candidateError instanceof Error ? candidateError.message : String(candidateError));
  }
  if (!candidate) {
    return mode === "auto"
      ? selected(mode, bundled, "external-not-installed")
      : fallbackSelection(mode, bundled, "user-source-missing", "no compatible user-level Odai skill is installed");
  }
  if (candidate.manifest.runtimeContract !== ODAI_RUNTIME_CONTRACT) {
    return fallbackSelection(
      mode,
      bundled,
      "runtime-contract-mismatch",
      `candidate runtimeContract ${candidate.manifest.runtimeContract} is incompatible with runtime contract ${ODAI_RUNTIME_CONTRACT}`,
      candidate,
    );
  }

  const versionOrder = compareSkillVersions(candidate.manifest.versionParts, bundled.manifest.versionParts);
  if (versionOrder === 0) {
    if (candidate.digest === bundled.digest) return selected(mode, bundled, "external-equivalent", candidate);
    return fallbackSelection(
      mode,
      bundled,
      "same-version-content-conflict",
      `candidate ${candidate.manifest.skillVersion} differs from the bundled content with the same version`,
      candidate,
    );
  }

  if (mode === "user") {
    if (!USER_SOURCES.has(candidate.source) && candidate.source !== "custom") {
      return fallbackSelection(mode, bundled, "user-source-invalid", `source ${candidate.source} is not user-level`, candidate);
    }
    return selected(mode, candidate, "user-configured", candidate);
  }
  if (PROJECT_SOURCES.has(candidate.source)) return selected(mode, candidate, "project-scope-override", candidate);
  if (USER_SOURCES.has(candidate.source)) {
    return versionOrder > 0
      ? selected(mode, candidate, "newer-user-skill", candidate)
      : fallbackSelection(
          mode,
          bundled,
          "user-skill-older",
          `candidate ${candidate.manifest.skillVersion} is older than bundled ${bundled.manifest.skillVersion}`,
          candidate,
        );
  }
  return fallbackSelection(mode, bundled, "external-source-unsupported", `source ${candidate.source} cannot provide Odai governance`, candidate);
}
