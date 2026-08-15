import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

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
      throw new Error(`short write while acquiring Odai configuration lock: ${lockPath}`);
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
  if (current === undefined) throw new Error(`Odai configuration lock disappeared before release: ${lockPath}`);
  if (current.value !== owner) throw new Error(`Odai configuration lock ownership changed before release: ${lockPath}`);
  rmSync(lockPath);
}

export function acquireOwnedStoreLock(path, label) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const claimPath = `${lockPath}.claim`;
  const owner = `${process.pid}:${randomUUID()}`;
  const claimOwner = `${process.pid}:${randomUUID()}`;
  let claimHandle;
  try {
    claimHandle = createLock(claimPath, claimOwner);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`${label} lock acquisition is already in progress; retry the tool call`);
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
        throw new Error(`${label} is being updated; retry the tool call`);
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
        } catch {}
        handle = undefined;
      }
      throw error;
    }
  }

  if (handle === undefined) throw new Error(`could not lock ${label}`);
  return () => releaseLock(handle, lockPath, owner);
}
