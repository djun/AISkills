import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const STORE_SCHEMA_VERSION = 1;
const GLOBAL_STATE_KEY = Symbol.for("odai.dsh.session-evidence.v2");

function sharedState() {
  if (!globalThis[GLOBAL_STATE_KEY]) {
    Object.defineProperty(globalThis, GLOBAL_STATE_KEY, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: { bySession: new WeakMap() },
    });
  }
  return globalThis[GLOBAL_STATE_KEY];
}

function isOdaiEvent(event) {
  return typeof event?.type === "string" && event.type.startsWith("odai/");
}

function sessionIdOf(agent) {
  const id = agent?.session?.header?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

function evidencePath(root, sessionId) {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return resolve(root, `${key}.jsonl`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function evidenceId(type, data) {
  let identity;
  if (Number.isSafeInteger(data?.turn) && Number.isSafeInteger(data?.step)) {
    identity = `${type}:${data.turn}:${data.step}`;
  } else if (typeof data?.callId === "string" && data.callId !== "") {
    identity = `${type}:${data.callId}`;
  } else {
    identity = `${type}:${stableJson(data)}`;
  }
  return createHash("sha256").update(identity).digest("hex");
}

function snapshotData(data, type) {
  let encoded;
  try {
    encoded = JSON.stringify(data);
  } catch (error) {
    throw new Error(`odai evidence ${type} is not JSON-serializable`, { cause: error });
  }
  if (encoded === undefined) throw new Error(`odai evidence ${type} is not JSON-serializable`);
  return JSON.parse(encoded);
}

function readCompleteLines(path, strict) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (strict && text !== "" && !text.endsWith("\n")) {
    throw new Error(`odai evidence log has an unterminated final record: ${path}`);
  }
  const completeLength = text.endsWith("\n") ? text.length : text.lastIndexOf("\n") + 1;
  if (completeLength <= 0) return [];
  return text.slice(0, completeLength).split("\n").filter(Boolean);
}

function readStoredState(root, sessionId, logger, strict = false) {
  const path = evidencePath(root, sessionId);
  const events = [];
  const ids = new Set();
  for (const [index, line] of readCompleteLines(path, strict).entries()) {
    try {
      const record = JSON.parse(line);
      if (record?.schemaVersion !== STORE_SCHEMA_VERSION
        || record.sessionId !== sessionId
        || !isOdaiEvent(record)
        || !Number.isSafeInteger(record.time)
        || record.time < 0
        || record.data === undefined) {
        throw new Error("invalid evidence record");
      }
      const id = typeof record.id === "string" && record.id !== ""
        ? record.id
        : evidenceId(record.type, record.data);
      if (ids.has(id)) continue;
      ids.add(id);
      events.push(Object.freeze({ id, type: record.type, time: record.time, data: record.data }));
    } catch (error) {
      if (strict) throw new Error(`invalid odai evidence at ${path}:${index + 1}`, { cause: error });
      logger.warn(`ignored invalid odai evidence at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { events, ids };
}

function mergeUnique(target, events) {
  for (const event of events) {
    const id = event.id ?? evidenceId(event.type, event.data);
    if (target.ids.has(id)) continue;
    target.ids.add(id);
    target.events.push(Object.freeze({ id, type: event.type, time: event.time, data: event.data }));
  }
}

function stateFor(agent, root, logger) {
  const session = agent?.session;
  const owner = session && typeof session === "object"
    ? session
    : agent && typeof agent === "object"
      ? agent
      : undefined;
  if (!owner) return { events: [], ids: new Set(), sessionId: undefined };

  const shared = sharedState();
  let roots = shared.bySession.get(owner);
  if (!roots) {
    roots = new Map();
    shared.bySession.set(owner, roots);
  }
  const existing = roots.get(root);
  if (existing) return existing;

  const sessionId = sessionIdOf(agent);
  const state = { events: [], ids: new Set(), sessionId };
  const legacy = Array.isArray(session?.events) ? session.events.filter(isOdaiEvent) : [];
  mergeUnique(state, legacy);
  if (sessionId) mergeUnique(state, readStoredState(root, sessionId, logger).events);
  roots.set(root, state);
  return state;
}

function readLockOwner(lockPath) {
  try {
    const value = readFileSync(lockPath, "utf8").trim();
    const separator = value.indexOf(":");
    const pid = Number(separator < 0 ? "" : value.slice(0, separator));
    return Number.isSafeInteger(pid) && pid > 0 && separator < value.length - 1
      ? { value, pid }
      : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function createLock(lockPath, owner) {
  const handle = openSync(lockPath, "wx", 0o600);
  try {
    const content = Buffer.from(`${owner}\n`, "utf8");
    if (writeSync(handle, content, 0, content.length) !== content.length) {
      throw new Error(`short write while acquiring odai evidence lock: ${lockPath}`);
    }
    fsyncSync(handle);
    return handle;
  } catch (error) {
    closeSync(handle);
    rmSync(lockPath, { force: true });
    throw error;
  }
}

function releaseLock(handle, lockPath, owner) {
  closeSync(handle);
  const current = readLockOwner(lockPath);
  if (current === undefined) throw new Error(`odai evidence lock disappeared before release: ${lockPath}`);
  if (current.value !== owner) throw new Error(`odai evidence lock ownership changed before release: ${lockPath}`);
  rmSync(lockPath);
}

function acquireLock(path) {
  const lockPath = `${path}.lock`;
  const claimPath = `${lockPath}.claim`;
  const owner = `${process.pid}:${randomUUID()}`;
  const claimOwner = `${process.pid}:${randomUUID()}`;
  let claimHandle;
  try {
    claimHandle = createLock(claimPath, claimOwner);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`odai evidence lock acquisition is already in progress: ${path}`);
    }
    throw error;
  }

  let handle;
  try {
    try {
      handle = createLock(lockPath, owner);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = readLockOwner(lockPath);
      if (current === undefined || processIsAlive(current.pid)) {
        throw new Error(`odai evidence is being updated by another runtime: ${path}`);
      }
      rmSync(lockPath);
      handle = createLock(lockPath, owner);
    }
  } finally {
    try {
      releaseLock(claimHandle, claimPath, claimOwner);
    } catch (error) {
      if (handle !== undefined) {
        try {
          releaseLock(handle, lockPath, owner);
        } catch {
          // Preserve the claim failure; lock cleanup already failed closed.
        }
        handle = undefined;
      }
      throw error;
    }
  }

  if (handle === undefined) throw new Error(`could not lock odai evidence: ${path}`);
  return () => releaseLock(handle, lockPath, owner);
}

function syncDirectory(path) {
  let handle;
  try {
    handle = openSync(path, "r");
    fsyncSync(handle);
  } catch {
    // Windows does not expose directory fsync; the evidence file itself was synced.
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function persistRecord(root, sessionId, record, logger) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = evidencePath(root, sessionId);
  const release = acquireLock(path);
  try {
    const stored = readStoredState(root, sessionId, logger, true);
    if (stored.ids.has(record.id)) return false;
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    const originalSize = existsSync(path) ? statSync(path).size : 0;
    const handle = openSync(path, "a", 0o600);
    try {
      let offset = 0;
      while (offset < encoded.length) {
        const written = writeSync(handle, encoded, offset, encoded.length - offset);
        if (written <= 0) throw new Error(`short write while persisting odai evidence: ${path}`);
        offset += written;
      }
      fsyncSync(handle);
    } catch (error) {
      ftruncateSync(handle, originalSize);
      fsyncSync(handle);
      throw error;
    } finally {
      closeSync(handle);
    }
    syncDirectory(root);
    return true;
  } finally {
    release();
  }
}

export function resolveSessionEvidenceRoot(routingConfigPath) {
  return resolve(dirname(routingConfigPath), "session-evidence");
}

export function readStoredSessionEvidence(root, sessionId, logger = { warn() {} }) {
  if (typeof sessionId !== "string" || sessionId === "") return [];
  return readStoredState(resolve(root), sessionId, logger).events;
}

export function createSessionEvidence(options) {
  const root = resolve(options.root);
  const logger = options.logger ?? { warn() {} };

  const events = (agent) => stateFor(agent, root, logger).events.slice();
  const has = (agent, type, predicate = () => true) => stateFor(agent, root, logger)
    .events
    .some((event) => event.type === type && predicate(event.data));
  const append = (agent, type, data) => {
    if (typeof type !== "string" || !type.startsWith("odai/")) {
      throw new TypeError("odai evidence type must start with odai/");
    }
    const state = stateFor(agent, root, logger);
    const snapshot = snapshotData(data, type);
    const id = evidenceId(type, snapshot);
    const event = Object.freeze({ id, type, time: Date.now(), data: snapshot });
    if (state.ids.has(id)) return state.events.find((candidate) => candidate.id === id);

    if (!state.sessionId) {
      state.ids.add(id);
      state.events.push(event);
      try {
        agent?.session?.append?.(type, event.data);
      } catch (error) {
        logger.warn(`failed to append transient ${type}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return event;
    }

    const record = {
      schemaVersion: STORE_SCHEMA_VERSION,
      id,
      sessionId: state.sessionId,
      type,
      time: event.time,
      data: event.data,
    };
    persistRecord(root, state.sessionId, record, logger);
    state.ids.add(id);
    state.events.push(event);
    return event;
  };

  return Object.freeze({ append, events, has, root });
}
