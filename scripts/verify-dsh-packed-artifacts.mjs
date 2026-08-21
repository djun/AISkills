#!/usr/bin/env node

import { gunzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [pluginTarballArg, agentTarballArg] = process.argv.slice(2);
if (!pluginTarballArg || !agentTarballArg) {
  throw new Error("usage: verify-dsh-packed-artifacts.mjs <plugin.tgz> <agent.tgz>");
}

const runtimeFiles = await relativeFiles(resolve(repoRoot, "dsh/runtime/build"));
const runtimeModules = runtimeFiles.filter((path) => path.endsWith(".mjs"));
const canonicalFiles = await relativeFiles(resolve(repoRoot, "skills/odai"));
if (!runtimeModules.includes("index.mjs")) throw new Error("compiled runtime is missing index.mjs");
if (!canonicalFiles.includes("SKILL.md") || !canonicalFiles.includes("manifest.json")) {
  throw new Error("canonical Odai source is incomplete");
}

const pluginEntries = await tarEntries(resolve(pluginTarballArg));
const agentEntries = await tarEntries(resolve(agentTarballArg));
verifyPackage("Plugin", pluginEntries, [
  "package/package.json",
  "package/build/bin/odai-dsh-plugin.mjs",
  ...runtimeModules.map((path) => `package/runtime/${path}`),
  ...canonicalFiles.map((path) => `package/skills/odai/${path}`),
]);
verifyPackage("Agent", agentEntries, [
  "package/package.json",
  "package/build/bin/odai-dsh-agent.mjs",
  "package/build/src/installer.mjs",
  "package/preset/odai/agent.cordis.yml",
  "package/preset/odai/preset.yml",
  ...runtimeModules.map((path) => `package/preset/odai/runtime/${path}`),
  ...canonicalFiles.map((path) => `package/preset/odai/skills/odai/${path}`),
]);

process.stdout.write(`${JSON.stringify({
  pluginEntries: pluginEntries.size,
  agentEntries: agentEntries.size,
  runtimeModules: runtimeModules.length,
  canonicalFiles: canonicalFiles.length,
  packedArtifactsVerified: true,
}, null, 2)}\n`);

function verifyPackage(label, entries, required) {
  const missing = required.filter((path) => !entries.has(path));
  if (missing.length > 0) {
    throw new Error(`${label} tarball is incomplete; missing: ${missing.join(", ")}`);
  }
  const sourceModules = [...entries].filter((path) => path.endsWith(".mts") && !path.endsWith(".d.mts"));
  if (sourceModules.length > 0) {
    throw new Error(`${label} tarball contains editable TypeScript sources: ${sourceModules.join(", ")}`);
  }
}

async function relativeFiles(root) {
  const files = [];
  const visit = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(resolve(directory, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  await visit(root);
  return files;
}

async function tarEntries(tarballPath) {
  const archive = gunzipSync(await readFile(tarballPath));
  const entries = new Set();
  let offset = 0;
  let extendedPath;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const type = String.fromCharCode(header[156] || 0);
    const sizeText = tarText(header.subarray(124, 136)).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid tar size in ${tarballPath}`);
    const payloadStart = offset + 512;
    const payload = archive.subarray(payloadStart, payloadStart + size);
    if (type === "x") {
      extendedPath = paxPath(payload.toString("utf8"));
    } else {
      const path = extendedPath ?? (prefix ? `${prefix}/${name}` : name);
      if (path) entries.add(path.replace(/\/$/u, ""));
      extendedPath = undefined;
    }
    offset = payloadStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function tarText(buffer) {
  const nul = buffer.indexOf(0);
  return buffer.subarray(0, nul < 0 ? buffer.length : nul).toString("utf8");
}

function paxPath(text) {
  let offset = 0;
  while (offset < text.length) {
    const separator = text.indexOf(" ", offset);
    if (separator < 0) break;
    const length = Number.parseInt(text.slice(offset, separator), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = text.slice(separator + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") return record.slice(equals + 1);
    offset += length;
  }
  return undefined;
}
