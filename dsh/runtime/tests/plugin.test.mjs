import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolve } from "node:path";

import {
  apply,
  inheritCompactionReasoning,
  resolveConfig,
  runRoutedRole,
} from "../src/index.mjs";
import {
  readStoredSessionEvidence,
  resolveSessionEvidenceRoot,
} from "../src/session-evidence.mjs";
import { readMemoryStore } from "../src/semantic-memory-store.mjs";

const skillPath = resolve(import.meta.dirname, "../../../skills/odai/SKILL.md");
const previousDshHome = process.env.DSH_HOME;
const testDshHome = mkdtempSync(resolve(tmpdir(), "odai-runtime-tests-"));
const researchProjectRoot = resolve(testDshHome, "research-project");
mkdirSync(resolve(researchProjectRoot, "config"), { recursive: true });
mkdirSync(resolve(researchProjectRoot, "logs"), { recursive: true });
writeFileSync(resolve(researchProjectRoot, "config/checkout.json"), ["", "", "", "retries=1", ""].join("\n"));
writeFileSync(resolve(researchProjectRoot, "logs/incidents.md"), [
  "", "", "", "", "", "", "", "", "", "", "", "duplicate after timeout", "",
].join("\n"));
process.env.DSH_HOME = testDshHome;
test.after(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  rmSync(testDshHome, { recursive: true, force: true });
});

function fakeContext(extra = {}) {
  const captured = { handlers: new Map(), handlerOptions: new Map(), sections: [], guards: [], tools: [], logs: [] };
  return {
    ...extra,
    captured,
    systemPrompt: {
      section(value) {
        captured.sections.push(value);
      },
    },
    tools: {
      register(value) {
        captured.tools.push(value);
      },
      guard(value) {
        captured.guards.push(value);
      },
    },
    on(event, handler, options) {
      captured.handlers.set(event, handler);
      captured.handlerOptions.set(event, options);
    },
    logger() {
      return {
        info(message) {
          captured.logs.push(message);
        },
        warn(message) {
          captured.logs.push(message);
        },
      };
    },
  };
}

function userMessage(text) {
  return {
    id: "user-1",
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function researchPacketText(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    question: "Which facts determine whether client retries are safe?",
    facts: [
      {
        claim: "The client already retries once.",
        excerpt: "retries=1",
        source: { path: "config/checkout.json", line: 4 },
        authority: "runtime configuration",
      },
      {
        claim: "Duplicate charges were observed after timeouts.",
        excerpt: "duplicate after timeout",
        source: { path: "logs/incidents.md", line: 12 },
        authority: "incident record",
      },
    ],
    conflicts: [],
    unknowns: ["Provider idempotency behavior is not documented."],
    stop: "Configured retry and duplicate-charge evidence is established; provider behavior remains unknown.",
    ...overrides,
  });
}

test("config is strict at governance boundaries", () => {
  assert.throws(() => resolveConfig({ routing: { mode: "magic" } }), /must be off, observe, auto, or execute/u);
  assert.throws(() => resolveConfig({ governance: { additionalDeniedTools: [""] } }), /non-empty strings/u);
  assert.throws(() => resolveConfig({ routing: { roles: { planner: { provider: "openai" } } } }), /planner\.model/u);
  assert.throws(() => resolveConfig({ routing: { roles: { critic: {} } } }), /unknown roles: critic/u);
  assert.throws(() => resolveConfig({ routing: { configPath: "" } }), /configPath must be a non-empty string/u);
  assert.throws(() => resolveConfig({ governance: { skillSource: "latest" } }), /skillSource must be bundled, auto, or user/u);
  assert.throws(() => resolveConfig({ governance: { skillConfigPath: "" } }), /skillConfigPath must be a non-empty string/u);
  assert.throws(() => resolveConfig({ governance: { evolutionRoot: "" } }), /evolutionRoot must be a non-empty string/u);
  assert.equal(
    resolveConfig({ governance: { skillConfigPath: resolve(testDshHome, "another/source.json") } }).governance.evolutionRoot,
    resolve(testDshHome, "odai/skill-evolution"),
  );
  assert.equal(
    resolveConfig({ governance: { evolutionRoot: resolve(testDshHome, "explicit-evolution") } }).governance.evolutionRoot,
    resolve(testDshHome, "explicit-evolution"),
  );
  assert.throws(() => resolveConfig({ output: { configPath: "" } }), /config\.output\.configPath must be a non-empty string/u);
  assert.throws(() => resolveConfig({ output: { concise: true } }), /config\.output has unknown fields: concise/u);
  assert.throws(() => resolveConfig({ compaction: { configPath: "" } }), /config\.compaction\.configPath must be a non-empty string/u);
  assert.throws(() => resolveConfig({ compaction: { cacheRetention: "forever" } }), /provider-default, short, long, or none/u);
  assert.throws(() => resolveConfig({ compaction: { maxTokens: 500 } }), /config\.compaction has unknown fields: maxTokens/u);
  assert.throws(() => resolveConfig({ memory: { mode: "magic" } }), /config\.memory\.mode must be auto or off/u);
  assert.throws(() => resolveConfig({ memory: { storePath: "" } }), /config\.memory\.storePath must be a non-empty string/u);
  assert.throws(() => resolveConfig({ memory: { maxRetrieved: 0 } }), /integer from 1 to 12/u);
  assert.throws(() => resolveConfig({ memory: { model: "forbidden" } }), /config\.memory has unknown fields: model/u);

  const defaults = resolveConfig();
  assert.equal(defaults.routing.mode, "auto");
  assert.equal(defaults.routing.roles.researcher, undefined);
  assert.equal(defaults.routing.roles.planner, undefined);
  assert.equal(defaults.routing.roles.executor, undefined);
  assert.equal(defaults.routing.roles.reviewer, undefined);
  assert.equal(defaults.routing.roles.frontend, undefined);
  assert.equal(defaults.routing.configPath, resolve(testDshHome, "odai/routing.json"));
  assert.equal(defaults.governance.skillSource, "bundled");
  assert.equal(defaults.governance.skillConfigPath, resolve(testDshHome, "odai/source.json"));
  assert.equal(defaults.governance.evolutionRoot, resolve(testDshHome, "odai/skill-evolution"));
  assert.equal(defaults.output.configPath, resolve(testDshHome, "odai/output.json"));
  assert.equal(defaults.compaction.configPath, resolve(testDshHome, "odai/compaction.json"));
  assert.equal(defaults.compaction.cacheRetention, "provider-default");
  assert.equal(defaults.memory.mode, "auto");
  assert.equal(defaults.memory.storePath, resolve(testDshHome, "odai/memory/store.json"));
  assert.equal(defaults.memory.maxRetrieved, 6);
  assert.equal(resolveConfig({ compaction: { cacheRetention: "provider-default" } }).compaction.cacheRetention, "provider-default");

  const config = resolveConfig({
    routing: {
      roles: {
        planner: {
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      },
    },
  });
  assert.deepEqual(config.routing.roles.planner, {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
});

test("compaction cache retention honors config over the deployment environment", () => {
  const previous = process.env.ODAI_COMPACTION_CACHE_RETENTION;
  try {
    process.env.ODAI_COMPACTION_CACHE_RETENTION = "short";
    assert.equal(resolveConfig().compaction.cacheRetention, "short");
    assert.equal(resolveConfig({ compaction: { cacheRetention: "none" } }).compaction.cacheRetention, "none");
    process.env.ODAI_COMPACTION_CACHE_RETENTION = "provider-default";
    assert.equal(resolveConfig().compaction.cacheRetention, "provider-default");
    process.env.ODAI_COMPACTION_CACHE_RETENTION = "invalid";
    assert.throws(() => resolveConfig(), /provider-default, short, long, or none/u);
  } finally {
    if (previous === undefined) delete process.env.ODAI_COMPACTION_CACHE_RETENTION;
    else process.env.ODAI_COMPACTION_CACHE_RETENTION = previous;
  }
});

test("compaction inherits routed reasoning and applies configured retention for the exact target", async () => {
  const sessions = {
    get(sessionId) {
      if (sessionId !== "session-cache") return undefined;
      return {
        requestHeader() {
          return {
            config: {
              provider: "openai",
              model: "user-selected-model",
              reasoningEffort: "xhigh",
            },
          };
        },
      };
    },
  };
  const eligible = {
    purpose: "compaction",
    sessionId: "session-cache",
    provider: "openai",
    model: "user-selected-model",
  };
  assert.equal(inheritCompactionReasoning(eligible, sessions), true);
  assert.equal(eligible.reasoningEffort, "xhigh");
  assert.equal(eligible.cacheRetention, undefined);

  const providerDefault = {
    purpose: "compaction",
    sessionId: "session-cache",
    provider: "openai",
    model: "user-selected-model",
  };
  assert.equal(inheritCompactionReasoning(providerDefault, sessions, "provider-default"), true);
  assert.equal(providerDefault.reasoningEffort, "xhigh");
  assert.equal(providerDefault.cacheRetention, undefined);

  const explicitRetention = {
    purpose: "compaction",
    sessionId: "session-cache",
    provider: "openai",
    model: "user-selected-model",
    cacheRetention: "short",
  };
  assert.equal(inheritCompactionReasoning(explicitRetention, sessions), true);
  assert.equal(explicitRetention.cacheRetention, "short");

  const preselectedReasoning = { ...eligible, reasoningEffort: "medium" };
  assert.equal(inheritCompactionReasoning(preselectedReasoning, sessions, "long"), true);
  assert.equal(preselectedReasoning.reasoningEffort, "medium");
  assert.equal(preselectedReasoning.cacheRetention, "long");

  for (const configuredRetention of ["provider-default", "short", "long", "none"]) {
    const preserved = { ...eligible, reasoningEffort: "medium", cacheRetention: "short" };
    assert.equal(inheritCompactionReasoning(preserved, sessions, configuredRetention), false);
    assert.equal(preserved.reasoningEffort, "medium");
    assert.equal(preserved.cacheRetention, "short");
  }

  const explicit = { ...eligible, reasoningEffort: "medium" };
  assert.equal(inheritCompactionReasoning(explicit, sessions), false);
  assert.equal(explicit.reasoningEffort, "medium");
  assert.equal(inheritCompactionReasoning({ ...eligible, model: "different-model", reasoningEffort: undefined }, sessions), false);
  assert.equal(inheritCompactionReasoning({ ...eligible, purpose: undefined, reasoningEffort: undefined }, sessions), false);
  assert.equal(inheritCompactionReasoning(Object.freeze({ ...eligible, reasoningEffort: undefined }), sessions), false);

  const outputConfigPath = resolve(testDshHome, "compaction-output-policy", "output.json");
  mkdirSync(resolve(testDshHome, "compaction-output-policy"), { recursive: true });
  writeFileSync(outputConfigPath, `${JSON.stringify({
    schemaVersion: 1,
    policy: { concise: true, maxTokens: 2_500 },
  })}\n`, "utf8");
  const ctx = fakeContext({ sessions });
  apply(ctx, { skillPath, routing: { mode: "off" }, output: { configPath: outputConfigPath } });
  const streamed = {
    purpose: "compaction",
    sessionId: "session-cache",
    provider: "openai",
    model: "user-selected-model",
  };
  assert.equal(await ctx.captured.handlers.get("llm/stream")(streamed, async () => "next"), "next");
  assert.equal(streamed.reasoningEffort, "xhigh");
  assert.equal(streamed.cacheRetention, undefined);
  assert.equal(streamed.maxTokens, undefined);

  const independentlyBudgetedCompaction = {
    ...streamed,
    reasoningEffort: undefined,
    maxTokens: 8_192,
  };
  assert.equal(
    await ctx.captured.handlers.get("llm/stream")(independentlyBudgetedCompaction, async () => "next"),
    "next",
  );
  assert.equal(independentlyBudgetedCompaction.reasoningEffort, "xhigh");
  assert.equal(independentlyBudgetedCompaction.cacheRetention, undefined);
  assert.equal(independentlyBudgetedCompaction.maxTokens, 8_192);

  const configuredCtx = fakeContext({ sessions });
  apply(configuredCtx, {
    skillPath,
    routing: { mode: "off" },
    compaction: { cacheRetention: "long" },
  });
  const preRouted = {
    purpose: "compaction",
    sessionId: "session-cache",
    provider: "openai",
    model: "user-selected-model",
    reasoningEffort: "medium",
  };
  assert.equal(await configuredCtx.captured.handlers.get("llm/stream")(preRouted, async () => "next"), "next");
  assert.equal(preRouted.reasoningEffort, "medium");
  assert.equal(preRouted.cacheRetention, "long");

  const configuredButIncoming = { ...preRouted, cacheRetention: "short" };
  assert.equal(
    await configuredCtx.captured.handlers.get("llm/stream")(configuredButIncoming, async () => "next"),
    "next",
  );
  assert.equal(configuredButIncoming.cacheRetention, "short");

  const independentlyBudgetedCheckpoint = {
    purpose: "checkpoint",
    sessionId: "session-cache",
    provider: "openai",
    model: "user-selected-model",
    maxTokens: 8_192,
  };
  assert.equal(
    await ctx.captured.handlers.get("llm/stream")(independentlyBudgetedCheckpoint, async () => "next"),
    "next",
  );
  assert.equal(independentlyBudgetedCheckpoint.reasoningEffort, undefined);
  assert.equal(independentlyBudgetedCheckpoint.cacheRetention, undefined);
  assert.equal(independentlyBudgetedCheckpoint.maxTokens, 8_192);
});

test("managed compaction target overrides only summaries and restores inheritance after removal", async () => {
  const configPath = resolve(testDshHome, "managed-compaction-target", "compaction.json");
  mkdirSync(resolve(testDshHome, "managed-compaction-target"), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    target: { provider: "openai", model: "gpt-5.6-luna" },
  })}\n`, "utf8");
  const sessions = {
    get(sessionId) {
      if (sessionId !== "managed-compaction") return undefined;
      return {
        requestHeader() {
          return { config: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "xhigh" } };
        },
      };
    },
  };
  const ctx = fakeContext({ sessions });
  apply(ctx, {
    skillPath,
    routing: { mode: "off" },
    compaction: { configPath },
  });
  const stream = ctx.captured.handlers.get("llm/stream");
  const summary = {
    purpose: "compaction",
    sessionId: "managed-compaction",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    maxTokens: 65_536,
    messages: [{ id: "stock", role: "user", content: [{ type: "text", text: "stock compaction instruction" }] }],
  };
  assert.equal(await stream(summary, async () => "next"), "next");
  assert.equal(summary.provider, "openai");
  assert.equal(summary.model, "gpt-5.6-luna");
  assert.equal(summary.reasoningEffort, undefined);
  assert.equal(summary.maxTokens, 65_536);
  assert.equal(summary.cacheRetention, undefined);
  assert.equal(summary.messages.length, 2);
  assert.deepEqual(summary.messages.at(-1).source, {
    kind: "plugin",
    plugin: "odai-dsh-runtime",
    form: "instructions",
  });
  assert.match(summary.messages.at(-1).content[0].text, /SUPERSEDED.*REJECTED/iu);

  const preTargetedSummary = {
    purpose: "compaction",
    sessionId: "managed-compaction",
    provider: "openai",
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
    messages: [{ id: "pre-targeted-stock", role: "user", content: [] }],
  };
  assert.equal(await stream(preTargetedSummary, async () => "next"), "next");
  assert.equal(preTargetedSummary.reasoningEffort, undefined);
  assert.equal(preTargetedSummary.messages.length, 2);
  assert.equal(preTargetedSummary.messages.at(-1).source.form, "instructions");
  assert.equal(await stream(preTargetedSummary, async () => "next"), "next");
  assert.equal(preTargetedSummary.messages.length, 2);

  const ordinary = { provider: "openai", model: "gpt-5.6-sol" };
  assert.equal(await stream(ordinary, async () => "next"), "next");
  assert.deepEqual(ordinary, { provider: "openai", model: "gpt-5.6-sol" });

  const tool = ctx.captured.tools.find((candidate) => candidate.name === "odai_compaction_config");
  const controller = { session: { header: {}, append() {} } };
  assert.deepEqual((await tool.execute({ action: "show" }, { agent: controller })).target, {
    provider: "openai",
    model: "gpt-5.6-luna",
  });
  await tool.execute({
    action: "set",
    provider: "openai",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  }, { agent: controller });
  const explicitlyReasoned = {
    purpose: "compaction",
    sessionId: "managed-compaction",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    messages: [{ id: "explicit-reasoning-stock", role: "user", content: [] }],
  };
  assert.equal(await stream(explicitlyReasoned, async () => "next"), "next");
  assert.equal(explicitlyReasoned.model, "gpt-5.6-luna");
  assert.equal(explicitlyReasoned.reasoningEffort, "high");
  assert.equal(explicitlyReasoned.messages.length, 2);
  assert.deepEqual((await tool.execute({ action: "show" }, { agent: controller })).target, {
    provider: "openai",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  });
  await tool.execute({ action: "remove" }, { agent: controller });

  const inherited = {
    purpose: "compaction",
    sessionId: "managed-compaction",
    provider: "openai",
    model: "gpt-5.6-sol",
    messages: [{ id: "inherit-stock", role: "user", content: [] }],
  };
  assert.equal(await stream(inherited, async () => "next"), "next");
  assert.equal(inherited.model, "gpt-5.6-sol");
  assert.equal(inherited.reasoningEffort, "xhigh");
  assert.equal(inherited.messages.length, 1);

  writeFileSync(configPath, "{broken\n", "utf8");
  const fallback = {
    purpose: "compaction",
    sessionId: "managed-compaction",
    provider: "openai",
    model: "gpt-5.6-sol",
    messages: [{ id: "fallback-stock", role: "user", content: [] }],
  };
  assert.equal(await stream(fallback, async () => "next"), "next");
  assert.equal(fallback.model, "gpt-5.6-sol");
  assert.equal(fallback.reasoningEffort, "xhigh");
  assert.equal(fallback.messages.length, 1);
  assert.equal(ctx.captured.logs.some((message) => /compaction model configuration is invalid/iu.test(message)), true);
});

test("routing off ignores stale protection evidence while memory remains available", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "off" } });
  const agent = {
    session: {
      header: {},
      events: [
        { type: "odai/route-decided", data: { turn: 1, step: 1 } },
        { type: "odai/route-protection", data: { turn: 1, step: 1, mode: "read-only" } },
      ],
    },
  };

  assert.equal(ctx.captured.handlers.has("agent/pre-step"), true);
  const result = await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("普通请求")] }),
  );
  assert.equal(result.messages.length, 1);
  assert.equal(ctx.captured.guards[0]({ callId: "write-off", agent, name: "write" }), undefined);
});

test("semantic memory captures and retrieves across sessions without hidden model calls", async () => {
  const memoryStorePath = resolve(testDshHome, "memory-integration", "store.json");
  const routingConfigPath = resolve(testDshHome, "memory-integration", "routing.json");
  const projectRoot = resolve(testDshHome, "memory-integration", "project");
  mkdirSync(projectRoot, { recursive: true });
  let starts = 0;
  const ctx = fakeContext({
    subagents: {
      async start() {
        starts += 1;
        throw new Error("memory must not start a child");
      },
    },
  });
  apply(ctx, {
    skillPath,
    routing: { mode: "off", configPath: routingConfigPath },
    memory: { storePath: memoryStorePath },
  });
  const handler = ctx.captured.handlers.get("agent/pre-step");
  const firstMessage = userMessage("这个项目以后统一使用 pnpm。");
  const firstEvents = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: firstMessage },
  ];
  const firstAgent = {
    session: {
      header: { id: "memory-first", cwd: projectRoot },
      events: firstEvents,
      append(type, data) { firstEvents.push({ type, data }); },
    },
  };
  const first = await handler(
    { agent: firstAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [firstMessage] }),
  );
  assert.equal(first.messages.length, 1);
  assert.equal(readMemoryStore(memoryStorePath).entries[0].status, "active");

  const secondMessage = userMessage("请按照 pnpm 约束更新依赖脚本。");
  const secondEvents = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: secondMessage },
  ];
  const secondAgent = {
    session: {
      header: { id: "memory-second", cwd: projectRoot },
      events: secondEvents,
      append(type, data) { secondEvents.push({ type, data }); },
    },
  };
  const second = await handler(
    { agent: secondAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [secondMessage] }),
  );
  assert.equal(second.messages.length, 2);
  assert.equal(second.messages[1].source.form, "semantic-memory");
  assert.match(second.messages[1].content[0].text, /untrusted historical user context/u);
  assert.equal(starts, 0);
  const memoryTool = ctx.captured.tools.find((tool) => tool.name === "odai_memory");
  const inspected = await memoryTool.execute({ action: "inspect" }, { agent: secondAgent });
  assert.equal(inspected.entries.length, 1);
  assert.equal(inspected.entries[0].subject, "package-manager");

  const childMessage = userMessage("请按照 pnpm 约束更新依赖脚本。");
  const childAgent = {
    session: {
      header: { id: "memory-child", cwd: projectRoot, origin: "subagent", delegationDepth: 1 },
      events: [{ type: "user/message", seq: 1, data: childMessage }],
    },
  };
  const child = await handler(
    { agent: childAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [childMessage] }),
  );
  assert.equal(child.messages.length, 1);
});

test("invalid semantic memory fails closed without rewriting the store", async () => {
  const root = resolve(testDshHome, "memory-invalid-runtime");
  const memoryStorePath = resolve(root, "memory", "store.json");
  mkdirSync(resolve(memoryStorePath, ".."), { recursive: true });
  writeFileSync(memoryStorePath, "{broken\n", "utf8");
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: { mode: "off", configPath: resolve(root, "routing.json") },
    memory: { storePath: memoryStorePath },
  });
  const message = userMessage("这个项目以后统一使用 pnpm。");
  const events = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: message },
  ];
  const agent = {
    session: {
      header: { id: "memory-invalid-runtime", cwd: root },
      events,
      append(type, data) { events.push({ type, data }); },
    },
  };
  const result = await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [message] }),
  );
  assert.equal(result.messages.length, 1);
  assert.equal(readFileSync(memoryStorePath, "utf8"), "{broken\n");
  assert.equal(ctx.captured.logs.some((line) => /semantic memory is unavailable/u.test(line)), true);
  const tool = ctx.captured.tools.find((candidate) => candidate.name === "odai_memory");
  const shown = await tool.execute({ action: "inspect" }, { agent });
  assert.equal(shown.reasonCode, "memory-store-invalid");
});

test("profile and preset runtimes single-flight automatic memory capture", async () => {
  const memoryStorePath = resolve(testDshHome, "memory-dual-runtime", "store.json");
  const routingConfigPath = resolve(testDshHome, "memory-dual-runtime", "routing.json");
  const projectRoot = resolve(testDshHome, "memory-dual-runtime", "project");
  mkdirSync(projectRoot, { recursive: true });
  const globalCtx = fakeContext();
  const presetCtx = fakeContext();
  const config = {
    skillPath,
    routing: { mode: "off", configPath: routingConfigPath },
    memory: { storePath: memoryStorePath },
  };
  apply(globalCtx, config);
  apply(presetCtx, config);
  const message = userMessage("这个项目以后统一使用 pnpm。");
  const events = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: message },
  ];
  const agent = {
    session: {
      header: { id: "memory-dual", cwd: projectRoot },
      events,
      append(type, data) { events.push({ type, data }); },
    },
  };
  const input = { agent, turn: 1, step: 1, signal: new AbortController().signal };
  await globalCtx.captured.handlers.get("agent/pre-step")(input, async () => (
    presetCtx.captured.handlers.get("agent/pre-step")(input, async () => ({ kind: "enter", messages: [message] }))
  ));
  const store = readMemoryStore(memoryStorePath);
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].occurrences, 1);
});

test("default auto routing keeps ordinary tasks on the current controller", async () => {
  let starts = 0;
  const ctx = fakeContext({
    subagents: {
      async start() {
        starts += 1;
        throw new Error("ordinary task must not start a child");
      },
    },
  });
  apply(ctx, { skillPath });

  const events = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  const result = await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("请把 README 中“请独立规划一下架构选型”这句话改短")],
  }));

  assert.equal(starts, 0);
  assert.equal(result.messages.length, 1);
  assert.equal(events[0].data.role, "controller");
  assert.equal(events[0].data.mode, "auto");
  assert.equal(events[0].data.action, "direct");
});

test("real sessions persist routing evidence outside the DSH event log", async () => {
  const configPath = resolve(testDshHome, "real-session-evidence", "routing.json");
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { configPath } });
  let sessionAppends = 0;
  const agent = {
    session: {
      header: { id: "real-session-evidence" },
      events: [],
      append() { sessionAppends += 1; },
    },
  };
  await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("把普通按钮文案改得更清楚")],
  }));

  assert.equal(sessionAppends, 0);
  const events = readStoredSessionEvidence(resolveSessionEvidenceRoot(configPath), "real-session-evidence");
  assert.deepEqual(events.map((event) => event.type), ["odai/route-decided"]);
});

test("only explicit Odai responsibility labels route manual children", async () => {
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: {
      mode: "observe",
      configPath: resolve(testDshHome, "manual-child-routing", "routing.json"),
      roles: {
        planner: {
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      },
    },
  });

  const handler = ctx.captured.handlers.get("agent/request");
  const inherited = { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max" };
  const controller = { session: { events: [] } };
  assert.deepEqual(await handler({ agent: controller }, async () => inherited), inherited);

  let plannerHeader;
  const planner = {
    session: {
      events: [{ type: "subagent/descriptor", data: { label: "odai-planner architecture check" } }],
      requestHeader() { return plannerHeader; },
      append(type, data) { this.events.push({ type, data }); },
    },
  };
  const plannerRequest = await handler({ agent: planner, turn: 1, step: 1 }, async () => inherited);
  assert.deepEqual(plannerRequest, {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  plannerHeader = { config: plannerRequest };
  ctx.captured.handlers.get("session/event")(planner.session, {
    type: "assistant/chunk",
    data: { turn: 1, step: 1 },
  });
  const childReceipt = planner.session.events.find((event) => event.type === "odai/route-applied").data;
  assert.equal(childReceipt.status, "applied");
  assert.equal(childReceipt.routeMode, "child");
  assert.equal(childReceipt.routeSource, "deployment-config");
  assert.deepEqual(childReceipt.actualRoute, plannerRequest);
  await ctx.captured.handlers.get("agent/turn-stopping")({ agent: planner, turn: 1 });

  const mismatchedEvents = [{ type: "subagent/descriptor", data: { label: "odai-planner second opinion" } }];
  const mismatchedHeader = { config: inherited };
  const mismatchedPlanner = {
    session: {
      events: mismatchedEvents,
      requestHeader() { return mismatchedHeader; },
      append(type, data) { mismatchedEvents.push({ type, data }); },
    },
  };
  await handler({ agent: mismatchedPlanner, turn: 1, step: 1 }, async () => inherited);
  ctx.captured.handlers.get("session/event")(mismatchedPlanner.session, {
    type: "request/header",
    data: { header: mismatchedHeader },
  });
  assert.throws(
    () => ctx.captured.handlers.get("agent/turn-stopping")({ agent: mismatchedPlanner, turn: 1 }),
    /planner child route was not verified: child model mismatch/u,
  );

  const generic = {
    session: {
      events: [{ type: "subagent/descriptor", data: { label: "审查界面改版代码" } }],
    },
  };
  assert.deepEqual(await handler({ agent: generic }, async () => inherited), inherited);

  const missingReviewer = {
    session: {
      events: [{ type: "subagent/descriptor", data: { label: "odai-reviewer acceptance check" } }],
    },
  };
  await assert.rejects(
    handler({ agent: missingReviewer }, async () => inherited),
    /reviewer child route is not configured/u,
  );
});

test("effective routing mappings are merged, visible after compaction, and stable for one turn", async () => {
  const configPath = resolve(testDshHome, "effective-routing-snapshot", "routing.json");
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: {
      configPath,
      roles: {
        planner: { provider: "deployment", model: "planner-default", reasoningEffort: "high" },
        frontend: { provider: "deployment", model: "frontend-default", reasoningEffort: "max" },
      },
    },
  });
  const events = [];
  const agent = {
    phase: { turn: 1 },
    session: {
      header: {},
      events,
      append(type, data) { events.push({ type, data }); },
    },
  };
  const tool = ctx.captured.tools.find((candidate) => candidate.name === "odai_routing_config");
  await tool.execute({
    action: "set",
    responsibility: "planner",
    provider: "persisted",
    model: "planner-user",
    reasoningEffort: "xhigh",
  }, { agent });
  const assemble = ctx.captured.handlers.get("system-prompt/assemble");
  const context = { agent, signal: new AbortController().signal };
  const downstream = async () => ({ sections: ctx.captured.sections });
  const first = await assemble({}, context, downstream);
  const firstRouting = first.sections.find((section) => section.name === "odai:routing-configuration").text;
  assert.match(firstRouting, /planner=persisted\/planner-user \(reasoningEffort=xhigh\) \[persisted-mapping\]/u);
  assert.match(firstRouting, /frontend=deployment\/frontend-default \(reasoningEffort=max\) \[deployment-config\]/u);

  await tool.execute({
    action: "set",
    responsibility: "frontend",
    provider: "persisted",
    model: "frontend-user",
  }, { agent });
  const sameTurn = await assemble({}, context, downstream);
  assert.match(
    sameTurn.sections.find((section) => section.name === "odai:routing-configuration").text,
    /frontend=deployment\/frontend-default/u,
  );

  events.push({
    type: "compaction/summary",
    data: { text: "A stale summary mentions only the planner mapping." },
  });
  agent.phase.turn = 2;
  const afterCompaction = await assemble({}, context, downstream);
  const nextRouting = afterCompaction.sections.find((section) => section.name === "odai:routing-configuration").text;
  assert.match(nextRouting, /frontend=persisted\/frontend-user \[persisted-mapping\]/u);
  const shown = await tool.execute({ action: "show" }, { agent });
  assert.deepEqual(shown.sources, { planner: "persisted-mapping", frontend: "persisted-mapping" });
  const removed = await tool.execute({ action: "remove", responsibility: "planner" }, { agent });
  assert.deepEqual(removed.roles.planner, {
    provider: "deployment",
    model: "planner-default",
    reasoningEffort: "high",
  });
  assert.equal(removed.sources.planner, "deployment-config");
});

test("controller output policy is default-concise, turn-stable, request-bounded, and isolated from children", async () => {
  const configPath = resolve(testDshHome, "output-policy", "output.json");
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "off" }, output: { configPath } });

  const events = [];
  const agent = {
    phase: { turn: 1 },
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  const assemble = ctx.captured.handlers.get("system-prompt/assemble");
  const request = ctx.captured.handlers.get("agent/request");
  const outputTool = ctx.captured.tools.find((candidate) => candidate.name === "odai_output_config");
  const context = { agent, signal: new AbortController().signal };
  const downstream = async () => ({ sections: ctx.captured.sections });

  const initial = await assemble({}, context, downstream);
  assert.match(
    initial.sections.find((section) => section.name === "odai:controller-output-policy").text,
    /Keep the final user-facing response concise/u,
  );
  assert.deepEqual((await outputTool.execute({ action: "show" }, { agent })).policy, { concise: true });
  const normal = await outputTool.execute({ action: "set", mode: "normal" }, { agent });
  assert.deepEqual(normal.policy, { concise: false });
  assert.equal(normal.requiresNextTurn, true);
  assert.deepEqual(
    await request({ agent, turn: 1, step: 2 }, async () => ({ provider: "base", model: "controller" })),
    { provider: "base", model: "controller" },
  );

  agent.phase.turn = 2;
  const normalSelected = await assemble({}, context, downstream);
  assert.equal(
    normalSelected.sections.find((section) => section.name === "odai:controller-output-policy").text,
    "",
  );
  const configured = await outputTool.execute({
    action: "set",
    mode: "economy",
    maxTokens: 2_500,
  }, { agent });
  assert.deepEqual(configured.policy, { concise: true, maxTokens: 2_500 });
  assert.equal(configured.requiresNextTurn, true);
  assert.deepEqual(
    await request({ agent, turn: 2, step: 1 }, async () => ({ provider: "base", model: "controller" })),
    { provider: "base", model: "controller" },
  );

  agent.phase.turn = 3;
  const selected = await assemble({}, context, downstream);
  const policyText = selected.sections.find((section) => section.name === "odai:controller-output-policy").text;
  assert.match(policyText, /Keep the final user-facing response concise/u);
  assert.match(policyText, /provider output ceiling request of 2500 tokens/u);
  assert.match(policyText, /never reduces child-agent, compaction, checkpoint/u);
  assert.deepEqual(
    await request({ agent, turn: 3, step: 1 }, async () => ({ provider: "base", model: "controller", maxTokens: 8_000 })),
    { provider: "base", model: "controller", maxTokens: 2_500 },
  );
  assert.deepEqual(
    await request({ agent, turn: 3, step: 2 }, async () => ({ provider: "base", model: "controller", maxTokens: 1_000 })),
    { provider: "base", model: "controller", maxTokens: 1_000 },
  );
  assert.deepEqual(events.find((event) => event.type === "odai/output-budget-applied").data, {
    turn: 3,
    step: 1,
    configuredMaxTokens: 2_500,
    priorMaxTokens: 8_000,
    effectiveMaxTokens: 2_500,
    semantics: "provider-request-ceiling",
  });

  const child = {
    phase: { turn: 1 },
    session: { header: { origin: "subagent", delegationDepth: 1 }, events: [] },
  };
  const childResult = await request(
    { agent: child, turn: 1, step: 1 },
    async () => ({ provider: "child", model: "worker", maxTokens: 4_000 }),
  );
  assert.deepEqual(childResult, { provider: "child", model: "worker", maxTokens: 4_000 });
  assert.throws(
    () => outputTool.execute({ action: "set", concise: true }, { agent: child }),
    /child agents may not change/u,
  );

  const removed = await outputTool.execute({ action: "remove" }, { agent });
  assert.deepEqual(removed.policy, { concise: true });
  agent.phase.turn = 4;
  const reset = await assemble({}, context, downstream);
  assert.match(
    reset.sections.find((section) => section.name === "odai:controller-output-policy").text,
    /Keep the final user-facing response concise/u,
  );
  assert.deepEqual(
    await request({ agent, turn: 4, step: 1 }, async () => ({ provider: "base", model: "controller" })),
    { provider: "base", model: "controller" },
  );
});

test("host evolution bypass disables selection and mutations", async () => {
  const previous = process.env.ODAI_DISABLE_EVOLUTION;
  process.env.ODAI_DISABLE_EVOLUTION = "1";
  try {
    const ctx = fakeContext();
    apply(ctx, {
      governance: { evolutionRoot: resolve(testDshHome, "disabled-evolution") },
      routing: { mode: "off" },
    });
    const tool = ctx.captured.tools.find((candidate) => candidate.name === "odai_skill_evolution");
    const agent = { session: { header: {}, events: [] } };
    assert.equal((await tool.execute({ action: "show" }, { agent })).status, "disabled");
    assert.throws(
      () => tool.execute({ action: "validate", generationId: "0".repeat(64) }, { agent }),
      /disabled by ODAI_DISABLE_EVOLUTION/u,
    );
  } finally {
    if (previous === undefined) delete process.env.ODAI_DISABLE_EVOLUTION;
    else process.env.ODAI_DISABLE_EVOLUTION = previous;
  }
});

test("skill evolution activation preserves the current turn and changes the next prompt snapshot", async () => {
  const root = resolve(testDshHome, "evolution-integration", "skill-evolution");
  const ctx = fakeContext();
  apply(ctx, {
    governance: {
      skillConfigPath: resolve(testDshHome, "evolution-integration", "source.json"),
      evolutionRoot: root,
    },
    routing: { mode: "off", configPath: resolve(testDshHome, "evolution-integration", "routing.json") },
    output: { configPath: resolve(testDshHome, "evolution-integration", "output.json") },
    compaction: { configPath: resolve(testDshHome, "evolution-integration", "compaction.json") },
  });
  const events = [];
  const agent = {
    phase: { turn: 1 },
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, seq: events.length, time: 1_777_000_000_000 + events.length, data });
      },
    },
  };
  agent.session.append("turn/start", { turn: 1 });
  agent.session.append("user/message", userMessage("Prepare a bounded Odai evolution proposal"));
  const context = { agent, signal: new AbortController().signal };
  const downstream = async () => ({ sections: ctx.captured.sections });
  const assemble = ctx.captured.handlers.get("system-prompt/assemble");
  const tool = ctx.captured.tools.find((candidate) => candidate.name === "odai_skill_evolution");
  const initial = await assemble({}, context, downstream);
  const initialPrompt = initial.sections.find((section) => section.name === "odai:canonical-governance").text;
  assert.doesNotMatch(initialPrompt, /EVOLUTION_NEXT_TURN/u);
  const shown = await tool.execute({ action: "show" }, { agent });
  const inspected = await tool.execute({ action: "inspect", path: "SKILL.md" }, { agent });
  const oldString = "`odai` 是面向用户的统一入口和最终交付者，按真实缺口补判断、工艺、验证与外力。";
  const proposalArgs = {
    action: "propose",
    objective: "Prove next-turn evolution selection",
    expectedBundleDigest: shown.upstream.digest,
    changes: [{
      path: "SKILL.md",
      expectedSha256: inspected.sha256,
      replacements: [{ oldString, newString: `${oldString}\n\nEVOLUTION_NEXT_TURN` }],
    }],
  };
  const prepared = await tool.execute(proposalArgs, { agent });
  assert.equal(prepared.status, "authorization-required");
  agent.session.append("turn/end", { turn: 1, reason: "success" });
  agent.phase.turn = 2;
  agent.session.append("turn/start", { turn: 2 });
  agent.session.append("user/message", userMessage(prepared.proposalPhrase));
  const proposed = await tool.execute(proposalArgs, { agent });
  assert.equal(proposed.generation.authorizationLevel, "breaking");
  agent.session.append("turn/end", { turn: 2, reason: "success" });
  agent.phase.turn = 3;
  agent.session.append("turn/start", { turn: 3 });
  agent.session.append("user/message", userMessage(proposed.generation.activationPhrase));
  const activationTurn = await assemble({}, context, downstream);
  assert.doesNotMatch(
    activationTurn.sections.find((section) => section.name === "odai:canonical-governance").text,
    /EVOLUTION_NEXT_TURN/u,
  );
  await tool.execute({
    action: "activate",
    generationId: proposed.generation.generationId,
    expectedUpstreamDigest: shown.upstream.digest,
  }, { agent });

  const sameTurn = await assemble({}, context, downstream);
  assert.doesNotMatch(
    sameTurn.sections.find((section) => section.name === "odai:canonical-governance").text,
    /EVOLUTION_NEXT_TURN/u,
  );
  agent.session.append("turn/end", { turn: 3, reason: "success" });
  agent.phase.turn = 4;
  agent.session.append("turn/start", { turn: 4 });
  agent.session.append("user/message", userMessage("Continue after the authorized activation"));
  const nextTurn = await assemble({}, context, downstream);
  const evolvedPrompt = nextTurn.sections.find((section) => section.name === "odai:canonical-governance").text;
  assert.match(evolvedPrompt, /Canonical source: evolution/u);
  assert.match(evolvedPrompt, /User evolution: generation [a-f0-9]{64}/u);
  assert.match(evolvedPrompt, /rebase required: false/u);
  assert.match(evolvedPrompt, /EVOLUTION_NEXT_TURN/u);
});

test("plugin registers canonical prompt, monotonic guard, audit observer, and router", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "observe" } });

  assert.equal(ctx.captured.sections.length, 7);
  assert.match(ctx.captured.sections[0].text, /odai canonical governance/u);
  assert.match(ctx.captured.sections[0].text, /already loaded by this runtime; do not call the skill tool/u);
  assert.match(ctx.captured.sections[1].text, /naturally asks to inspect, set, change, or remove/u);
  assert.match(ctx.captured.sections[1].text, /Never infer, recommend as chosen, or silently select/u);
  assert.match(ctx.captured.sections[2].text, /frozen route cards/u);
  assert.match(ctx.captured.sections[2].text, /canonical executor reassessment proves observable net benefit/u);
  assert.doesNotMatch(ctx.captured.sections[2].text, /earlier direct-routing choice expires/u);
  assert.doesNotMatch(ctx.captured.sections[2].text, /task size alone never justifies delegation/u);
  assert.match(ctx.captured.sections[3].text, /explicitly asks to inspect, set, or reset that source/u);
  assert.equal(ctx.captured.sections[4].text, "");
  assert.match(ctx.captured.sections[5].text, /compaction model configuration/u);
  assert.match(ctx.captured.sections[5].text, /Never infer or silently choose/u);
  assert.match(ctx.captured.sections[5].text, /controller, researcher, planner, executor, reviewer, frontend/u);
  assert.match(ctx.captured.sections[6].text, /long-term semantic memory/u);
  assert.match(ctx.captured.sections[6].text, /no hidden provider, model, embedding, subagent, or compaction call/u);
  assert.equal(ctx.captured.tools[0].name, "odai_routing_config");
  assert.equal(ctx.captured.tools[1].name, "odai_route_card");
  assert.equal(ctx.captured.tools[2].name, "odai_skill_source_config");
  assert.equal(ctx.captured.tools[3].name, "odai_skill_evolution");
  assert.match(ctx.captured.tools[3].description, /current open turn's latest genuine user message/u);
  assert.equal("evidence" in ctx.captured.tools[3].parameters.properties, false);
  assert.equal(ctx.captured.sections.some((section) => section.name === "odai:skill-evolution"), false);
  assert.equal(ctx.captured.tools[4].name, "odai_output_config");
  assert.equal(ctx.captured.tools[5].name, "odai_compaction_config");
  assert.equal(ctx.captured.tools[6].name, "odai_memory");
  assert.match(ctx.captured.tools[6].description, /without requiring the user to say remember/u);
  assert.ok(ctx.captured.handlers.has("system-prompt/assemble"));
  assert.equal(ctx.captured.guards.length, 1);
  assert.ok(ctx.captured.handlers.has("tools/result"));
  assert.ok(ctx.captured.handlers.has("agent/pre-step"));
  assert.ok(ctx.captured.handlers.has("session/event"));
  assert.ok(ctx.captured.handlers.has("agent/turn-stopping"));

  const events = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  const signal = new AbortController().signal;
  const handler = ctx.captured.handlers.get("agent/pre-step");
  const result = await handler({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));

  assert.equal(result.kind, "enter");
  assert.equal(result.messages.length, 2);
  assert.match(result.messages[1].content[0].text, /role: controller/u);
  assert.match(result.messages[1].content[0].text, /target responsibility: planner/u);
  assert.match(result.messages[1].content[0].text, /concrete evidence-gathering steps and explicit decision criteria/u);
  assert.match(result.messages[1].content[0].text, /do not implement, persist, or publish/u);
  assert.deepEqual(events.slice(0, 4).map((event) => event.type), [
    "odai/research-decided",
    "odai/research-result",
    "odai/route-decided",
    "odai/route-protection",
  ]);
  assert.equal(events[1].data.stopReason, "observe-mode");
  assert.equal(events[2].data.role, "controller");
  assert.equal(events[2].data.action, "upgrade");
  assert.equal(events[2].data.targetRole, "planner");
  assert.equal(events[2].data.reasonCode, "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE");
  assert.equal(events[3].data.mode, "read-only");
  assert.equal(events[3].data.source, "observe");

  const guard = ctx.captured.guards[0];
  assert.match(guard({ callId: "write-1", agent, name: "write" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
  assert.equal(guard({ callId: "read-1", agent, name: "read" }), undefined);
  assert.equal(events.at(-1).type, "odai/governance-denied");

  await handler({ agent, turn: 2, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("把普通按钮文案改得更清楚")],
  }));
  assert.equal(guard({ callId: "write-2", agent, name: "write" }), undefined);
});

test("global and preset runtime instances deduplicate durable evidence and routing", async () => {
  const outputConfigPath = resolve(testDshHome, "coexistence-output-policy", "output.json");
  mkdirSync(resolve(testDshHome, "coexistence-output-policy"), { recursive: true });
  writeFileSync(outputConfigPath, `${JSON.stringify({
    schemaVersion: 1,
    policy: { concise: true, maxTokens: 2_500 },
  })}\n`, "utf8");
  const globalCtx = fakeContext();
  const presetCtx = fakeContext();
  const runtimeConfig = {
    skillPath,
    routing: { mode: "observe" },
    output: { configPath: outputConfigPath },
  };
  apply(globalCtx, runtimeConfig);
  apply(presetCtx, runtimeConfig);

  const events = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  const payload = { agent, turn: 1, step: 1, signal: new AbortController().signal };
  const base = async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  });
  const globalRoute = globalCtx.captured.handlers.get("agent/pre-step");
  const presetRoute = presetCtx.captured.handlers.get("agent/pre-step");
  const result = await globalRoute(payload, () => presetRoute(payload, base));

  assert.equal(events.filter((event) => event.type === "odai/route-decided").length, 1);
  assert.equal(events.filter((event) => event.type === "odai/route-protection").length, 1);
  assert.equal(result.messages.filter((message) => message.source?.plugin === "odai-dsh-runtime").length, 1);
  assert.match(globalCtx.captured.guards[0]({ callId: "global-write", name: "write", agent }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
  assert.match(presetCtx.captured.guards[0]({ callId: "preset-write", name: "write", agent }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);

  const execution = {
    callId: "shared-call",
    rootCallId: "shared-call",
    name: "read",
    agent,
  };
  globalCtx.captured.handlers.get("tools/result")(execution, { isError: false });
  presetCtx.captured.handlers.get("tools/result")(execution, { isError: false });
  assert.equal(events.filter((event) => event.type === "odai/tool-observed").length, 1);

  const globalRequest = globalCtx.captured.handlers.get("agent/request");
  const presetRequest = presetCtx.captured.handlers.get("agent/request");
  const capped = await globalRequest(payload, () => presetRequest(payload, async () => ({
    provider: "base",
    model: "controller",
    maxTokens: 8_000,
  })));
  assert.deepEqual(capped, { provider: "base", model: "controller", maxTokens: 2_500 });
  assert.equal(events.filter((event) => event.type === "odai/output-budget-applied").length, 1);
});

test("global and preset execute routing starts exactly one subagent", async () => {
  let starts = 0;
  let disposals = 0;
  const subagents = {
    async start() {
      starts += 1;
      return {
        result: Promise.resolve({
          stopReason: "completed",
          output: [{ type: "text", text: "one routed result" }],
        }),
        async dispose() {
          disposals += 1;
        },
      };
    },
  };
  const globalCtx = fakeContext({ subagents });
  const presetCtx = fakeContext({ subagents });
  const routing = {
    mode: "execute",
    roles: { planner: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" } },
  };
  apply(globalCtx, { skillPath, routing });
  apply(presetCtx, { skillPath, routing });

  const events = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  const payload = { agent, turn: 1, step: 1, signal: new AbortController().signal };
  const base = async () => ({
    kind: "enter",
    messages: [userMessage("请独立规划一下架构选型")],
  });
  const globalRoute = globalCtx.captured.handlers.get("agent/pre-step");
  const presetRoute = presetCtx.captured.handlers.get("agent/pre-step");
  const result = await globalRoute(payload, () => presetRoute(payload, base));

  assert.equal(starts, 1);
  assert.equal(disposals, 1);
  assert.equal(events.filter((event) => event.type === "odai/route-decided").length, 1);
  assert.equal(events.filter((event) => event.type === "odai/route-result").length, 1);
  assert.equal(result.messages.filter((message) => message.source?.plugin === "odai-dsh-runtime").length, 1);
});

test("execute routing disposes a successful provider run", async () => {
  let disposed = false;
  let request;
  const result = await runRoutedRole({
    subagents: {
      async start(_provider, value) {
        request = value;
        return {
          result: Promise.resolve({
            stopReason: "completed",
            output: [{ type: "text", text: "independent evidence" }],
          }),
          async dispose() {
            disposed = true;
          },
        };
      },
    },
    provider: "spawn",
    decision: { role: "planner" },
    taskText: "compare options",
    roleContract: "Canonical planner contract.",
    agent: {},
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.routeReceiptStatus, "unverified");
  assert.equal(disposed, true);
  assert.equal(request.maxDepth, 1);
  assert.match(request.prompt[0].text, /do not edit files/iu);
});

test("default auto reports an unconfigured planner only when the gap is needed", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath });

  const events = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  const preStep = ctx.captured.handlers.get("agent/pre-step");
  const signal = new AbortController().signal;
  const result = await preStep({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));

  assert.deepEqual(events.map((event) => event.type), [
    "odai/research-decided",
    "odai/research-result",
    "odai/route-decided",
    "odai/route-config-missing",
    "odai/route-protection",
  ]);
  assert.equal(events[1].data.stopReason, "route-config-missing");
  assert.equal(events[3].data.role, "planner");
  assert.equal(events[3].data.status, "unconfigured");
  assert.equal(events[4].data.source, "route-config-missing");
  assert.match(result.messages[1].content[0].text, /required responsibility: planner/u);
  assert.match(result.messages[1].content[0].text, /natural language/u);
  assert.match(result.messages[1].content[0].text, /odai_routing_config/u);
  assert.doesNotMatch(result.messages[1].content[0].text, /requested controller route|routing:\n/u);

  const inherited = { provider: "openai", model: "current-controller", reasoningEffort: "high" };
  assert.deepEqual(
    await ctx.captured.handlers.get("agent/request")({ agent, turn: 1 }, async () => inherited),
    inherited,
  );
  assert.match(ctx.captured.guards[0]({ callId: "missing-planner-write", agent, name: "write" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
});

test("an invalid user routing store keeps governance loaded and repairs through the tool", async () => {
  const configPath = resolve(testDshHome, "invalid-config", "routing.json");
  mkdirSync(resolve(testDshHome, "invalid-config"), { recursive: true });
  writeFileSync(configPath, "{not-json\n", "utf8");

  const ctx = fakeContext();
  assert.doesNotThrow(() => apply(ctx, { skillPath, routing: { configPath } }));
  assert.equal(ctx.captured.guards.length, 1);
  assert.equal(ctx.captured.tools[0].name, "odai_routing_config");

  const events = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  const result = await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));

  const missing = events.find((event) => event.type === "odai/route-config-missing");
  const protection = events.find((event) => event.type === "odai/route-protection");
  assert.equal(missing.data.status, "invalid");
  assert.match(missing.data.error, /cannot read odai routing config/u);
  assert.equal(protection.data.source, "route-config-invalid");
  assert.match(result.messages[1].content[0].text, /saved configuration is invalid/u);
  assert.match(result.messages[1].content[0].text, /repair and persist/u);
  assert.match(ctx.captured.guards[0]({ callId: "invalid-config-write", agent, name: "write" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);

  const tool = ctx.captured.tools[0];
  const repaired = await tool.execute({
    action: "set",
    responsibility: "planner",
    provider: "provider-a",
    model: "model-plan",
  }, { agent: { session: { header: {}, append() {} } } });
  assert.equal(repaired.recoveredInvalidStore, true);
  assert.deepEqual(repaired.roles.planner, { provider: "provider-a", model: "model-plan" });
  assert.equal(readdirSync(resolve(testDshHome, "invalid-config")).some(
    (entry) => entry.startsWith("routing.json.invalid-"),
  ), true);
  assert.deepEqual((await tool.execute({ action: "show" }, { agent: { session: { header: {} } } })).roles.planner, {
    provider: "provider-a",
    model: "model-plan",
  });

  writeFileSync(`${configPath}.lock`, "other-process\n", "utf8");
  assert.throws(() => tool.execute({
    action: "set",
    responsibility: "reviewer",
    provider: "provider-b",
    model: "model-review",
  }, { agent: { session: { header: {} } } }), /being updated; retry/u);
  rmSync(`${configPath}.lock`, { force: true });
});

test("execute mode loads without subagents and reports an unconfigured reviewer on demand", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "execute" } });
  const events = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  const result = await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("请独立审查这个架构方案")],
  }));

  assert.deepEqual(events.map((event) => event.type), ["odai/route-decided", "odai/route-config-missing"]);
  assert.equal(events[1].data.role, "reviewer");
  assert.equal(events.some((event) => event.type === "odai/route-protection"), false);
  assert.match(result.messages[1].content[0].text, /required responsibility: reviewer/u);
});

test("configured auto mode upgrades the current controller turn without a child", async () => {
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: {
      roles: {
        planner: {
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          maxTokens: 2_048,
        },
      },
    },
  });

  const events = [];
  let actualHeader;
  const agent = {
    session: {
      header: {},
      events,
      requestHeader() { return actualHeader; },
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  const preStep = ctx.captured.handlers.get("agent/pre-step");
  const request = ctx.captured.handlers.get("agent/request");
  assert.deepEqual(ctx.captured.handlerOptions.get("agent/request"), { prepend: true });
  const signal = new AbortController().signal;
  const result = await preStep({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));

  assert.match(result.messages[1].content[0].text, /action: upgrade/u);
  assert.match(result.messages[1].content[0].text, /no child was started/u);
  assert.match(result.messages[1].content[0].text, /requested controller route: openai\/gpt-5\.6-sol \(reasoning: high\)/u);
  assert.deepEqual(events.map((event) => event.type), [
    "odai/research-decided",
    "odai/research-result",
    "odai/route-decided",
    "odai/route-context",
    "odai/route-protection",
    "odai/route-upgrade",
  ]);
  assert.equal(events[1].data.stopReason, "route-config-missing");
  assert.equal(events[2].data.role, "controller");
  assert.equal(events[2].data.action, "upgrade");
  assert.equal(events[2].data.targetRole, "planner");
  assert.equal(events[3].data.mode, "same-turn");
  assert.match(events[3].data.digest, /^[a-f0-9]{64}$/u);
  assert.equal(events[4].data.source, "same-turn-planner");
  assert.equal(events[5].data.status, "requested");
  assert.deepEqual(events[5].data.requestedRoute, {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maxTokens: 2_048,
  });

  const inherited = { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max" };
  const plannerRequest = await request({ agent, turn: 1, step: 1 }, async () => inherited);
  assert.deepEqual(plannerRequest, {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  actualHeader = { config: plannerRequest };
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "assistant/chunk",
    data: { turn: 1, step: 1 },
  });
  const plannerReceipt = events.find((event) => event.type === "odai/route-applied").data;
  assert.equal(plannerReceipt.status, "applied");
  assert.equal(plannerReceipt.responsibility, "planner");
  assert.deepEqual(plannerReceipt.actualRoute, plannerRequest);
  assert.equal(plannerReceipt.requestedRoute.maxTokens, undefined);
  assert.deepEqual(await request({ agent, turn: 1, step: 2 }, async () => inherited), {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });

  await preStep({ agent, turn: 2, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("把普通按钮文案改得更清楚")],
  }));
  assert.deepEqual(await request({ agent, turn: 2, step: 1 }, async () => inherited), inherited);
});

test("a consumed frozen route card makes executor auto routing reachable exactly once", async () => {
  let starts = 0;
  const ctx = fakeContext({
    subagents: {
      async start() { starts += 1; throw new Error("executor must remain in the controller turn"); },
    },
  });
  apply(ctx, {
    skillPath,
    routing: {
      roles: {
        executor: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "high" },
      },
    },
  });
  const events = [];
  let actualHeader;
  const agent = {
    session: {
      header: {},
      events,
      requestHeader() { return actualHeader; },
      append(type, data) { events.push({ type, data }); },
    },
  };
  const routeCard = ctx.captured.tools.find((tool) => tool.name === "odai_route_card");
  const frozen = await routeCard.execute({
    action: "freeze",
    observableBenefit: true,
    target: "Implement the bounded routing change",
    evidence: ["planner verified the target"],
    scope: ["dsh/runtime only"],
    accept: ["A1: focused tests pass"],
    stop: "Stop if the DSH tool contract changes",
  }, { agent });

  const signal = new AbortController().signal;
  await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 1, step: 1, signal },
    async () => ({ kind: "enter", messages: [userMessage("开始处理另一个问题：修复登录页错位")] }),
  );
  assert.equal(events.filter((event) => event.type === "odai/route-card-consumed").length, 0);
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1 },
    async () => ({ provider: "base", model: "controller", reasoningEffort: "max" }),
  ), { provider: "base", model: "controller", reasoningEffort: "max" });

  const result = await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 2, step: 1, signal },
    async () => ({ kind: "enter", messages: [userMessage("继续执行这个方案")] }),
  );
  assert.equal(starts, 0);
  assert.match(result.messages[1].content[0].text, /target responsibility: executor/u);
  assert.match(result.messages[1].content[0].text, new RegExp(frozen.card.id, "u"));
  assert.equal(events.filter((event) => event.type === "odai/route-card-consumed").length, 1);
  const executorRequest = await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 2, step: 1 },
    async () => ({ provider: "base", model: "controller", reasoningEffort: "max" }),
  );
  assert.deepEqual(executorRequest, {
    provider: "openai",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  });
  actualHeader = { config: executorRequest };
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "request/header",
    data: { header: actualHeader },
  });
  const executorReceipt = events.find((event) => event.type === "odai/route-applied").data;
  assert.equal(executorReceipt.status, "applied");
  assert.equal(executorReceipt.responsibility, "executor");
  assert.equal((await routeCard.execute({ action: "clear", cardId: frozen.card.id }, { agent })).status, "absent");

  await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 3, step: 1, signal },
    async () => ({ kind: "enter", messages: [userMessage("继续执行这个方案")] }),
  );
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 3, step: 1 },
    async () => ({ provider: "base", model: "controller", reasoningEffort: "max" }),
  ), { provider: "base", model: "controller", reasoningEffort: "max" });
});

test("reviewer starts a child only from a complete hash-addressed evidence packet", async () => {
  let starts = 0;
  let startRequest;
  const ctx = fakeContext({
    subagents: {
      async start(_provider, request) {
        starts += 1;
        startRequest = request;
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: { header: { config: { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" } } },
              }],
            },
          },
          result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "independent review result" }] }),
          async dispose() {},
        };
      },
    },
  });
  apply(ctx, {
    skillPath,
    routing: { roles: { reviewer: { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" } } },
  });
  const events = [
    { type: "user/message", data: userMessage("实现请求：保持默认行为并修复路由。") },
    { type: "assistant/message", data: { content: [{ type: "text", text: "验收条件 A1：目标测试通过；A2：只修改目标模块。" }] } },
    { type: "tool/result", data: { callId: "diff-1", tool: "bash", isError: false, command: "git diff -- dsh/runtime/src/router.mjs", result: "diff --git a/router.mjs b/router.mjs\n+bounded change" } },
    { type: "tool/result", data: { callId: "test-1", tool: "bash", isError: false, command: "node --test dsh/runtime/tests/router.test.mjs", result: "tests 14 pass 14 fail 0 exit code: 0" } },
  ];
  const agent = { session: { header: {}, events, append(type, data) { events.push({ type, data }); } } };
  const result = await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请独立审查这次实现")] }),
  );
  assert.equal(starts, 1);
  assert.match(startRequest.prompt[0].text, /Odai bounded role context packet/u);
  assert.match(startRequest.prompt[0].text, /kinds: tool, diff/u);
  assert.match(startRequest.prompt[0].text, /kinds: tool, test/u);
  const contextEvent = events.find((event) => event.type === "odai/route-context");
  assert.equal(contextEvent.data.mode, "bounded-packet");
  assert.equal(contextEvent.data.acceptanceCount, 1);
  assert.equal(contextEvent.data.diffCount, 1);
  assert.equal(contextEvent.data.testCount, 1);
  assert.match(result.messages[1].content[0].text, new RegExp(`sha256:${contextEvent.data.digest}`, "u"));
  const routeResult = events.find((event) => event.type === "odai/route-result").data;
  assert.equal(routeResult.routeSource, "deployment-config");
  assert.equal(routeResult.fallbackUsed, false);
  assert.equal(routeResult.routeReceiptStatus, "applied");
  assert.deepEqual(routeResult.requestedRoute, {
    provider: "openai",
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
  });
  assert.deepEqual(routeResult.actualRoute, routeResult.requestedRoute);
  const shownRoute = await ctx.captured.tools
    .find((tool) => tool.name === "odai_routing_config")
    .execute({ action: "show" }, { agent });
  assert.equal(shownRoute.latestRoute.status, "applied");
  assert.equal(shownRoute.latestRoute.taskStatus, "completed");
  assert.equal(shownRoute.latestRoute.taskStopReason, "completed");
  assert.equal(shownRoute.latestRoute.routeMode, "child");

  const mismatchCtx = fakeContext({
    subagents: {
      async start() {
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: { header: { config: { provider: "openai", model: "wrong-reviewer", reasoningEffort: "max" } } },
              }],
            },
          },
          result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "untrusted review" }] }),
          async dispose() { throw new Error("reviewer cleanup failed"); },
        };
      },
    },
  });
  apply(mismatchCtx, {
    skillPath,
    routing: {
      configPath: resolve(testDshHome, "reviewer-route-mismatch", "routing.json"),
      roles: { reviewer: { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" } },
    },
  });
  const mismatchEvents = [
    { type: "user/message", data: userMessage("实现请求：保持默认行为并修复路由。") },
    { type: "assistant/message", data: { content: [{ type: "text", text: "验收条件 A1：目标测试通过；A2：只修改目标模块。" }] } },
    { type: "tool/result", data: { callId: "diff-mismatch", tool: "bash", isError: false, result: "diff --git a/router.mjs b/router.mjs\n+bounded change" } },
    { type: "tool/result", data: { callId: "test-mismatch", tool: "bash", isError: false, result: "tests 14 pass 14 fail 0 exit code: 0" } },
  ];
  const mismatchAgent = {
    session: {
      header: {},
      events: mismatchEvents,
      append(type, data) { mismatchEvents.push({ type, data }); },
    },
  };
  await mismatchCtx.captured.handlers.get("agent/pre-step")(
    { agent: mismatchAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请独立审查这次实现")] }),
  );
  const mismatchShowTool = mismatchCtx.captured.tools.find((tool) => tool.name === "odai_routing_config");
  const mismatchShown = await mismatchShowTool.execute({ action: "show" }, { agent: mismatchAgent });
  assert.equal(mismatchShown.latestRoute.status, "mismatch");
  assert.equal(mismatchShown.latestRoute.taskStatus, "fallback");
  assert.match(mismatchShown.latestRoute.error, /child model mismatch/u);
  assert.match(mismatchShown.latestRoute.taskError, /provider cleanup failed: reviewer cleanup failed/u);
  assert.doesNotMatch(mismatchShown.latestRoute.taskError, /child model mismatch/u);
  const mismatchRendered = mismatchShowTool.output.render({}, mismatchShown)[0].text;
  assert.match(mismatchRendered, /routeError=child model mismatch/u);
  assert.match(mismatchRendered, /taskError=provider cleanup failed: reviewer cleanup failed/u);

  const fallbackCtx = fakeContext({ subagents: { async start() { throw new Error("incomplete reviewer packet must not start a child"); } } });
  apply(fallbackCtx, {
    skillPath,
    routing: { roles: { reviewer: { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" } } },
  });
  const fallbackEvents = [];
  let fallbackHeader;
  const fallbackAgent = {
    session: {
      header: {},
      events: fallbackEvents,
      requestHeader() { return fallbackHeader; },
      append(type, data) { fallbackEvents.push({ type, data }); },
    },
  };
  const fallback = await fallbackCtx.captured.handlers.get("agent/pre-step")(
    { agent: fallbackAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请独立审查这次实现")] }),
  );
  assert.match(fallback.messages[1].content[0].text, /not independently reviewable/u);
  assert.match(fallback.messages[1].content[0].text, /do not claim independent acceptance/u);
  assert.equal(fallbackEvents.find((event) => event.type === "odai/route-upgrade").data.independent, false);
  assert.equal(fallbackEvents.find((event) => event.type === "odai/route-protection").data.source, "same-turn-reviewer");
  const reviewerRequest = await fallbackCtx.captured.handlers.get("agent/request")(
    { agent: fallbackAgent, turn: 1, step: 1 },
    async () => ({ provider: "base", model: "controller" }),
  );
  fallbackHeader = { config: reviewerRequest };
  fallbackCtx.captured.handlers.get("session/event")(fallbackAgent.session, {
    type: "request/header",
    data: { header: fallbackHeader },
  });
  const reviewerReceipt = fallbackEvents.find((event) => event.type === "odai/route-applied").data;
  assert.equal(reviewerReceipt.status, "applied");
  assert.equal(reviewerReceipt.responsibility, "reviewer");
  assert.equal(reviewerReceipt.routeMode, "same-turn");

  let executeStarts = 0;
  const executeCtx = fakeContext({
    subagents: {
      async start() {
        executeStarts += 1;
        throw new Error("execute reviewer must not start without a complete packet");
      },
    },
  });
  apply(executeCtx, {
    skillPath,
    routing: {
      mode: "execute",
      roles: { reviewer: { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" } },
    },
  });
  const executeEvents = [];
  const executeAgent = {
    session: {
      header: {},
      events: executeEvents,
      append(type, data) { executeEvents.push({ type, data }); },
    },
  };
  const executeFallback = await executeCtx.captured.handlers.get("agent/pre-step")(
    { agent: executeAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请独立审查这次实现")] }),
  );
  assert.equal(executeStarts, 0);
  assert.match(executeFallback.messages[1].content[0].text, /bounded packet is incomplete/u);
  assert.equal(executeEvents.find((event) => event.type === "odai/route-result").data.stopReason, "evidence-packet-missing");

  let failedStarts = 0;
  const failedCtx = fakeContext({ subagents: { async start() { failedStarts += 1; throw new Error("failed tests must block reviewer children"); } } });
  apply(failedCtx, {
    skillPath,
    routing: { roles: { reviewer: { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" } } },
  });
  const failedEvents = [
    { type: "user/message", data: userMessage("实现请求：保持默认行为并修复路由。") },
    { type: "assistant/message", data: { content: [{ type: "text", text: "验收条件 A1：目标测试通过。" }] } },
    { type: "tool/result", data: { callId: "diff-2", tool: "bash", isError: false, result: "diff --git a/router.mjs b/router.mjs\n+bounded change" } },
    { type: "tool/result", data: { callId: "test-2", tool: "bash", isError: false, result: "tests 14 pass 13 fail 1 exit code: 1" } },
  ];
  const failedAgent = { session: { header: {}, events: failedEvents, append(type, data) { failedEvents.push({ type, data }); } } };
  await failedCtx.captured.handlers.get("agent/pre-step")(
    { agent: failedAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请独立审查这次实现")] }),
  );
  assert.equal(failedStarts, 0);
  assert.equal(failedEvents.find((event) => event.type === "odai/route-context").data.sufficient, false);
  assert.equal(failedEvents.find((event) => event.type === "odai/route-upgrade").data.independent, false);
});

test("frontend incident upgrades in place, verifies its actual route, and overrides the global ceiling", async () => {
  const outputConfigPath = resolve(testDshHome, "frontend-output-policy", "output.json");
  const routingConfigPath = resolve(testDshHome, "frontend-output-policy", "routing.json");
  mkdirSync(resolve(testDshHome, "frontend-output-policy"), { recursive: true });
  writeFileSync(outputConfigPath, `${JSON.stringify({
    schemaVersion: 1,
    policy: { concise: true, maxTokens: 500 },
  })}\n`, "utf8");
  let starts = 0;
  const ctx = fakeContext({
    subagents: {
      async start() { starts += 1; throw new Error("frontend must remain in the controller turn"); },
    },
  });
  apply(ctx, {
    skillPath,
    output: { configPath: outputConfigPath },
    routing: {
      configPath: routingConfigPath,
      roles: {
        frontend: {
          provider: "provider-frontend",
          model: "model-frontend",
          reasoningEffort: "max",
          maxTokens: 4_096,
        },
      },
    },
  });
  const events = [];
  let actualHeader;
  const agent = {
    session: {
      header: {},
      events,
      requestHeader() { return actualHeader; },
      append(type, data) { events.push({ type, data }); },
    },
  };
  const signal = new AbortController().signal;
  const assembled = await ctx.captured.handlers.get("system-prompt/assemble")(
    {},
    { agent, signal },
    async () => ({ sections: ctx.captured.sections }),
  );
  const routingSection = assembled.sections.find((section) => section.name === "odai:routing-configuration").text;
  assert.match(routingSection, /runtime-owned; supersedes conversation summaries/u);
  assert.match(routingSection, /frontend=provider-frontend\/model-frontend \(reasoningEffort=max, maxTokens=4096\) \[deployment-config\]/u);
  assert.match(routingSection, /route targets, not evidence/u);
  const routed = await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("评估一下这个：把小松同学登录页面、登录后的首页以及个人空间截图发上去，帮我们优化界面介绍，看怎么让大家一眼就能明白小松同学是做什么的。")],
  }));
  assert.equal(starts, 0);
  assert.match(routed.messages[1].content[0].text, /target responsibility: frontend/u);
  assert.match(routed.messages[1].content[0].text, /Canonical craft reference/u);
  assert.match(routed.messages[1].content[0].text, /not an independent child/u);

  const request = ctx.captured.handlers.get("agent/request");
  const effectiveRequest = await request({ agent, turn: 1, step: 1 }, async () => ({
    provider: "base",
    model: "controller",
    reasoningEffort: "high",
    maxTokens: 8_000,
  }));
  assert.deepEqual(effectiveRequest, {
    provider: "provider-frontend",
    model: "model-frontend",
    reasoningEffort: "max",
    maxTokens: 4_096,
  });
  actualHeader = { config: effectiveRequest };
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "request/header",
    data: { header: actualHeader },
  });
  const applied = events.find((event) => event.type === "odai/route-applied");
  assert.deepEqual(applied.data, {
    turn: 1,
    step: 1,
    responsibility: "frontend",
    status: "applied",
    routeMode: "same-turn",
    routeSource: "deployment-config",
    fallbackUsed: false,
    requestedRoute: {
      provider: "provider-frontend",
      model: "model-frontend",
      reasoningEffort: "max",
      maxTokens: 4_096,
    },
    actualRoute: effectiveRequest,
  });
  const routingTool = ctx.captured.tools.find((tool) => tool.name === "odai_routing_config");
  const shown = await routingTool.execute({ action: "show" }, { agent });
  assert.deepEqual(shown.latestRoute, applied.data);
  assert.match(routingTool.output.render({}, shown)[0].text, /actual=provider-frontend\/model-frontend/u);
  const override = events.find((event) => event.type === "odai/output-budget-overridden");
  assert.deepEqual(override.data, {
    turn: 1,
    step: 1,
    responsibility: "frontend",
    responsibilityMaxTokens: 4_096,
    configuredControllerMaxTokens: 500,
    effectiveMaxTokens: 4_096,
    semantics: "explicit-responsibility-override",
  });

  await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 2, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("把普通按钮文案改清楚")],
  }));
  assert.deepEqual(await request({ agent, turn: 2, step: 1 }, async () => ({ provider: "base", model: "controller" })), {
    provider: "base",
    model: "controller",
    maxTokens: 500,
  });
});

test("same-turn route mismatch emits an actual receipt and fails closed before tools", async () => {
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: {
      configPath: resolve(testDshHome, "frontend-route-mismatch", "routing.json"),
      roles: {
        frontend: { provider: "provider-frontend", model: "model-frontend", reasoningEffort: "max" },
      },
    },
  });
  const events = [];
  const actualHeader = { config: { provider: "base", model: "controller", reasoningEffort: "high" } };
  const agent = {
    session: {
      header: {},
      events,
      requestHeader() { return actualHeader; },
      append(type, data) { events.push({ type, data }); },
    },
  };
  const signal = new AbortController().signal;
  await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("重新设计登录页和首页的信息架构与响应式交互。")],
  }));
  await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1 },
    async () => ({ provider: "base", model: "controller", reasoningEffort: "high" }),
  );
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "request/header",
    data: { header: actualHeader },
  });

  const receipt = events.find((event) => event.type === "odai/route-applied").data;
  assert.equal(receipt.status, "mismatch");
  assert.equal(receipt.fallbackUsed, true);
  assert.deepEqual(receipt.actualRoute, actualHeader.config);
  assert.match(receipt.error, /same-turn provider mismatch/u);
  assert.match(
    ctx.captured.guards[0]({ callId: "mismatched-route-write", agent, name: "write" }),
    /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u,
  );
  const tool = ctx.captured.tools.find((candidate) => candidate.name === "odai_routing_config");
  const shown = await tool.execute({ action: "show" }, { agent });
  assert.equal(shown.latestRoute.status, "mismatch");
  assert.equal(shown.latestRoute.fallbackUsed, true);

  const unverifiedEvents = [];
  const unverifiedAgent = {
    session: {
      header: {},
      events: unverifiedEvents,
      append(type, data) { unverifiedEvents.push({ type, data }); },
    },
  };
  await ctx.captured.handlers.get("agent/pre-step")({ agent: unverifiedAgent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("重新设计登录页和首页的信息架构与响应式交互。")],
  }));
  await ctx.captured.handlers.get("agent/request")(
    { agent: unverifiedAgent, turn: 1, step: 1 },
    async () => ({ provider: "base", model: "controller" }),
  );
  ctx.captured.handlers.get("session/event")(unverifiedAgent.session, { type: "turn/end", data: { turn: 1 } });
  const unverified = unverifiedEvents.find((event) => event.type === "odai/route-applied").data;
  assert.equal(unverified.status, "unverified");
  assert.equal(unverified.stopReason, "no-effective-request");
  assert.equal(unverified.actualRoute, undefined);
});

test("frontend missing mapping falls through and an omitted role budget keeps the global ceiling", async () => {
  const outputConfigPath = resolve(testDshHome, "frontend-fallback-output", "output.json");
  mkdirSync(resolve(testDshHome, "frontend-fallback-output"), { recursive: true });
  writeFileSync(outputConfigPath, `${JSON.stringify({ schemaVersion: 1, policy: { concise: true, maxTokens: 500 } })}\n`, "utf8");
  const task = userMessage("整体改版这个运维仪表盘，覆盖移动端和交互状态，并用 Playwright 做浏览器验收。");
  const signal = new AbortController().signal;

  const missingCtx = fakeContext();
  apply(missingCtx, { skillPath, output: { configPath: outputConfigPath } });
  const missingEvents = [];
  const missingAgent = { session: { header: {}, events: missingEvents, append(type, data) { missingEvents.push({ type, data }); } } };
  const missing = await missingCtx.captured.handlers.get("agent/pre-step")(
    { agent: missingAgent, turn: 1, step: 1, signal },
    async () => ({ kind: "enter", messages: [task] }),
  );
  assert.equal(missing.messages.length, 1);
  assert.equal(missingEvents.find((event) => event.type === "odai/route-config-missing").data.role, "frontend");

  const boundedCtx = fakeContext();
  apply(boundedCtx, {
    skillPath,
    output: { configPath: outputConfigPath },
    routing: { roles: { frontend: { provider: "provider-frontend", model: "model-frontend", reasoningEffort: "max" } } },
  });
  const boundedEvents = [];
  const boundedAgent = { session: { header: {}, events: boundedEvents, append(type, data) { boundedEvents.push({ type, data }); } } };
  await boundedCtx.captured.handlers.get("agent/pre-step")(
    { agent: boundedAgent, turn: 1, step: 1, signal },
    async () => ({ kind: "enter", messages: [task] }),
  );
  assert.deepEqual(await boundedCtx.captured.handlers.get("agent/request")(
    { agent: boundedAgent, turn: 1, step: 1 },
    async () => ({ provider: "base", model: "controller", maxTokens: 8_000 }),
  ), {
    provider: "provider-frontend",
    model: "model-frontend",
    reasoningEffort: "max",
    maxTokens: 500,
  });
  assert.equal(boundedEvents.some((event) => event.type === "odai/output-budget-overridden"), false);
});

test("auto mode upgrades an implicit continuation of earlier high-impact context", async () => {
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: {
      roles: {
        planner: {
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          maxTokens: 2_048,
        },
      },
    },
  });

  const highImpact = userMessage("线上退款偶尔重复入账，我看就是确认超时太短。把确认超时改成 30 秒、最多重试 3 次。");
  const continuation = userMessage("继续深入判断刚才这个迁移是否可以安全发布");
  const events = [
    { type: "user/message", data: highImpact },
    { type: "user/message", data: userMessage("用一句话重述刚才的结论") },
    { type: "user/message", data: continuation },
  ];
  const agent = {
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 3,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [continuation],
  }));

  const routeEvents = events.filter((event) => event.type.startsWith("odai/route-"));
  assert.equal(routeEvents[0].type, "odai/route-decided");
  assert.equal(routeEvents[0].data.action, "upgrade");
  assert.equal(routeEvents[0].data.reasonCode, "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE");
  assert.equal(routeEvents[1].type, "odai/route-context");
  assert.equal(routeEvents[2].type, "odai/route-protection");
  assert.equal(routeEvents[3].type, "odai/route-upgrade");
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 3, step: 1 },
    async () => ({ provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max" }),
  ), {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
});

test("configured auto mode keeps an explicit planner gap in the current turn", async () => {
  let starts = 0;
  let startRequest;
  const ctx = fakeContext({
    subagents: {
      async start(_provider, request) {
        starts += 1;
        startRequest = request;
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: {
                  header: {
                    config: {
                      provider: "openai",
                      model: "gpt-5.6-sol",
                      reasoningEffort: "high",
                    },
                  },
                },
              }],
            },
          },
          result: Promise.resolve({
            stopReason: "completed",
            output: [{ type: "text", text: "independent decision" }],
          }),
          async dispose() {},
        };
      },
    },
  });
  apply(ctx, {
    skillPath,
    routing: {
      roles: {
        planner: {
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          maxTokens: 2_048,
        },
      },
    },
  });

  const events = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  const result = await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("请独立规划一下架构选型")],
  }));

  assert.equal(starts, 0);
  assert.equal(startRequest, undefined);
  assert.match(result.messages[1].content[0].text, /runtime: auto/u);
  assert.match(result.messages[1].content[0].text, /no child was started/u);
  assert.match(result.messages[1].content[0].text, /planner responsibility contract/u);
  assert.deepEqual(events.map((event) => event.type), [
    "odai/route-decided",
    "odai/route-context",
    "odai/route-protection",
    "odai/route-upgrade",
  ]);
  assert.equal(events[0].data.action, "upgrade");
  assert.equal(events[3].data.status, "requested");
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1 },
    async () => ({ provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max" }),
  ), {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
});

test("configured researcher compresses evidence before planner without replacing the decision route", async () => {
  const starts = [];
  const subagents = {
    async start(_provider, request) {
      starts.push(request);
      return {
        localAgent: {
          session: {
            events: [{
              type: "request/header",
              data: { header: { config: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "xhigh", maxTokens: 500 } } },
            }],
          },
        },
        result: Promise.resolve({
          stopReason: "completed",
          output: [{ type: "text", text: researchPacketText() }],
        }),
        async dispose() {},
      };
    },
  };
  const ctx = fakeContext({ subagents });
  apply(ctx, {
    skillPath,
    routing: {
      roles: {
        researcher: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "xhigh", maxTokens: 500 },
        planner: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", maxTokens: 2_048 },
      },
    },
  });
  const events = [];
  const agent = {
    session: {
      header: { cwd: researchProjectRoot },
      events,
      append(type, data) { events.push({ type, data }); },
    },
  };
  const signal = new AbortController().signal;
  const requestText = "checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。";
  const result = await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage(requestText)],
  }));

  assert.equal(starts.length, 1);
  assert.equal(starts[0].label, "odai-researcher");
  assert.deepEqual(starts[0].agentOptions, { provider: "openai", model: "gpt-5.6-luna", maxTokens: 500 });
  assert.match(starts[0].prompt[0].text, /no fields beyond this exact shape/u);
  assert.match(starts[0].prompt[0].text, /"claim":"\.\.\.","excerpt":"exact complete cited line"/u);
  assert.match(starts[0].prompt[0].text, /Allowed source scope: the current project root only/u);
  assert.match(starts[0].prompt[0].text, /excerpt must exactly equal the complete cited source line/u);
  assert.equal(result.messages.length, 3);
  assert.match(result.messages[1].content[0].text, /Odai bounded researcher evidence packet/u);
  assert.match(result.messages[1].content[0].text, /config\/checkout\.json/u);
  assert.match(result.messages[2].content[0].text, /planner responsibility contract/u);
  const researchResult = events.find((event) => event.type === "odai/research-result");
  assert.equal(researchResult.data.status, "completed");
  assert.equal(researchResult.data.sourceCount, 2);
  assert.equal(researchResult.data.routeSource, "deployment-config");
  assert.equal(researchResult.data.fallbackUsed, false);
  assert.equal(researchResult.data.routeReceiptStatus, "applied");
  assert.deepEqual(researchResult.data.actualRoute, researchResult.data.requestedRoute);
  assert.match(researchResult.data.packetDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(events.filter((event) => event.type === "odai/route-decided").map((event) => event.data.targetRole), ["planner"]);
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1 },
    async () => ({ provider: "openai", model: "controller", reasoningEffort: "max", maxTokens: 8_000 }),
  ), {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maxTokens: 8_000,
  });

  const mismatchCtx = fakeContext({
    subagents: {
      async start() {
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: { header: { config: { provider: "openai", model: "wrong-researcher", reasoningEffort: "xhigh", maxTokens: 500 } } },
              }],
            },
          },
          result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: researchPacketText() }] }),
          async dispose() { throw new Error("researcher cleanup failed"); },
        };
      },
    },
  });
  apply(mismatchCtx, {
    skillPath,
    routing: {
      configPath: resolve(testDshHome, "researcher-route-mismatch", "routing.json"),
      roles: {
        researcher: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "xhigh", maxTokens: 500 },
        planner: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" },
      },
    },
  });
  const mismatchEvents = [];
  const mismatchAgent = {
    session: {
      header: { cwd: researchProjectRoot },
      events: mismatchEvents,
      append(type, data) { mismatchEvents.push({ type, data }); },
    },
  };
  await mismatchCtx.captured.handlers.get("agent/pre-step")(
    { agent: mismatchAgent, turn: 1, step: 1, signal },
    async () => ({ kind: "enter", messages: [userMessage(requestText)] }),
  );
  const mismatchShowTool = mismatchCtx.captured.tools.find((tool) => tool.name === "odai_routing_config");
  const mismatchShown = await mismatchShowTool.execute({ action: "show" }, { agent: mismatchAgent });
  assert.equal(mismatchShown.latestRoute.status, "mismatch");
  assert.equal(mismatchShown.latestRoute.taskStatus, "fallback");
  assert.match(mismatchShown.latestRoute.error, /child model mismatch/u);
  assert.match(mismatchShown.latestRoute.taskError, /provider cleanup failed: researcher cleanup failed/u);
  assert.doesNotMatch(mismatchShown.latestRoute.taskError, /child model mismatch/u);
  const mismatchRendered = mismatchShowTool.output.render({}, mismatchShown)[0].text;
  assert.match(mismatchRendered, /routeError=child model mismatch/u);
  assert.match(mismatchRendered, /taskError=provider cleanup failed: researcher cleanup failed/u);

  const missingPlannerCtx = fakeContext({ subagents });
  apply(missingPlannerCtx, {
    skillPath,
    routing: {
      roles: {
        researcher: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "xhigh", maxTokens: 500 },
      },
    },
  });
  const missingEvents = [];
  const missingAgent = {
    session: {
      header: { cwd: researchProjectRoot },
      events: missingEvents,
      append(type, data) { missingEvents.push({ type, data }); },
    },
  };
  const missingResult = await missingPlannerCtx.captured.handlers.get("agent/pre-step")({
    agent: missingAgent,
    turn: 1,
    step: 1,
    signal,
  }, async () => ({ kind: "enter", messages: [userMessage(requestText)] }));
  assert.equal(starts.length, 2);
  assert.equal(missingResult.messages.length, 3);
  assert.match(missingResult.messages[2].content[0].text, /required responsibility: planner/u);
  assert.equal(missingEvents.find((event) => event.type === "odai/route-config-missing" && event.data.role === "planner").data.status, "unconfigured");
  assert.match(missingPlannerCtx.captured.guards[0]({ callId: "write", agent: missingAgent, name: "write" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
});

test("invalid researcher output is discarded before the planner sees it", async () => {
  const ctx = fakeContext({
    subagents: {
      async start() {
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: { header: { config: { provider: "openai", model: "researcher-model" } } },
              }],
            },
          },
          result: Promise.resolve({
            stopReason: "completed",
            output: [{ type: "text", text: researchPacketText({ facts: [
              {
                claim: "The client already retries once.",
                excerpt: "retries=1",
                source: { path: "config/checkout.json", line: 4 },
                authority: "runtime configuration",
              },
              {
                claim: "A missing source proves the provider is unsafe.",
                excerpt: "fabricated",
                source: { path: "logs/missing.md", line: 1 },
                authority: "fabricated record",
              },
            ] }) }],
          }),
          async dispose() {},
        };
      },
    },
  });
  apply(ctx, {
    skillPath,
    routing: {
      roles: {
        researcher: { provider: "openai", model: "researcher-model" },
        planner: { provider: "openai", model: "planner-model" },
      },
    },
  });
  const events = [];
  const agent = { session: { header: { cwd: researchProjectRoot }, events, append(type, data) { events.push({ type, data }); } } };
  const result = await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));
  assert.equal(result.messages.length, 2);
  assert.doesNotMatch(result.messages[1].content[0].text, /bounded researcher evidence packet/u);
  const researchResult = events.find((event) => event.type === "odai/research-result");
  assert.equal(researchResult.data.status, "fallback");
  assert.equal(researchResult.data.routeReceiptStatus, "applied");
  assert.equal(researchResult.data.stopReason, "packet-invalid");
  assert.match(researchResult.data.error, /source\.path does not exist/u);
});

test("high-impact execute routing fails closed when the planner is unavailable", async () => {
  const ctx = fakeContext({
    subagents: {
      async start() {
        throw new Error("provider unavailable");
      },
    },
  });
  apply(ctx, {
    skillPath,
    routing: {
      mode: "execute",
      provider: "spawn",
      roles: { planner: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" } },
    },
  });

  const events = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  const handler = ctx.captured.handlers.get("agent/pre-step");
  const result = await handler({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));

  assert.deepEqual(events.slice(0, 6).map((event) => event.type), [
    "odai/research-decided",
    "odai/research-result",
    "odai/route-decided",
    "odai/route-context",
    "odai/route-result",
    "odai/route-protection",
  ]);
  assert.equal(events[1].data.stopReason, "route-config-missing");
  assert.equal(events[3].data.mode, "bounded-packet");
  assert.equal(events[4].data.status, "fallback");
  assert.equal(events[5].data.source, "route-failure");
  assert.equal(events[5].data.failure, "provider unavailable");
  assert.match(result.messages[1].content[0].text, /High-impact fail-closed protection is active/u);
  assert.doesNotMatch(result.messages[1].content[0].text, /continue directly/u);

  const guard = ctx.captured.guards[0];
  assert.match(guard({ callId: "write-failed-route", agent, name: "write" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
  assert.equal(guard({ callId: "read-failed-route", agent, name: "read" }), undefined);
});

test("ordinary planner route failure still permits controller fallback", async () => {
  const ctx = fakeContext({
    subagents: {
      async start() {
        throw new Error("provider unavailable");
      },
    },
  });
  apply(ctx, {
    skillPath,
    routing: {
      mode: "execute",
      provider: "spawn",
      roles: { planner: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" } },
    },
  });

  const events = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  const result = await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("请独立规划一下架构选型")],
  }));

  assert.equal(events.some((event) => event.type === "odai/route-protection"), false);
  assert.match(result.messages[1].content[0].text, /continue directly as controller/u);
  assert.equal(ctx.captured.guards[0]({ callId: "write-normal-fallback", agent, name: "write" }), undefined);
});

test("execute routing rejects a completed child without textual evidence", async () => {
  let disposed = false;
  const result = await runRoutedRole({
    subagents: {
      async start() {
        return {
          result: Promise.resolve({ stopReason: "completed", output: [] }),
          async dispose() {
            disposed = true;
          },
        };
      },
    },
    provider: "spawn",
    decision: { role: "planner" },
    taskText: "plan",
    roleContract: "Canonical planner contract.",
    agent: {},
    signal: new AbortController().signal,
  });

  assert.equal(disposed, true);
  assert.equal(result.status, "fallback");
  assert.equal(result.routeReceiptStatus, "unverified");
  assert.equal(result.stopReason, "route-empty-output");
  assert.equal(result.error, "child completed without textual evidence");
  assert.equal(result.taskError, "child completed without textual evidence");
  assert.deepEqual(result.output, []);
});

test("execute routing discards output when the actual child model mismatches", async () => {
  let disposed = false;
  const result = await runRoutedRole({
    subagents: {
      async start() {
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: {
                  header: {
                    config: {
                      provider: "openai",
                      model: "gpt-5.6-luna",
                      reasoningEffort: "max",
                    },
                  },
                },
              }],
            },
          },
          result: Promise.resolve({
            stopReason: "completed",
            output: [{ type: "text", text: "untrusted route output" }],
          }),
          async dispose() {
            disposed = true;
          },
        };
      },
    },
    provider: "spawn",
    decision: { role: "planner" },
    taskText: "compare options",
    roleContract: "Canonical planner contract.",
    agent: {},
    signal: new AbortController().signal,
    roleRoute: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    },
  });

  assert.equal(disposed, true);
  assert.equal(result.status, "fallback");
  assert.equal(result.routeReceiptStatus, "mismatch");
  assert.match(result.routeReceiptError, /child model mismatch/u);
  assert.equal(result.stopReason, "route-unverified");
  assert.match(result.error, /child model mismatch/u);
  assert.deepEqual(result.output, []);
});

test("execute routing marks a missing child request header unverified", async () => {
  const result = await runRoutedRole({
    subagents: {
      async start() {
        return {
          localAgent: { session: { events: [] } },
          result: Promise.resolve({
            stopReason: "completed",
            output: [{ type: "text", text: "unverified child output" }],
          }),
          async dispose() {},
        };
      },
    },
    provider: "spawn",
    decision: { role: "reviewer" },
    taskText: "review",
    roleContract: "Canonical reviewer contract.",
    agent: {},
    signal: new AbortController().signal,
    roleRoute: { provider: "openai", model: "reviewer-model" },
  });

  assert.equal(result.status, "fallback");
  assert.equal(result.routeReceiptStatus, "unverified");
  assert.match(result.routeReceiptError, /request\/header did not expose/u);
  assert.equal(result.stopReason, "route-unverified");
  assert.match(result.error, /request\/header did not expose/u);
  assert.deepEqual(result.output, []);
});

test("execute routing falls back without claiming evidence on provider failure", async () => {
  const result = await runRoutedRole({
    subagents: {
      async start() {
        throw new Error("provider unavailable");
      },
    },
    provider: "spawn",
    decision: { role: "reviewer" },
    taskText: "review",
    roleContract: "Canonical reviewer contract.",
    agent: {},
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "fallback");
  assert.equal(result.routeReceiptStatus, "unverified");
  assert.equal(result.stopReason, "infrastructure-error");
  assert.equal(result.error, "provider unavailable");
  assert.equal(result.taskError, "provider unavailable");
});

test("execute routing treats provider cleanup failure as untrusted evidence", async () => {
  const result = await runRoutedRole({
    subagents: {
      async start() {
        return {
          result: Promise.resolve({
            stopReason: "completed",
            output: [{ type: "text", text: "must not be trusted" }],
          }),
          async dispose() {
            throw new Error("cleanup timed out");
          },
        };
      },
    },
    provider: "spawn",
    decision: { role: "planner" },
    taskText: "compare options",
    roleContract: "Canonical planner contract.",
    agent: {},
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "fallback");
  assert.equal(result.routeReceiptStatus, "unverified");
  assert.equal(result.stopReason, "infrastructure-error");
  assert.match(result.error, /provider cleanup failed: cleanup timed out/u);
  assert.equal(result.taskError, "provider cleanup failed: cleanup timed out");
  assert.deepEqual(result.output, []);
});

test("the model can persist every user-specified responsibility mapping", async () => {
  const configPath = resolve(testDshHome, "natural-config", "routing.json");
  const ctx = fakeContext();
  const secondRuntimeCtx = fakeContext();
  apply(ctx, { skillPath, routing: { configPath } });
  apply(secondRuntimeCtx, { skillPath, routing: { configPath } });
  const tool = ctx.captured.tools.find((candidate) => candidate.name === "odai_routing_config");
  assert.ok(tool);
  assert.match(tool.description, /Never choose a provider, model, reasoning effort, token limit, or price on the user's behalf/u);

  const events = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  const execution = { agent };
  const mappings = {
    researcher: { provider: "provider-r", model: "model-research", reasoningEffort: "low", maxTokens: 512 },
    planner: { provider: "provider-a", model: "model-plan", reasoningEffort: "high", maxTokens: 2_048 },
    executor: { provider: "provider-b", model: "model-execute", reasoningEffort: "medium" },
    reviewer: { provider: "provider-c", model: "model-review", reasoningEffort: "max" },
    frontend: { provider: "provider-frontend", model: "model-frontend", reasoningEffort: "max", maxTokens: 4_096 },
  };
  for (const [responsibility, route] of Object.entries(mappings)) {
    const configured = await tool.execute({ action: "set", responsibility, ...route }, execution);
    assert.deepEqual(configured.roles[responsibility], route);
    assert.equal(configured.requiresNextTurn, true);
  }

  const shown = await tool.execute({ action: "show" }, execution);
  assert.deepEqual(shown.roles, mappings);
  assert.equal(shown.requiresNextTurn, false);
  const rendered = tool.output.render({}, shown)[0].text;
  assert.match(rendered, /researcher: provider-r\/model-research \(reasoningEffort=low, maxTokens=512\)/u);
  assert.match(rendered, /planner: provider-a\/model-plan \(reasoningEffort=high, maxTokens=2048\)/u);
  assert.match(rendered, /frontend: provider-frontend\/model-frontend \(reasoningEffort=max, maxTokens=4096\)/u);
  assert.match(rendered, /Researcher routing is task-gated but not price-aware[^\n]*does not guarantee lower cost/u);
  assert.equal(events.filter((event) => event.type === "odai/routing-configured").length, 5);

  const preStep = secondRuntimeCtx.captured.handlers.get("agent/pre-step");
  await preStep({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));
  const inherited = { provider: "base", model: "controller", reasoningEffort: "max" };
  assert.deepEqual(
    await secondRuntimeCtx.captured.handlers.get("agent/request")({ agent, turn: 1 }, async () => inherited),
    { provider: "provider-a", model: "model-plan", reasoningEffort: "high" },
  );

  const removed = await tool.execute({ action: "remove", responsibility: "executor" }, execution);
  assert.equal(removed.roles.executor, undefined);
  assert.throws(
    () => tool.execute({
      action: "set",
      responsibility: "planner",
      provider: "provider-a",
      model: "model-plan",
    }, { agent: { session: { header: { origin: "subagent", delegationDepth: 1 } } } }),
    /child agents may not change/u,
  );
});
