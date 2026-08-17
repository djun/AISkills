#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = [
  readPackage("dsh/plugin/package.json", "odai-dsh-plugin"),
  readPackage("dsh/agent/package.json", "odai-dsh-agent"),
];
const versions = new Set(packages.map((entry) => entry.version));

if (versions.size !== 1) {
  throw new Error(`DSH package versions must match: ${packages.map((entry) => `${entry.name}@${entry.version}`).join(", ")}`);
}

process.stdout.write(`DSH package versions match: ${packages[0].version}\n`);

function readPackage(relativePath, expectedName) {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8"));
  if (packageJson.name !== expectedName) {
    throw new Error(`${relativePath} must declare package name ${expectedName}`);
  }
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(packageJson.version)) {
    throw new Error(`${relativePath} has an invalid version: ${packageJson.version || "(missing)"}`);
  }
  return { name: packageJson.name, version: packageJson.version };
}
