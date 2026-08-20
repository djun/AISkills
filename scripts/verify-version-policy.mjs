#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertRepositoryVersionPolicy } from "./version-policy.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = assertRepositoryVersionPolicy({ repoRoot });
process.stdout.write(`Repository version policy verified: ${result.versions.length} owned identifiers; forbidden digits ${result.forbiddenDigits.join(", ")}\n`);
