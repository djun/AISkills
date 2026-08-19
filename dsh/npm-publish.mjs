#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const REGISTRY = "https://registry.npmjs.org/";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const PLUGIN_DIR = resolve(SCRIPT_DIR, "plugin");
const AGENT_DIR = resolve(SCRIPT_DIR, "agent");
const IS_WINDOWS = process.platform === "win32";

function run(command, args, options = {}) {
  const capture = options.capture === true;
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: IS_WINDOWS && command === "npm",
    windowsHide: false,
  });
  if (result.error) {
    if (options.allowFailure) return result;
    throw new Error(`${options.label ?? command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = capture ? result.stderr?.trim() : "";
    throw new Error(`${options.label ?? command} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function git(args, options = {}) {
  return run("git", args, { ...options, label: options.label ?? `git ${args[0]}` });
}

function npm(args, options = {}) {
  return run("npm", args, { ...options, label: options.label ?? `npm ${args[0]}` });
}

function npmFailureText(result) {
  return [result.stderr, result.stdout]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n")
    .trim();
}

function npmWhoami() {
  const result = npm(["whoami", `--registry=${REGISTRY}`], { capture: true, allowFailure: true });
  if (result.status === 0) return result.stdout.trim();
  const detail = npmFailureText(result);
  if (/\b(?:ENEEDAUTH|E401)\b|need auth|not logged in/iu.test(detail)) return undefined;
  throw new Error(`npm whoami failed: ${detail || `exit ${result.status}`}`);
}

function npmViewField(spec, field, options = {}) {
  const result = npm(["view", spec, field, `--registry=${REGISTRY}`], { capture: true, allowFailure: true });
  if (result.status === 0) return Object.freeze({ kind: "found", value: result.stdout.trim() });
  const detail = npmFailureText(result);
  if (options.allowMissing === true
    && /\bE404\b|No match found for version|is not in this registry/iu.test(detail)) {
    return Object.freeze({ kind: "missing" });
  }
  throw new Error(`Registry query failed for ${spec} ${field}: ${detail || `exit ${result.status}`}`);
}

function parseSemver(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (!match) throw new Error(`Unsupported package version ${JSON.stringify(value)}.`);
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function packageMetadata(directory) {
  return JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
}

function cleanArtifacts() {
  npm(["--prefix", PLUGIN_DIR, "run", "clean:artifact"], { capture: true, allowFailure: true });
  npm(["--prefix", AGENT_DIR, "run", "clean:artifact"], { capture: true, allowFailure: true });
}

async function ask(question) {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

async function pause() {
  try {
    await ask("\nPress Enter to close this window...");
  } catch {}
}

function requireCleanPublishedCommit() {
  const status = git([
    "status",
    "--porcelain",
    "--",
    "CHANGELOG.md",
    "dsh",
    "skills/odai",
  ], { capture: true }).stdout.trim();
  if (status) throw new Error("Release-owned files are not clean. Commit and push them before publishing.");

  const branch = git(["branch", "--show-current"], { capture: true }).stdout.trim();
  if (branch !== "main") throw new Error(`The current branch is ${branch || "detached"}; expected main.`);

  git(["fetch", "--quiet", "origin", "main"], { label: "git fetch origin/main" });
  const head = git(["rev-parse", "HEAD"], { capture: true }).stdout.trim();
  const origin = git(["rev-parse", "origin/main"], { capture: true }).stdout.trim();
  if (head !== origin) throw new Error("Local HEAD does not match origin/main. Commit and push before publishing.");
  return head;
}

async function authenticatedNpmUser() {
  let user = npmWhoami();
  if (user) return user;

  console.log("No authenticated npm account was found. Starting npm login.\n");
  npm(["login", `--registry=${REGISTRY}`], { label: "npm login" });
  user = npmWhoami();
  if (!user) throw new Error("npm whoami could not verify the account after login.");
  return user;
}

function requirePackageOwner(name, user) {
  const owners = npm(["owner", "ls", name, `--registry=${REGISTRY}`], {
    capture: true,
    label: `npm owner ls ${name}`,
  }).stdout
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter(Boolean);
  if (!owners.includes(user)) throw new Error(`npm account ${user} is not an owner of ${name}.`);
}

function requireNonDowngrade(metadata) {
  const latest = npmViewField(metadata.name, "dist-tags.latest").value;
  if (compareSemver(metadata.version, latest) < 0) {
    throw new Error(`${metadata.name}@${metadata.version} is older than registry latest ${latest}.`);
  }
  return latest;
}

async function verifyPublishedPackage(name, version, expectedGitHead) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const versionState = npmViewField(`${name}@${version}`, "version", { allowMissing: true });
    if (versionState.kind === "found") {
      if (versionState.value !== version) {
        throw new Error(`Registry returned version ${versionState.value} for ${name}@${version}.`);
      }
      const publishedGitHead = npmViewField(`${name}@${version}`, "gitHead").value;
      if (publishedGitHead === expectedGitHead) return true;
      throw new Error(`${name}@${version} exists with gitHead ${publishedGitHead || "<missing>"}, expected ${expectedGitHead}.`);
    }
    if (attempt < 5) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
  }
  return false;
}

async function publishIfMissing(metadata, directory, gitHead) {
  const { name, version } = metadata;
  const versionState = npmViewField(`${name}@${version}`, "version", { allowMissing: true });
  if (versionState.kind === "found") {
    if (!await verifyPublishedPackage(name, version, gitHead)) {
      throw new Error(`Registry verification failed for existing ${name}@${version}.`);
    }
    console.log(`${name}@${version} is already published from this commit; skipping.`);
    return;
  }

  npm(["publish", "--access=public", `--registry=${REGISTRY}`], {
    cwd: directory,
    label: `publish ${name}@${version}`,
  });
  if (!await verifyPublishedPackage(name, version, gitHead)) {
    throw new Error(`Registry verification failed for ${name}@${version}.`);
  }
  console.log(`Verified ${name}@${version} on npm.`);
}

async function main() {
  const plugin = packageMetadata(PLUGIN_DIR);
  const agent = packageMetadata(AGENT_DIR);
  if (plugin.name !== "odai-dsh-plugin" || agent.name !== "odai-dsh-agent") {
    throw new Error("Unexpected DSH package names; refusing to publish.");
  }
  if (plugin.version !== agent.version) {
    throw new Error(`Plugin version ${plugin.version} does not match Agent version ${agent.version}.`);
  }

  const gitHead = requireCleanPublishedCommit();
  const npmUser = await authenticatedNpmUser();
  requirePackageOwner(plugin.name, npmUser);
  requirePackageOwner(agent.name, npmUser);
  const pluginLatest = requireNonDowngrade(plugin);
  const agentLatest = requireNonDowngrade(agent);
  const version = plugin.version;

  console.log(`\nRelease account: ${npmUser}`);
  console.log(`Registry: ${REGISTRY}`);
  console.log(`Version: ${version}`);
  console.log(`Current latest: ${plugin.name}@${pluginLatest}, ${agent.name}@${agentLatest}`);
  console.log("Packages: odai-dsh-plugin, odai-dsh-agent");
  console.log(`Commit: ${gitHead}\n`);

  const confirmation = await ask(`Type 'publish ${version}' to run all release gates and publish both packages: `);
  if (confirmation !== `publish ${version}`) throw new Error("Publication was not confirmed.");

  npm(["--prefix", PLUGIN_DIR, "test"], { label: "Plugin tests" });
  npm(["--prefix", AGENT_DIR, "test"], { label: "Agent tests" });
  npm(["--prefix", PLUGIN_DIR, "run", "pack:dry-run"], { label: "Plugin dry-run packaging" });
  npm(["--prefix", AGENT_DIR, "run", "pack:dry-run"], { label: "Agent dry-run packaging" });
  npm(["--prefix", PLUGIN_DIR, "run", "verify:dsh"], { label: "Plugin DSH verification" });
  npm(["--prefix", AGENT_DIR, "run", "verify:dsh"], { label: "Agent DSH verification" });

  await publishIfMissing(plugin, PLUGIN_DIR, gitHead);
  await publishIfMissing(agent, AGENT_DIR, gitHead);
  cleanArtifacts();
  console.log(`\nPublished and verified both Odai DSH packages at version ${version}.`);
}

try {
  await main();
} catch (error) {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  cleanArtifacts();
  process.exitCode = 1;
}

await pause();
