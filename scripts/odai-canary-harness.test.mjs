import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harness = resolve(repoRoot, "scripts", "odai-canary-harness.mjs");
const plan = resolve(repoRoot, "plans", "odai-ab-smoke.md");

test("isolated canary rejects a reasoning effort that cannot actually inherit", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      harness,
      "--plan", plan,
      "--cases", "1",
      "--judge-reasoning-effort", "inherit",
    ], { cwd: repoRoot }),
    /reasoning effort inherit is unsupported because isolated Codex calls ignore user config/u,
  );
});
