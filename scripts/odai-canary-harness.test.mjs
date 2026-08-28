import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

test("strict suites persist an explicit 4-of-4 pass threshold", async () => {
  const out = await mkdtemp(join(tmpdir(), "odai-pass-score-"));
  try {
    await execFileAsync(process.execPath, [
      harness,
      "--plan", plan,
      "--cases", "1",
      "--pass-score", "4",
      "--out", out,
    ], { cwd: repoRoot });
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    assert.equal(manifest.pass_score, 4);
    assert.equal(report.pass_score, 4);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
