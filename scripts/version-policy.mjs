import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DIGIT_PATTERN = /^[0-9]$/u;
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u;

export function validateOwnedVersion(value, forbiddenDigits, label = "version") {
  const normalized = typeof value === "string"
    ? value
    : Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : "";
  if (normalized.length === 0) {
    throw new Error(`${label} must be a non-empty string or non-negative safe integer`);
  }
  const forbidden = validateForbiddenDigits(forbiddenDigits, "version policy forbiddenDigits");
  const matched = forbidden.find((digit) => normalized.includes(digit));
  if (matched) throw new Error(`${label} ${normalized} contains forbidden digit ${matched}`);
  return normalized;
}

export function assertRepositoryVersionPolicy(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const policyPath = resolve(repoRoot, options.policyPath ?? "version-policy.json");
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  if (policy.schemaVersion !== 1) throw new Error("version-policy.json must use schemaVersion 1");
  const forbiddenDigits = validateForbiddenDigits(policy.forbiddenDigits, "version-policy.json forbiddenDigits");
  if (!Array.isArray(policy.managedVersions) || policy.managedVersions.length === 0) {
    throw new Error("version-policy.json must declare non-empty managedVersions");
  }

  const seen = new Set();
  const versions = [];
  for (const [index, entry] of policy.managedVersions.entries()) {
    const label = `version-policy.json managedVersions[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label} must be an object`);
    if (typeof entry.path !== "string" || entry.path.length === 0 || isAbsolute(entry.path)) {
      throw new Error(`${label}.path must be a non-empty repository-relative path`);
    }
    const targetPath = resolve(repoRoot, entry.path);
    const fromRoot = relative(repoRoot, targetPath);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`${label}.path must stay inside the repository`);
    }
    if (typeof entry.field !== "string" || !FIELD_PATTERN.test(entry.field)) {
      throw new Error(`${label}.field must be a dotted JSON object field`);
    }
    if (typeof entry.label !== "string" || entry.label.trim().length === 0) {
      throw new Error(`${label}.label must be a non-empty string`);
    }
    const key = `${entry.path}#${entry.field}`;
    if (seen.has(key)) throw new Error(`version-policy.json maps ${key} more than once`);
    seen.add(key);

    const document = JSON.parse(readFileSync(targetPath, "utf8"));
    const value = readField(document, entry.field, label);
    versions.push(Object.freeze({
      path: entry.path,
      field: entry.field,
      label: entry.label,
      version: validateOwnedVersion(value, forbiddenDigits, entry.label),
    }));
  }
  return Object.freeze({ forbiddenDigits, versions: Object.freeze(versions) });
}

function validateForbiddenDigits(value, label) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length
    || value.some((digit) => typeof digit !== "string" || !DIGIT_PATTERN.test(digit))) {
    throw new Error(`${label} must list unique ASCII digits`);
  }
  return Object.freeze([...value]);
}

function readField(document, field, label) {
  let value = document;
  for (const segment of field.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, segment)) {
      throw new Error(`${label} cannot read field ${field}`);
    }
    value = value[segment];
  }
  return value;
}
