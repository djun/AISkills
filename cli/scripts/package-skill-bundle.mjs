#!/usr/bin/env node

process.argv.push("--skill-root", "skills");
await import("../../scripts/package-odai-artifact.mjs");
