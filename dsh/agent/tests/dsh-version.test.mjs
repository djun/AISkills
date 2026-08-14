import assert from "node:assert/strict";
import test from "node:test";

import { readDshVersion, spawnDsh } from "../src/dsh-version.mjs";

test("DSH version probe uses a shell for Windows npm command shims", () => {
  const calls = [];
  const actual = readDshVersion({
    dsh: "dsh",
    platform: "win32",
    execute(command, args, options) {
      calls.push({ command, args, options });
      return "0.1.0-rc.6\r\n";
    },
  });

  assert.equal(actual, "0.1.0-rc.6");
  assert.deepEqual(calls, [{
    command: "dsh",
    args: ["-V"],
    options: { encoding: "utf8", shell: true },
  }]);
});

test("DSH version probe directly executes binaries outside Windows", () => {
  const calls = [];
  readDshVersion({
    dsh: "/usr/local/bin/dsh",
    platform: "linux",
    execute(command, args, options) {
      calls.push({ command, args, options });
      return "0.1.0-rc.6\n";
    },
  });

  assert.deepEqual(calls, [{
    command: "/usr/local/bin/dsh",
    args: ["-V"],
    options: { encoding: "utf8" },
  }]);
});

test("DSH process spawn uses a shell only on Windows", () => {
  const calls = [];
  const child = {};
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };

  assert.equal(spawnDsh("dsh", ["web"], { cwd: "workspace" }, {
    platform: "win32",
    execute,
  }), child);
  spawnDsh("dsh", ["web"], { cwd: "workspace" }, {
    platform: "linux",
    execute,
  });

  assert.deepEqual(calls, [
    { command: "dsh", args: ["web"], options: { cwd: "workspace", shell: true } },
    { command: "dsh", args: ["web"], options: { cwd: "workspace" } },
  ]);
});
