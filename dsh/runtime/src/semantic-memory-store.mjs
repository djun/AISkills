import { createHash, randomUUID } from "node:crypto";
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
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { acquireOwnedStoreLock } from "./store-lock.mjs";

export const MEMORY_STORE_SCHEMA_VERSION = 1;
export const MEMORY_EXTRACTOR_VERSION = 1;
export const MEMORY_MODES = Object.freeze(["auto", "off"]);
export const MEMORY_CATEGORIES = Object.freeze(["preference", "decision", "constraint", "fact"]);
export const MEMORY_STATUSES = Object.freeze(["pending", "active", "superseded"]);
export const DEFAULT_MEMORY_SETTINGS = Object.freeze({ mode: "auto" });
export const MAX_MEMORY_ENTRIES = 1_000;
export const MAX_MEMORY_PROVENANCE = 8;
export const MAX_MEMORY_VALUE_CHARS = 600;

const STORE_FIELDS = new Set(["schemaVersion", "settings", "entries"]);
const SETTINGS_FIELDS = new Set(["mode"]);
const ENTRY_FIELDS = new Set([
  "id",
  "scope",
  "category",
  "subject",
  "value",
  "status",
  "confidence",
  "supersedes",
  "conflictsWith",
  "provenance",
  "createdAt",
  "updatedAt",
  "occurrences",
]);
const SCOPE_FIELDS = new Set(["kind", "key", "label"]);
const PROVENANCE_FIELDS = new Set([
  "sourceKind",
  "sessionHash",
  "messageHash",
  "turn",
  "eventSeq",
  "excerptSha256",
  "observedAt",
  "extraction",
  "extractorVersion",
]);

export class MemoryStoreValidationError extends Error {}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

function requiredString(value, field, max = 1_000) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function safeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

function validateMode(mode, field = "memory mode") {
  if (!MEMORY_MODES.includes(mode)) throw new TypeError(`${field} must be auto or off`);
  return mode;
}

function validateScope(value, field) {
  const scope = assertPlainObject(value, field);
  rejectUnknown(scope, SCOPE_FIELDS, field);
  if (!["global", "project"].includes(scope.kind)) throw new TypeError(`${field}.kind must be global or project`);
  requiredString(scope.key, `${field}.key`, 64);
  if (scope.kind === "global" && scope.key !== "global") throw new TypeError(`${field}.key must be global for global scope`);
  if (scope.kind === "project" && !/^[a-f0-9]{64}$/u.test(scope.key)) {
    throw new TypeError(`${field}.key must be a sha256 project key`);
  }
  if (scope.label !== undefined) requiredString(scope.label, `${field}.label`, 120);
  return Object.freeze({
    kind: scope.kind,
    key: scope.key,
    ...(scope.label === undefined ? {} : { label: scope.label }),
  });
}

function validateProvenance(value, field) {
  const provenance = assertPlainObject(value, field);
  rejectUnknown(provenance, PROVENANCE_FIELDS, field);
  if (provenance.sourceKind !== "direct-user") throw new TypeError(`${field}.sourceKind must be direct-user`);
  if (!/^[a-f0-9]{64}$/u.test(provenance.sessionHash)) throw new TypeError(`${field}.sessionHash must be sha256`);
  if (!/^[a-f0-9]{64}$/u.test(provenance.messageHash)) throw new TypeError(`${field}.messageHash must be sha256`);
  if (!/^[a-f0-9]{64}$/u.test(provenance.excerptSha256)) throw new TypeError(`${field}.excerptSha256 must be sha256`);
  safeInteger(provenance.turn, `${field}.turn`);
  if (provenance.eventSeq !== undefined) safeInteger(provenance.eventSeq, `${field}.eventSeq`);
  safeInteger(provenance.observedAt, `${field}.observedAt`);
  if (!["local-explicit", "tool-exact-excerpt"].includes(provenance.extraction)) {
    throw new TypeError(`${field}.extraction is unsupported`);
  }
  if (provenance.extractorVersion !== MEMORY_EXTRACTOR_VERSION) {
    throw new TypeError(`${field}.extractorVersion is unsupported`);
  }
  return Object.freeze({
    sourceKind: "direct-user",
    sessionHash: provenance.sessionHash,
    messageHash: provenance.messageHash,
    turn: provenance.turn,
    ...(provenance.eventSeq === undefined ? {} : { eventSeq: provenance.eventSeq }),
    excerptSha256: provenance.excerptSha256,
    observedAt: provenance.observedAt,
    extraction: provenance.extraction,
    extractorVersion: provenance.extractorVersion,
  });
}

function validateEntry(value, field) {
  const entry = assertPlainObject(value, field);
  rejectUnknown(entry, ENTRY_FIELDS, field);
  requiredString(entry.id, `${field}.id`, 80);
  const scope = validateScope(entry.scope, `${field}.scope`);
  if (!MEMORY_CATEGORIES.includes(entry.category)) throw new TypeError(`${field}.category is unsupported`);
  requiredString(entry.subject, `${field}.subject`, 64);
  requiredString(entry.value, `${field}.value`, MAX_MEMORY_VALUE_CHARS);
  if (!MEMORY_STATUSES.includes(entry.status)) throw new TypeError(`${field}.status is unsupported`);
  if (!["high", "medium"].includes(entry.confidence)) throw new TypeError(`${field}.confidence is unsupported`);
  if (!Array.isArray(entry.supersedes) || entry.supersedes.length > 64) {
    throw new TypeError(`${field}.supersedes must be an array with at most 64 entries`);
  }
  const supersedes = entry.supersedes.map((id, index) => requiredString(id, `${field}.supersedes[${index}]`, 80));
  if (!Array.isArray(entry.conflictsWith) || entry.conflictsWith.length > 64) {
    throw new TypeError(`${field}.conflictsWith must be an array with at most 64 entries`);
  }
  const conflictsWith = entry.conflictsWith.map((id, index) => requiredString(id, `${field}.conflictsWith[${index}]`, 80));
  if (!Array.isArray(entry.provenance)
    || entry.provenance.length === 0
    || entry.provenance.length > MAX_MEMORY_PROVENANCE) {
    throw new TypeError(`${field}.provenance must contain 1-${MAX_MEMORY_PROVENANCE} entries`);
  }
  const provenance = entry.provenance.map((item, index) => validateProvenance(item, `${field}.provenance[${index}]`));
  const createdAt = safeInteger(entry.createdAt, `${field}.createdAt`);
  const updatedAt = safeInteger(entry.updatedAt, `${field}.updatedAt`);
  if (updatedAt < createdAt) throw new TypeError(`${field}.updatedAt must not precede createdAt`);
  const occurrences = safeInteger(entry.occurrences, `${field}.occurrences`);
  if (occurrences < 1) throw new TypeError(`${field}.occurrences must be positive`);
  return Object.freeze({
    id: entry.id,
    scope,
    category: entry.category,
    subject: entry.subject,
    value: entry.value,
    status: entry.status,
    confidence: entry.confidence,
    supersedes: Object.freeze(supersedes),
    conflictsWith: Object.freeze(conflictsWith),
    provenance: Object.freeze(provenance),
    createdAt,
    updatedAt,
    occurrences,
  });
}

function validateStore(value, field) {
  const store = assertPlainObject(value, field);
  rejectUnknown(store, STORE_FIELDS, field);
  if (store.schemaVersion !== MEMORY_STORE_SCHEMA_VERSION) {
    throw new TypeError(`${field} has unsupported schemaVersion ${String(store.schemaVersion)}`);
  }
  const settingsValue = store.settings === undefined ? {} : assertPlainObject(store.settings, `${field}.settings`);
  rejectUnknown(settingsValue, SETTINGS_FIELDS, `${field}.settings`);
  const settings = Object.freeze({
    ...(settingsValue.mode === undefined ? {} : { mode: validateMode(settingsValue.mode, `${field}.settings.mode`) }),
  });
  if (!Array.isArray(store.entries) || store.entries.length > MAX_MEMORY_ENTRIES) {
    throw new TypeError(`${field}.entries must be an array with at most ${MAX_MEMORY_ENTRIES} records`);
  }
  const entries = store.entries.map((entry, index) => validateEntry(entry, `${field}.entries[${index}]`));
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new TypeError(`${field}.entries contains duplicate id ${entry.id}`);
    ids.add(entry.id);
  }
  return Object.freeze({
    schemaVersion: MEMORY_STORE_SCHEMA_VERSION,
    settings,
    entries: Object.freeze(entries),
  });
}

function emptyStore() {
  return Object.freeze({
    schemaVersion: MEMORY_STORE_SCHEMA_VERSION,
    settings: Object.freeze({}),
    entries: Object.freeze([]),
  });
}

function assertNoSymlink(path, label) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
}

function assertSafeStorePath(storePath) {
  const parent = dirname(storePath);
  const grandparent = dirname(parent);
  assertNoSymlink(grandparent, "Odai memory parent");
  assertNoSymlink(parent, "Odai memory directory");
  assertNoSymlink(storePath, "Odai memory store");
  if (existsSync(parent) && !lstatSync(parent).isDirectory()) {
    throw new Error(`Odai memory directory is not a directory: ${parent}`);
  }
  if (existsSync(storePath) && !lstatSync(storePath).isFile()) {
    throw new Error(`Odai memory store is not a regular file: ${storePath}`);
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
      throw new Error(`Odai memory directory identity changed during an operation: ${identity.path}`);
    }
  }
}

function readRegularFileNoFollow(path) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Odai memory store is not a regular file: ${path}`);
    return readFileSync(fd, "utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function resolveMemoryStorePath(configuredPath, env = process.env) {
  if (configuredPath !== undefined) {
    if (typeof configuredPath !== "string" || configuredPath.trim() === "") {
      throw new TypeError("config.memory.storePath must be a non-empty string");
    }
    return resolve(configuredPath.trim());
  }
  const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== ""
    ? resolve(env.DSH_HOME.trim())
    : resolve(homedir(), ".dsh");
  return resolve(dshHome, "odai", "memory", "store.json");
}

export function readMemoryStore(storePath) {
  const identities = assertSafeStorePath(storePath);
  let text;
  try {
    text = readRegularFileNoFollow(storePath);
  } catch (error) {
    assertDirectoryIdentities(identities);
    if (error?.code === "ENOENT") return emptyStore();
    throw new Error(`cannot read Odai semantic memory ${storePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  assertDirectoryIdentities(identities);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MemoryStoreValidationError(`Odai semantic memory ${storePath} is not valid JSON`, { cause: error });
  }
  try {
    return validateStore(parsed, `Odai semantic memory ${storePath}`);
  } catch (error) {
    if (error instanceof MemoryStoreValidationError) throw error;
    throw new MemoryStoreValidationError(
      `Odai semantic memory ${storePath} failed validation: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function writeMemoryStore(storePath, store) {
  const value = validateStore(store, "Odai semantic memory write");
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

export function mutateMemoryStore(storePath, mutate) {
  if (typeof mutate !== "function") throw new TypeError("memory mutator must be a function");
  const identities = assertSafeStorePath(storePath);
  const releaseLock = acquireOwnedStoreLock(storePath, "Odai semantic memory");
  try {
    assertDirectoryIdentities(identities);
    const current = readMemoryStore(storePath);
    const mutable = {
      schemaVersion: MEMORY_STORE_SCHEMA_VERSION,
      settings: { ...current.settings },
      entries: current.entries.map((entry) => ({
        ...entry,
        scope: { ...entry.scope },
        supersedes: [...entry.supersedes],
        conflictsWith: [...entry.conflictsWith],
        provenance: entry.provenance.map((source) => ({ ...source })),
      })),
    };
    const outcome = mutate(mutable);
    if (!outcome || outcome.changed !== true) return Object.freeze({ store: current, ...(outcome ?? {}) });
    const store = writeMemoryStore(storePath, mutable);
    return Object.freeze({ ...outcome, changed: true, store });
  } finally {
    releaseLock();
  }
}

export function resetMemoryStore(storePath) {
  const identities = assertSafeStorePath(storePath);
  const releaseLock = acquireOwnedStoreLock(storePath, "Odai semantic memory");
  try {
    assertSafeStorePath(storePath);
    assertDirectoryIdentities(identities);
    rmSync(storePath, { force: true });
    assertDirectoryIdentities(identities);
    return writeMemoryStore(storePath, {
      schemaVersion: MEMORY_STORE_SCHEMA_VERSION,
      settings: {},
      entries: [],
    });
  } finally {
    releaseLock();
  }
}

export function effectiveMemorySettings(storePath, configured = {}) {
  const configuredMode = validateMode(configured.mode ?? DEFAULT_MEMORY_SETTINGS.mode, "config.memory.mode");
  const store = readMemoryStore(storePath);
  if (configuredMode === "off") return Object.freeze({ mode: "off", source: "deployment-config" });
  return Object.freeze({
    mode: store.settings.mode ?? configuredMode,
    source: store.settings.mode === undefined ? "deployment-default" : "persisted",
  });
}

export function globalMemoryScope() {
  return Object.freeze({ kind: "global", key: "global", label: "global" });
}

export function projectMemoryScope(cwd) {
  if (typeof cwd !== "string" || cwd.trim() === "") return undefined;
  let canonical;
  try {
    canonical = realpathSync.native(resolve(cwd.trim()));
    if (!lstatSync(canonical).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return Object.freeze({
    kind: "project",
    key: hash(canonical),
    label: basename(canonical) || "project",
  });
}

function eventSeqFor(agent, messageId) {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "user/message" && event.data?.id === messageId && Number.isSafeInteger(event.seq)) return event.seq;
  }
  return undefined;
}

export function directUserProvenance({ agent, message, turn, excerpt, extraction, now = Date.now() }) {
  const sessionId = agent?.session?.header?.id;
  const messageId = message?.id;
  if (typeof sessionId !== "string" || sessionId === "" || typeof messageId !== "string" || messageId === "") {
    return undefined;
  }
  if (!Number.isSafeInteger(turn) || turn < 0) return undefined;
  const eventSeq = eventSeqFor(agent, messageId);
  return Object.freeze({
    sourceKind: "direct-user",
    sessionHash: hash(sessionId),
    messageHash: hash(messageId),
    turn,
    ...(eventSeq === undefined ? {} : { eventSeq }),
    excerptSha256: hash(excerpt),
    observedAt: now,
    extraction,
    extractorVersion: MEMORY_EXTRACTOR_VERSION,
  });
}

export function memoryRecordId(scope, category, subject, value) {
  return `mem-${hash(JSON.stringify([scope.kind, scope.key, category, subject, value])).slice(0, 32)}`;
}

export function memoryValueDigest(value) {
  return hash(value);
}
