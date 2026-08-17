import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { acquireOwnedStoreLock } from "./store-lock.mjs";

export const HUMAN_SAFETY_CONTINUITY_SCHEMA_VERSION = 1;
export const HUMAN_SAFETY_CONTINUITY_CATEGORIES = Object.freeze([
  "care-preference",
  "noticed-signal",
  "effective-support",
  "safety-plan",
]);
export const MAX_HUMAN_SAFETY_CONTINUITY_ENTRIES = 80;
export const MAX_HUMAN_SAFETY_CONTINUITY_VALUE_CHARS = 600;

const STORE_FIELDS = new Set(["schemaVersion", "entries"]);
const ENTRY_FIELDS = new Set(["id", "category", "value", "createdAt", "updatedAt"]);

export class HumanSafetyContinuityStoreValidationError extends Error {}

function assertPlainObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function rejectUnknown(value, allowed, field) {
  const unknown = Object.keys(value).filter((name) => !allowed.has(name));
  if (unknown.length > 0) throw new TypeError(`${field} has unknown fields: ${unknown.join(", ")}`);
}

function requiredString(value, field, max) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function validateTimestamp(value, field) {
  requiredString(value, field, 64);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return value;
}

function validateEntry(value, field) {
  const entry = assertPlainObject(value, field);
  rejectUnknown(entry, ENTRY_FIELDS, field);
  requiredString(entry.id, `${field}.id`, 64);
  if (!HUMAN_SAFETY_CONTINUITY_CATEGORIES.includes(entry.category)) {
    throw new TypeError(`${field}.category is not supported`);
  }
  requiredString(entry.value, `${field}.value`, MAX_HUMAN_SAFETY_CONTINUITY_VALUE_CHARS);
  validateTimestamp(entry.createdAt, `${field}.createdAt`);
  validateTimestamp(entry.updatedAt, `${field}.updatedAt`);
  return Object.freeze({
    id: entry.id,
    category: entry.category,
    value: entry.value,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

function validateStore(value, field) {
  const store = assertPlainObject(value, field);
  rejectUnknown(store, STORE_FIELDS, field);
  if (store.schemaVersion !== HUMAN_SAFETY_CONTINUITY_SCHEMA_VERSION) {
    throw new TypeError(`${field}.schemaVersion must be ${HUMAN_SAFETY_CONTINUITY_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(store.entries) || store.entries.length > MAX_HUMAN_SAFETY_CONTINUITY_ENTRIES) {
    throw new TypeError(`${field}.entries must contain at most ${MAX_HUMAN_SAFETY_CONTINUITY_ENTRIES} items`);
  }
  const entries = store.entries.map((entry, index) => validateEntry(entry, `${field}.entries[${index}]`));
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new TypeError(`${field}.entries contains duplicate id ${entry.id}`);
    ids.add(entry.id);
  }
  return Object.freeze({
    schemaVersion: HUMAN_SAFETY_CONTINUITY_SCHEMA_VERSION,
    entries: Object.freeze(entries),
  });
}

function emptyStore() {
  return Object.freeze({
    schemaVersion: HUMAN_SAFETY_CONTINUITY_SCHEMA_VERSION,
    entries: Object.freeze([]),
  });
}

function assertNoSymlink(path, label) {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
}

function assertSafeStorePath(storePath) {
  const parent = dirname(storePath);
  const grandparent = dirname(parent);
  assertNoSymlink(grandparent, "Odai human-safety continuity parent");
  assertNoSymlink(parent, "Odai human-safety continuity directory");
  assertNoSymlink(storePath, "Odai human-safety continuity store");
  if (existsSync(parent) && !lstatSync(parent).isDirectory()) {
    throw new Error(`Odai human-safety continuity directory is not a directory: ${parent}`);
  }
  if (existsSync(storePath) && !lstatSync(storePath).isFile()) {
    throw new Error(`Odai human-safety continuity store is not a regular file: ${storePath}`);
  }
  return [grandparent, parent]
    .filter((path) => existsSync(path))
    .map((path) => {
      const stat = lstatSync(path);
      return Object.freeze({ path, dev: stat.dev, ino: stat.ino });
    });
}

function assertDirectoryIdentities(identities) {
  for (const identity of identities) {
    const stat = lstatSync(identity.path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw new Error(`Odai human-safety continuity directory identity changed during an operation: ${identity.path}`);
    }
  }
}

function readRegularFileNoFollow(path) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Odai human-safety continuity store is not a regular file: ${path}`);
    return readFileSync(fd, "utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function resolveHumanSafetyContinuityStorePath(configuredPath, env = process.env) {
  if (configuredPath !== undefined) {
    if (typeof configuredPath !== "string" || configuredPath.trim() === "") {
      throw new TypeError("human-safety continuity store path must be a non-empty string");
    }
    return resolve(configuredPath.trim());
  }
  const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== ""
    ? resolve(env.DSH_HOME.trim())
    : resolve(homedir(), ".dsh");
  return resolve(dshHome, "odai", "human-safety-continuity.json");
}

export function readHumanSafetyContinuityStore(storePath) {
  const identities = assertSafeStorePath(storePath);
  let text;
  try {
    text = readRegularFileNoFollow(storePath);
  } catch (error) {
    assertDirectoryIdentities(identities);
    if (error?.code === "ENOENT") return emptyStore();
    throw new Error(`cannot read Odai human-safety continuity ${storePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  assertDirectoryIdentities(identities);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new HumanSafetyContinuityStoreValidationError(`Odai human-safety continuity ${storePath} is not valid JSON`, { cause: error });
  }
  try {
    return validateStore(parsed, `Odai human-safety continuity ${storePath}`);
  } catch (error) {
    throw new HumanSafetyContinuityStoreValidationError(
      `Odai human-safety continuity ${storePath} failed validation: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function writeStore(storePath, store) {
  const value = validateStore(store, "Odai human-safety continuity write");
  const parent = dirname(storePath);
  assertSafeStorePath(storePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const identities = assertSafeStorePath(storePath);
  const temporary = `${storePath}.tmp-${process.pid}-${randomUUID()}`;
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  try {
    let fd;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    assertSafeStorePath(storePath);
    assertDirectoryIdentities(identities);
    renameSync(temporary, storePath);
    assertDirectoryIdentities(identities);
  } finally {
    rmSync(temporary, { force: true });
  }
  return value;
}

export function mutateHumanSafetyContinuityStore(storePath, mutate) {
  if (typeof mutate !== "function") throw new TypeError("human-safety continuity mutator must be a function");
  const identities = assertSafeStorePath(storePath);
  const releaseLock = acquireOwnedStoreLock(storePath, "Odai human-safety continuity");
  try {
    assertDirectoryIdentities(identities);
    const current = readHumanSafetyContinuityStore(storePath);
    const mutable = {
      schemaVersion: HUMAN_SAFETY_CONTINUITY_SCHEMA_VERSION,
      entries: current.entries.map((entry) => ({ ...entry })),
    };
    const outcome = mutate(mutable);
    if (!outcome || outcome.changed !== true) return Object.freeze({ store: current, ...(outcome ?? {}) });
    const store = writeStore(storePath, mutable);
    return Object.freeze({ ...outcome, changed: true, store });
  } finally {
    releaseLock();
  }
}

export function clearHumanSafetyContinuityStore(storePath) {
  const identities = assertSafeStorePath(storePath);
  const releaseLock = acquireOwnedStoreLock(storePath, "Odai human-safety continuity");
  try {
    assertDirectoryIdentities(identities);
    const existed = existsSync(storePath);
    rmSync(storePath, { force: true });
    assertDirectoryIdentities(identities);
    return Object.freeze({ changed: existed, store: emptyStore() });
  } finally {
    releaseLock();
  }
}
