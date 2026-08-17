import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  MEMORY_PROMPT,
  captureAutomaticMemories,
  containsSensitiveMemory,
  createSemanticMemoryTool,
  discoverAutomaticMemoryCandidates,
  latestDirectUserMessage,
  renderSemanticMemoryPacket,
  retrieveSemanticMemories,
} from "../src/semantic-memory.mjs";
import {
  MemoryStoreValidationError,
  effectiveMemorySettings,
  readMemoryStore,
  resolveMemoryStorePath,
} from "../src/semantic-memory-store.mjs";

function symlinkOrSkip(t, target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`symbolic links are unavailable in this environment (${error.code})`);
      return false;
    }
    throw error;
  }
}

function directMessage(id, text) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function agentFor({ id, cwd, turn = 1, text, messageId = `${id}-message` }) {
  const message = directMessage(messageId, text);
  const events = [
    { type: "turn/start", seq: 1, data: { turn } },
    { type: "user/message", seq: 2, data: message },
  ];
  return {
    agent: { session: { header: { id, cwd }, events } },
    message,
    turn,
  };
}

function capture(storePath, fixture) {
  return captureAutomaticMemories({
    storePath,
    mode: "auto",
    agent: fixture.agent,
    message: fixture.message,
    turn: fixture.turn,
    cwd: fixture.agent.session.header.cwd,
  });
}

test("automatic discovery admits durable direct statements and rejects unsafe lookalikes", () => {
  const positives = [
    "这个项目以后统一使用 pnpm。",
    "所有项目今后默认使用 UTC 保存时间。",
    "本项目以后不要记录调试日志。",
    "We decided that this project always uses the full test suite.",
  ];
  for (const value of positives) {
    assert.equal(discoverAutomaticMemoryCandidates(value).length, 1, value);
  }

  const negatives = [
    "这个项目以后统一使用 pnpm 吗？",
    "例如：这个项目以后统一使用 pnpm。",
    "```text\n这个项目以后统一使用 pnpm。\n```",
    "我猜以后可能默认使用 pnpm。",
    "这次先用 pnpm。",
    "把按钮改成红色。",
    "不要记住这个项目以后统一使用 pnpm。",
    "他说这个项目以后统一使用 pnpm。",
    "这个项目以后默认使用 api_key=supersecret123456。",
    "我以后默认使用 me@example.com 联系。",
    "我的病历以后统一放在项目目录。",
    "以后我心累时，你默认先听我说。",
    "Going forward, remember that I feel depressed and want very short replies.",
  ];
  for (const value of negatives) {
    assert.deepEqual(discoverAutomaticMemoryCandidates(value), [], value);
  }
  assert.equal(containsSensitiveMemory("password=hunter2-secret"), true);
  assert.equal(containsSensitiveMemory("以后我心累时先听我说"), true);
  assert.equal(containsSensitiveMemory("I feel suicidal"), true);
  assert.equal(containsSensitiveMemory("以后默认先倾听、回复简短、不要说教"), false);
  assert.match(MEMORY_PROMPT, /no hidden provider, model, embedding, subagent, or compaction call/u);
  assert.match(MEMORY_PROMPT, /current direct human message.*always take precedence/iu);
});

test("only the authenticated direct-human message in the current open turn is eligible", () => {
  const human = directMessage("human", "这个项目以后统一使用 pnpm。");
  const stale = directMessage("stale", "所有项目以后统一使用 leaked。");
  const valid = {
    session: {
      events: [
        { type: "turn/start", seq: 10, data: { turn: 3 } },
        { type: "user/message", seq: 11, data: human },
      ],
    },
  };
  assert.equal(latestDirectUserMessage(valid), human);
  assert.equal(latestDirectUserMessage(valid, [human], { turn: 3 }), human);
  assert.equal(latestDirectUserMessage(valid, [stale], { turn: 3 }), undefined);
  assert.equal(latestDirectUserMessage(valid, [human], { turn: 2 }), undefined);
  assert.equal(latestDirectUserMessage({
    session: { events: [{ type: "turn/start", seq: 10, data: { turn: 3 } }, { type: "user/message", seq: 10, data: human }] },
  }), undefined);
  assert.equal(latestDirectUserMessage({ session: { events: [{ type: "user/message", seq: 11, data: human }] } }), undefined);
  assert.equal(latestDirectUserMessage({
    session: { events: [...valid.session.events, { type: "turn/end", seq: 12, data: { turn: 3 } }] },
  }), undefined);
  assert.equal(latestDirectUserMessage({
    session: { events: [...valid.session.events, { type: "turn/start", seq: 12, data: { turn: 4 } }] },
  }), undefined);
  const malformed = { id: "", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "bad" }] };
  assert.equal(latestDirectUserMessage({
    session: { events: [...valid.session.events, { type: "user/message", seq: 12, data: malformed }] },
  }), undefined);
  const plugin = { ...stale, source: { kind: "plugin" } };
  assert.equal(latestDirectUserMessage({
    session: { events: [...valid.session.events, { type: "user/message", seq: 12, data: plugin }] },
  }), undefined);
});

test("memory store is strict, local, atomic, and rejects symlink substitution", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-memory-store-"));
  try {
    const storePath = resolveMemoryStorePath(undefined, { DSH_HOME: root });
    assert.equal(storePath, resolve(root, "odai", "memory", "store.json"));
    assert.deepEqual(readMemoryStore(storePath).entries, []);
    assert.deepEqual(effectiveMemorySettings(storePath, { mode: "auto" }), {
      mode: "auto",
      source: "deployment-default",
    });

    mkdirSync(resolve(root, "odai", "memory"), { recursive: true });
    writeFileSync(storePath, `${JSON.stringify({ schemaVersion: 1, settings: {}, entries: [], unknown: true })}\n`);
    assert.throws(() => readMemoryStore(storePath), MemoryStoreValidationError);
    writeFileSync(storePath, "{broken\n");
    assert.throws(() => readMemoryStore(storePath), /not valid JSON/u);
    rmSync(storePath);

    const target = resolve(root, "target.json");
    writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, settings: {}, entries: [] })}\n`);
    if (!symlinkOrSkip(t, target, storePath)) return;
    assert.throws(() => readMemoryStore(storePath), /must not be a symbolic link/u);
    rmSync(storePath);
    rmSync(resolve(root, "odai", "memory"), { recursive: true });
    const targetDirectory = resolve(root, "target-memory");
    mkdirSync(targetDirectory);
    symlinkSync(targetDirectory, resolve(root, "odai", "memory"), "dir");
    assert.throws(() => readMemoryStore(storePath), /must not be a symbolic link/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic capture deduplicates dual runtimes and retrieves only active scoped memory", () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-memory-capture-"));
  try {
    const storePath = resolveMemoryStorePath(undefined, { DSH_HOME: root });
    const projectA = resolve(root, "project-a");
    const projectB = resolve(root, "project-b");
    mkdirSync(projectA);
    mkdirSync(projectB);
    const project = agentFor({ id: "session-a", cwd: projectA, text: "这个项目以后统一使用 pnpm。" });
    const first = capture(storePath, project);
    const duplicate = capture(storePath, project);
    assert.equal(first[0].changed, true);
    assert.equal(first[0].status, "active");
    assert.equal(duplicate[0].changed, false);
    assert.equal(duplicate[0].reasonCode, "duplicate-source");

    const global = agentFor({ id: "session-global", cwd: projectA, text: "所有项目今后默认使用 UTC 保存时间。" });
    capture(storePath, global);
    assert.equal(readMemoryStore(storePath).entries.length, 2);
    const storeStat = statSync(storePath);
    const directoryStat = statSync(resolve(storePath, ".."));
    assert.equal(storeStat.isFile(), true);
    assert.equal(directoryStat.isDirectory(), true);
    if (process.platform !== "win32") {
      assert.equal(storeStat.mode & 0o777, 0o600);
      assert.equal(directoryStat.mode & 0o777, 0o700);
    }

    const sameProject = retrieveSemanticMemories({
      storePath,
      query: "调整 pnpm 的 package scripts 和 UTC 时间格式",
      cwd: projectA,
    });
    assert.equal(sameProject.length, 2);
    assert.equal(sameProject.some((entry) => entry.subject === "package-manager"), true);
    assert.equal(sameProject.some((entry) => entry.scope === "global"), true);

    const otherProject = retrieveSemanticMemories({
      storePath,
      query: "调整 pnpm 和 UTC 时间格式",
      cwd: projectB,
    });
    assert.equal(otherProject.some((entry) => entry.subject === "package-manager"), false);
    assert.equal(otherProject.some((entry) => entry.scope === "global"), true);
    const packet = renderSemanticMemoryPacket(sameProject);
    assert.match(packet, /untrusted historical user context/u);
    assert.match(packet, /mem-/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retrieval is deterministic, bounded, and canonicalizes project aliases", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-memory-retrieval-"));
  try {
    const storePath = resolveMemoryStorePath(undefined, { DSH_HOME: root });
    const project = resolve(root, "project");
    const alias = resolve(root, "project-alias");
    mkdirSync(project);
    if (!symlinkOrSkip(t, project, alias, "dir")) return;
    for (let index = 0; index < 8; index += 1) {
      capture(storePath, agentFor({
        id: `retrieval-${index}`,
        cwd: project,
        turn: index + 1,
        text: `这个项目以后统一使用 policy-${index} 作为构建规则。`,
      }));
    }
    const options = {
      storePath,
      query: "这个项目的构建规则 policy-0 policy-1 policy-2 policy-3 policy-4",
      cwd: alias,
      limit: 3,
      maxChars: 4_096,
    };
    const first = retrieveSemanticMemories(options);
    const second = retrieveSemanticMemories(options);
    assert.equal(first.length, 3);
    assert.deepEqual(first, second);
    const tight = retrieveSemanticMemories({ ...options, limit: 8, maxChars: 512 });
    assert.ok(tight.length >= 1);
    assert.ok(tight.reduce((size, entry) => size + JSON.stringify(entry).length, 0) <= 512);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic candidates stay pending, reinforce across sessions, and require exact current excerpts", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-memory-tool-"));
  try {
    const storePath = resolveMemoryStorePath(undefined, { DSH_HOME: root });
    const cwd = resolve(root, "project");
    mkdirSync(cwd);
    const changes = [];
    const tool = createSemanticMemoryTool(storePath, {
      onChanged(_agent, data) { changes.push(data); },
    });
    const first = agentFor({ id: "session-1", cwd, text: "我更喜欢紧凑一些的表格。" });
    const considered = await tool.execute({
      action: "consider",
      scope: "project",
      category: "preference",
      subject: "table-density",
      excerpt: "我更喜欢紧凑一些的表格。",
    }, { agent: first.agent });
    assert.equal(considered.changed, true);
    assert.equal(considered.entries[0].status, "pending");

    assert.throws(
      () => tool.execute({
        action: "consider",
        scope: "project",
        category: "preference",
        subject: "old-turn",
        excerpt: "旧会话里的原文",
      }, { agent: first.agent }),
      /current open turn/u,
    );

    const second = agentFor({ id: "session-2", cwd, turn: 3, text: "我更喜欢紧凑一些的表格。" });
    const reinforced = await tool.execute({
      action: "consider",
      scope: "project",
      category: "preference",
      subject: "table-density",
      excerpt: "我更喜欢紧凑一些的表格。",
    }, { agent: second.agent });
    assert.equal(reinforced.entries[0].status, "active");
    assert.equal(reinforced.entries[0].occurrences, 2);
    assert.equal(changes.length, 2);

    const sessionOnly = await tool.execute({
      action: "consider",
      scope: "session",
      category: "preference",
      subject: "temporary-view",
      excerpt: "我更喜欢紧凑一些的表格。",
    }, { agent: second.agent });
    assert.equal(sessionOnly.changed, false);
    assert.equal(sessionOnly.reasonCode, "session-history-sufficient");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflicting repeated candidates stay pending until explicit confirmation", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-memory-conflict-"));
  try {
    const storePath = resolveMemoryStorePath(undefined, { DSH_HOME: root });
    const cwd = resolve(root, "project");
    mkdirSync(cwd);
    capture(storePath, agentFor({ id: "conflict-original", cwd, text: "这个项目以后统一使用 pnpm。" }));
    const tool = createSemanticMemoryTool(storePath);
    let pendingId;
    for (const [index, sessionId] of ["conflict-new-1", "conflict-new-2"].entries()) {
      const fixture = agentFor({ id: sessionId, cwd, turn: index + 2, text: "这个项目以后统一使用 npm。" });
      const result = await tool.execute({
        action: "consider",
        scope: "project",
        category: "decision",
        subject: "package-manager",
        excerpt: "这个项目以后统一使用 npm。",
      }, { agent: fixture.agent });
      pendingId = result.entries[0].id;
      assert.equal(result.entries[0].status, "pending");
      assert.equal(result.entries[0].conflictsWith.length, 1);
    }
    assert.equal(readMemoryStore(storePath).entries.filter((entry) => entry.status === "active").length, 1);
    assert.equal(retrieveSemanticMemories({ storePath, query: "更新 npm package manager", cwd }).length, 0);

    const confirmation = agentFor({
      id: "conflict-confirm",
      cwd,
      turn: 4,
      text: `确认这条候选记忆 ${pendingId}`,
    });
    const confirmed = await tool.execute({ action: "confirm", id: pendingId }, { agent: confirmation.agent });
    assert.equal(confirmed.entries[0].status, "active");
    assert.equal(confirmed.entries[0].conflictsWith.length, 0);
    assert.equal(confirmed.entries[0].supersedes.length, 1);
    assert.equal(readMemoryStore(storePath).entries.filter((entry) => entry.status === "active").length, 1);
    const recalled = retrieveSemanticMemories({ storePath, query: "更新 npm package manager", cwd });
    assert.equal(recalled.length, 1);
    assert.match(recalled[0].value, /npm/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("correction supersedes conflicts while forget and clear physically erase content", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-memory-lifecycle-"));
  try {
    const storePath = resolveMemoryStorePath(undefined, { DSH_HOME: root });
    const cwd = resolve(root, "project");
    mkdirSync(cwd);
    const original = agentFor({ id: "session-original", cwd, text: "这个项目以后统一使用 pnpm。" });
    capture(storePath, original);
    const tool = createSemanticMemoryTool(storePath);

    const correction = agentFor({
      id: "session-correction",
      cwd,
      turn: 2,
      text: "更正这条记忆：这个项目以后统一使用 npm。",
    });
    const corrected = await tool.execute({
      action: "correct",
      scope: "project",
      category: "decision",
      subject: "package-manager",
      excerpt: "这个项目以后统一使用 npm。",
    }, { agent: correction.agent });
    assert.equal(corrected.changed, true);
    assert.equal(corrected.entries[0].status, "active");
    const afterCorrection = readMemoryStore(storePath).entries;
    assert.equal(afterCorrection.find((entry) => /pnpm/u.test(entry.value)).status, "superseded");
    const npmEntry = afterCorrection.find((entry) => /npm/u.test(entry.value) && !/pnpm/u.test(entry.value));
    assert.equal(npmEntry.supersedes.length, 1);

    const forgetting = agentFor({
      id: "session-forget",
      cwd,
      turn: 3,
      text: `删除这条记忆 ${npmEntry.id}`,
    });
    const forgotten = await tool.execute({ action: "forget", id: npmEntry.id }, { agent: forgetting.agent });
    assert.equal(forgotten.changed, true);
    assert.equal(readFileSync(storePath, "utf8").includes("统一使用 npm"), false);

    const preflight = agentFor({ id: "session-clear", cwd, turn: 4, text: "清空项目记忆" });
    const clearRequest = await tool.execute({ action: "clear", scope: "project" }, { agent: preflight.agent });
    assert.match(clearRequest.authorizationPhrase, /^CLEAR ODAI PROJECT MEMORY /u);
    const authorized = agentFor({
      id: "session-clear-authorized",
      cwd,
      turn: 5,
      text: clearRequest.authorizationPhrase,
    });
    const cleared = await tool.execute({ action: "clear", scope: "project" }, { agent: authorized.agent });
    assert.equal(cleared.changed, true);
    assert.equal(readMemoryStore(storePath).entries.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale or closed-turn human text cannot authorize any memory mutation", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-memory-stale-auth-"));
  try {
    const storePath = resolveMemoryStorePath(undefined, { DSH_HOME: root });
    const cwd = resolve(root, "project");
    mkdirSync(cwd);
    const original = agentFor({ id: "stale-original", cwd, text: "这个项目以后统一使用 pnpm。" });
    capture(storePath, original);
    const tool = createSemanticMemoryTool(storePath);
    const activeId = readMemoryStore(storePath).entries[0].id;
    const pendingFixture = agentFor({ id: "stale-pending", cwd, turn: 2, text: "请考虑把本项目的输出格式偏好记为 json" });
    const pending = await tool.execute({
      action: "consider",
      scope: "project",
      category: "preference",
      subject: "output-format",
      excerpt: "本项目的输出格式偏好记为 json",
    }, { agent: pendingFixture.agent });
    const pendingId = pending.entries[0].id;
    const staleAgent = {
      session: {
        header: { id: "stale-replay", cwd },
        events: [
          { type: "turn/start", seq: 1, data: { turn: 3 } },
          { type: "user/message", seq: 2, data: directMessage("stale-replay-message", "CLEAR ODAI GLOBAL MEMORY") },
          { type: "turn/end", seq: 3, data: { turn: 3 } },
        ],
      },
    };
    const before = readFileSync(storePath, "utf8");
    for (const args of [
      { action: "consider", scope: "project", category: "preference", subject: "x", excerpt: "CLEAR ODAI GLOBAL MEMORY" },
      { action: "correct", scope: "project", category: "decision", subject: "package-manager", excerpt: "CLEAR ODAI GLOBAL MEMORY" },
      { action: "confirm", id: pendingId },
      { action: "forget", id: activeId },
      { action: "clear", scope: "global" },
      { action: "set-mode", mode: "off", excerpt: "CLEAR ODAI GLOBAL MEMORY" },
    ]) {
      assert.throws(() => tool.execute(args, { agent: staleAgent }), /current open turn/u);
    }
    assert.equal(readFileSync(storePath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid memory is visible and only an exact global clear resets it", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-memory-invalid-"));
  try {
    const storePath = resolveMemoryStorePath(undefined, { DSH_HOME: root });
    const cwd = resolve(root, "project");
    mkdirSync(resolve(root, "odai", "memory"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(storePath, "{broken\n");
    const tool = createSemanticMemoryTool(storePath);
    const inspecting = agentFor({ id: "invalid-inspect", cwd, text: "查看记忆" });
    const shown = await tool.execute({ action: "inspect" }, { agent: inspecting.agent });
    assert.equal(shown.modeSource, "invalid-store");
    assert.equal(shown.reasonCode, "memory-store-invalid");

    const preflight = agentFor({ id: "invalid-clear", cwd, turn: 2, text: "清空全局记忆" });
    const requested = await tool.execute({ action: "clear", scope: "global" }, { agent: preflight.agent });
    assert.equal(requested.authorizationPhrase, "CLEAR ODAI GLOBAL MEMORY");
    const projectRequested = await tool.execute({ action: "clear", scope: "project" }, { agent: preflight.agent });
    const projectAuthorized = agentFor({ id: "invalid-project-clear", cwd, turn: 3, text: projectRequested.authorizationPhrase });
    assert.throws(
      () => tool.execute({ action: "clear", scope: "project" }, { agent: projectAuthorized.agent }),
      /invalid memory store can only be reset/u,
    );

    const authorized = agentFor({ id: "invalid-authorized", cwd, turn: 3, text: "CLEAR ODAI GLOBAL MEMORY" });
    const cleared = await tool.execute({ action: "clear", scope: "global" }, { agent: authorized.agent });
    assert.equal(cleared.changed, true);
    assert.equal(cleared.reasonCode, "invalid-store-cleared");
    assert.deepEqual(readMemoryStore(storePath).entries, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory mode is user-controlled and every child action is denied", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-memory-mode-"));
  try {
    const storePath = resolveMemoryStorePath(undefined, { DSH_HOME: root });
    const cwd = resolve(root, "project");
    mkdirSync(cwd);
    const tool = createSemanticMemoryTool(storePath);
    const disabling = agentFor({ id: "session-mode", cwd, text: "关闭语义记忆" });
    const disabled = await tool.execute({ action: "set-mode", mode: "off", excerpt: "关闭语义记忆" }, { agent: disabling.agent });
    assert.equal(disabled.changed, true);
    assert.equal(disabled.mode, "off");

    const candidate = agentFor({ id: "session-disabled-candidate", cwd, text: "这个项目以后统一使用 pnpm。" });
    assert.deepEqual(captureAutomaticMemories({
      storePath,
      mode: effectiveMemorySettings(storePath).mode,
      agent: candidate.agent,
      message: candidate.message,
      turn: 1,
      cwd,
    }), []);

    const enabling = agentFor({ id: "session-mode-enable", cwd, turn: 2, text: "开启语义记忆" });
    const enabled = await tool.execute({ action: "set-mode", mode: "auto", excerpt: "开启语义记忆" }, { agent: enabling.agent });
    assert.equal(enabled.mode, "auto");
    capture(storePath, candidate);
    const deploymentDisabledTool = createSemanticMemoryTool(storePath, { configuredMode: "off" });
    const deploymentDisabled = await deploymentDisabledTool.execute({ action: "inspect" }, { agent: enabling.agent });
    assert.equal(deploymentDisabled.mode, "off");
    assert.equal(deploymentDisabled.modeSource, "deployment-config");
    const storedBeforeDisabledActions = readFileSync(storePath, "utf8");
    const activeId = readMemoryStore(storePath).entries[0].id;
    for (const args of [
      { action: "consider", scope: "project", category: "decision", subject: "other", excerpt: "开启语义记忆" },
      { action: "correct", scope: "project", category: "decision", subject: "package-manager", excerpt: "开启语义记忆" },
      { action: "confirm", id: activeId },
      { action: "set-mode", mode: "auto", excerpt: "开启语义记忆" },
    ]) {
      const rejected = await deploymentDisabledTool.execute(args, { agent: enabling.agent });
      assert.equal(rejected.changed, false);
      assert.equal(rejected.reasonCode, "memory-disabled");
    }
    assert.equal(readFileSync(storePath, "utf8"), storedBeforeDisabledActions);

    const child = {
      session: {
        header: { id: "child", cwd, origin: "subagent", delegationDepth: 1 },
        events: [],
      },
    };
    for (const action of ["inspect", "search", "consider", "confirm", "correct", "forget", "clear", "set-mode"]) {
      assert.throws(() => tool.execute({ action }, { agent: child }), /child agents may not inspect or change/u);
    }
    assert.equal(existsSync(storePath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
