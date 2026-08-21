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
import type { UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

export const HUMAN_SAFETY_CONTINUITY_SCHEMA_VERSION = 1;
export const HUMAN_SAFETY_CONTINUITY_CATEGORIES = Object.freeze([
  "care-preference",
  "noticed-signal",
  "effective-support",
  "safety-plan",
] as const);
export type HumanSafetyContinuityCategory = (typeof HUMAN_SAFETY_CONTINUITY_CATEGORIES)[number];

export const MAX_HUMAN_SAFETY_CONTINUITY_ENTRIES = 80;
export const MAX_HUMAN_SAFETY_CONTINUITY_VALUE_CHARS = 600;

export interface HumanSafetyContinuityEntry {
  readonly id: string;
  readonly category: HumanSafetyContinuityCategory;
  readonly value: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HumanSafetyContinuityStore {
  readonly schemaVersion: 1;
  readonly entries: readonly HumanSafetyContinuityEntry[];
}

export interface MutableHumanSafetyContinuityEntry {
  id: string;
  category: HumanSafetyContinuityCategory;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface MutableHumanSafetyContinuityStore {
  schemaVersion: 1;
  entries: MutableHumanSafetyContinuityEntry[];
}

export interface ContinuityMutationOutcome extends UnknownRecord {
  changed?: boolean;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

const STORE_FIELDS = new Set<string>(["schemaVersion", "entries"]);
const ENTRY_FIELDS = new Set<string>(["id", "category", "value", "createdAt", "updatedAt"]);

export class HumanSafetyContinuityStoreValidationError extends Error {}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function rejectUnknown(value: UnknownRecord, allowed: ReadonlySet<string>, field: string): void {
  const unknownFields = Object.keys(value).filter((name) => !allowed.has(name));
  if (unknownFields.length > 0) throw new TypeError(`${field} has unknown fields: ${unknownFields.join(", ")}`);
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function validateTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field, 64);
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError(`${field} must be an ISO timestamp`);
  return timestamp;
}

function isContinuityCategory(value: unknown): value is HumanSafetyContinuityCategory {
  return typeof value === "string" && (HUMAN_SAFETY_CONTINUITY_CATEGORIES as readonly string[]).includes(value);
}

function validateEntry(value: unknown, field: string): Readonly<HumanSafetyContinuityEntry> {
  if (!isUnknownRecord(value)) throw new TypeError(`${field} must be an object`);
  rejectUnknown(value, ENTRY_FIELDS, field);
  const id = requiredString(value.id, `${field}.id`, 64);
  if (!isContinuityCategory(value.category)) throw new TypeError(`${field}.category is not supported`);
  const entryValue = requiredString(value.value, `${field}.value`, MAX_HUMAN_SAFETY_CONTINUITY_VALUE_CHARS);
  const createdAt = validateTimestamp(value.createdAt, `${field}.createdAt`);
  const updatedAt = validateTimestamp(value.updatedAt, `${field}.updatedAt`);
  return Object.freeze({ id, category: value.category, value: entryValue, createdAt, updatedAt });
}

function validateStore(value: unknown, field: string): Readonly<HumanSafetyContinuityStore> {
  if (!isUnknownRecord(value)) throw new TypeError(`${field} must be an object`);
  rejectUnknown(value, STORE_FIELDS, field);
  if (value.schemaVersion !== HUMAN_SAFETY_CONTINUITY_SCHEMA_VERSION) {
    throw new TypeError(`${field}.schemaVersion must be ${HUMAN_SAFETY_CONTINUITY_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.entries) || value.entries.length > MAX_HUMAN_SAFETY_CONTINUITY_ENTRIES) {
    throw new TypeError(`${field}.entries must contain at most ${MAX_HUMAN_SAFETY_CONTINUITY_ENTRIES} items`);
  }
  const entries = value.entries.map((entry, index) => validateEntry(entry, `${field}.entries[${index}]`));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new TypeError(`${field}.entries contains duplicate id ${entry.id}`);
    ids.add(entry.id);
  }
  return Object.freeze({ schemaVersion: HUMAN_SAFETY_CONTINUITY_SCHEMA_VERSION, entries: Object.freeze(entries) });
}

function emptyStore(): Readonly<HumanSafetyContinuityStore> {
  return Object.freeze({ schemaVersion: HUMAN_SAFETY_CONTINUITY_SCHEMA_VERSION, entries: Object.freeze([]) });
}

function assertNoSymlink(path: string, label: string): void {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
}

function assertSafeStorePath(storePath: string): readonly DirectoryIdentity[] {
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

function assertDirectoryIdentities(identities: readonly DirectoryIdentity[]): void {
  for (const identity of identities) {
    const stat = lstatSync(identity.path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw new Error(`Odai human-safety continuity directory identity changed during an operation: ${identity.path}`);
    }
  }
}

function readRegularFileNoFollow(path: string): string {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(path, constants.O_RDONLY | noFollow);
    const stat = fstatSync(fileDescriptor);
    if (!stat.isFile()) throw new Error(`Odai human-safety continuity store is not a regular file: ${path}`);
    return readFileSync(fileDescriptor, "utf8");
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

export function resolveHumanSafetyContinuityStorePath(
  configuredPath: unknown = undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
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

export function readHumanSafetyContinuityStore(storePath: string): Readonly<HumanSafetyContinuityStore> {
  const identities = assertSafeStorePath(storePath);
  let text: string;
  try {
    text = readRegularFileNoFollow(storePath);
  } catch (error) {
    assertDirectoryIdentities(identities);
    if (errorCode(error) === "ENOENT") return emptyStore();
    throw new Error(`cannot read Odai human-safety continuity ${storePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  assertDirectoryIdentities(identities);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
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

function writeStore(storePath: string, store: MutableHumanSafetyContinuityStore): Readonly<HumanSafetyContinuityStore> {
  const value = validateStore(store, "Odai human-safety continuity write");
  const parent = dirname(storePath);
  assertSafeStorePath(storePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const identities = assertSafeStorePath(storePath);
  const temporary = `${storePath}.tmp-${process.pid}-${randomUUID()}`;
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  try {
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      writeFileSync(fileDescriptor, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
      fsyncSync(fileDescriptor);
    } finally {
      if (fileDescriptor !== undefined) closeSync(fileDescriptor);
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

export function mutateHumanSafetyContinuityStore<TOutcome extends ContinuityMutationOutcome>(
  storePath: string,
  mutate: (store: MutableHumanSafetyContinuityStore) => TOutcome,
): Readonly<TOutcome & { store: Readonly<HumanSafetyContinuityStore> }> {
  if (typeof mutate !== "function") throw new TypeError("human-safety continuity mutator must be a function");
  const identities = assertSafeStorePath(storePath);
  const releaseLock = acquireOwnedStoreLock(storePath, "Odai human-safety continuity");
  try {
    assertDirectoryIdentities(identities);
    const current = readHumanSafetyContinuityStore(storePath);
    const mutable: MutableHumanSafetyContinuityStore = {
      schemaVersion: HUMAN_SAFETY_CONTINUITY_SCHEMA_VERSION,
      entries: current.entries.map((entry) => ({ ...entry })),
    };
    const outcome = mutate(mutable);
    if (!outcome || outcome.changed !== true) {
      return Object.freeze({ store: current, ...outcome }) as Readonly<TOutcome & { store: Readonly<HumanSafetyContinuityStore> }>;
    }
    const store = writeStore(storePath, mutable);
    return Object.freeze({ ...outcome, changed: true, store }) as Readonly<TOutcome & { store: Readonly<HumanSafetyContinuityStore> }>;
  } finally {
    releaseLock();
  }
}

export function clearHumanSafetyContinuityStore(
  storePath: string,
): Readonly<{ changed: boolean; store: Readonly<HumanSafetyContinuityStore> }> {
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
