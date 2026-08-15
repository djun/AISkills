import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const skillPath = resolve(import.meta.dirname, "../../../skills/odai/SKILL.md");
const previousDshHome = process.env.DSH_HOME;
const testDshHome = mkdtempSync(resolve(tmpdir(), "odai-runtime-tests-"));
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

test("config is strict at governance boundaries", () => {
  assert.throws(() => resolveConfig({ routing: { mode: "magic" } }), /must be off, observe, auto, or execute/u);
  assert.throws(() => resolveConfig({ governance: { additionalDeniedTools: [""] } }), /non-empty strings/u);
  assert.throws(() => resolveConfig({ routing: { roles: { planner: { provider: "openai" } } } }), /planner\.model/u);
  assert.throws(() => resolveConfig({ routing: { roles: { critic: {} } } }), /unknown roles: critic/u);
  assert.throws(() => resolveConfig({ routing: { configPath: "" } }), /configPath must be a non-empty string/u);
  assert.throws(() => resolveConfig({ governance: { skillSource: "latest" } }), /skillSource must be bundled, auto, or user/u);
  assert.throws(() => resolveConfig({ governance: { skillConfigPath: "" } }), /skillConfigPath must be a non-empty string/u);
  assert.throws(() => resolveConfig({ output: { configPath: "" } }), /config\.output\.configPath must be a non-empty string/u);
  assert.throws(() => resolveConfig({ output: { concise: true } }), /config\.output has unknown fields: concise/u);
  assert.throws(() => resolveConfig({ compaction: { cacheRetention: "forever" } }), /provider-default, short, long, or none/u);
  assert.throws(() => resolveConfig({ compaction: { maxTokens: 500 } }), /config\.compaction has unknown fields: maxTokens/u);

  const defaults = resolveConfig();
  assert.equal(defaults.routing.mode, "auto");
  assert.equal(defaults.routing.roles.planner, undefined);
  assert.equal(defaults.routing.roles.executor, undefined);
  assert.equal(defaults.routing.roles.reviewer, undefined);
  assert.equal(defaults.routing.configPath, resolve(testDshHome, "odai/routing.json"));
  assert.equal(defaults.governance.skillSource, "bundled");
  assert.equal(defaults.governance.skillConfigPath, resolve(testDshHome, "odai/source.json"));
  assert.equal(defaults.output.configPath, resolve(testDshHome, "odai/output.json"));
  assert.equal(defaults.compaction.cacheRetention, "long");
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
    process.env.ODAI_COMPACTION_CACHE_RETENTION = "invalid";
    assert.throws(() => resolveConfig(), /provider-default, short, long, or none/u);
  } finally {
    if (previous === undefined) delete process.env.ODAI_COMPACTION_CACHE_RETENTION;
    else process.env.ODAI_COMPACTION_CACHE_RETENTION = previous;
  }
});

test("compaction inherits routed reasoning only for the exact current target", async () => {
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
  assert.equal(eligible.cacheRetention, "long");

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
  assert.equal(streamed.cacheRetention, "long");
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
  assert.equal(independentlyBudgetedCompaction.cacheRetention, "long");
  assert.equal(independentlyBudgetedCompaction.maxTokens, 8_192);

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

test("routing off ignores stale protection evidence", () => {
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

  assert.equal(ctx.captured.handlers.has("agent/pre-step"), false);
  assert.equal(ctx.captured.guards[0]({ callId: "write-off", agent, name: "write" }), undefined);
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

test("role model selection overrides the child request but not the controller", async () => {
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: {
      mode: "observe",
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

  const planner = {
    session: {
      events: [{ type: "subagent/descriptor", data: { label: "odai-planner" } }],
    },
  };
  assert.deepEqual(await handler({ agent: planner }, async () => inherited), {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
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

test("plugin registers canonical prompt, monotonic guard, audit observer, and router", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "observe" } });

  assert.equal(ctx.captured.sections.length, 4);
  assert.match(ctx.captured.sections[0].text, /odai canonical governance/u);
  assert.match(ctx.captured.sections[0].text, /already loaded by this runtime; do not call the skill tool/u);
  assert.match(ctx.captured.sections[1].text, /naturally asks to inspect, set, change, or remove/u);
  assert.match(ctx.captured.sections[1].text, /Never infer, recommend as chosen, or silently select/u);
  assert.match(ctx.captured.sections[2].text, /explicitly asks to inspect, set, or reset that source/u);
  assert.equal(ctx.captured.sections[3].text, "");
  assert.equal(ctx.captured.tools[0].name, "odai_routing_config");
  assert.equal(ctx.captured.tools[1].name, "odai_skill_source_config");
  assert.equal(ctx.captured.tools[2].name, "odai_output_config");
  assert.ok(ctx.captured.handlers.has("system-prompt/assemble"));
  assert.equal(ctx.captured.guards.length, 1);
  assert.ok(ctx.captured.handlers.has("tools/result"));
  assert.ok(ctx.captured.handlers.has("agent/pre-step"));

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
  assert.deepEqual(events.slice(0, 2).map((event) => event.type), [
    "odai/route-decided",
    "odai/route-protection",
  ]);
  assert.equal(events[0].data.role, "controller");
  assert.equal(events[0].data.action, "upgrade");
  assert.equal(events[0].data.targetRole, "planner");
  assert.equal(events[0].data.reasonCode, "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE");
  assert.equal(events[1].data.mode, "read-only");
  assert.equal(events[1].data.source, "observe");

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
    "odai/route-decided",
    "odai/route-config-missing",
    "odai/route-protection",
  ]);
  assert.equal(events[1].data.role, "planner");
  assert.equal(events[1].data.status, "unconfigured");
  assert.equal(events[2].data.source, "route-config-missing");
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
  assert.deepEqual(events.map((event) => event.type), ["odai/route-decided", "odai/route-upgrade"]);
  assert.equal(events[0].data.role, "controller");
  assert.equal(events[0].data.action, "upgrade");
  assert.equal(events[0].data.targetRole, "planner");
  assert.equal(events[1].data.status, "requested");
  assert.deepEqual(events[1].data.requestedRoute, {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maxTokens: 2_048,
  });

  const inherited = { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max" };
  assert.deepEqual(await request({ agent, turn: 1, step: 1 }, async () => inherited), {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
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
  assert.equal(routeEvents[1].type, "odai/route-upgrade");
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 3, step: 1 },
    async () => ({ provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max" }),
  ), {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
});

test("configured auto mode still delegates an explicit independent planner gap", async () => {
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

  assert.equal(starts, 1);
  assert.deepEqual(startRequest.agentOptions, {
    provider: "openai",
    model: "gpt-5.6-sol",
    maxTokens: 2_048,
  });
  assert.match(result.messages[1].content[0].text, /runtime: auto/u);
  assert.match(result.messages[1].content[0].text, /verified child route: openai\/gpt-5\.6-sol/u);
  assert.deepEqual(events.map((event) => event.type), ["odai/route-decided", "odai/route-result"]);
  assert.equal(events[0].data.action, "delegate");
  assert.equal(events[1].data.status, "completed");
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

  assert.deepEqual(events.slice(0, 3).map((event) => event.type), [
    "odai/route-decided",
    "odai/route-result",
    "odai/route-protection",
  ]);
  assert.equal(events[1].data.status, "fallback");
  assert.equal(events[2].data.source, "route-failure");
  assert.equal(events[2].data.failure, "provider unavailable");
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
  assert.equal(result.stopReason, "route-empty-output");
  assert.equal(result.error, "child completed without textual evidence");
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
  assert.equal(result.stopReason, "route-unverified");
  assert.match(result.error, /child model mismatch/u);
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
  assert.equal(result.stopReason, "infrastructure-error");
  assert.equal(result.error, "provider unavailable");
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
  assert.equal(result.stopReason, "infrastructure-error");
  assert.match(result.error, /provider cleanup failed: cleanup timed out/u);
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
  assert.match(tool.description, /Never choose a provider, model, reasoning effort, or token limit on the user's behalf/u);

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
    planner: { provider: "provider-a", model: "model-plan", reasoningEffort: "high", maxTokens: 2_048 },
    executor: { provider: "provider-b", model: "model-execute", reasoningEffort: "medium" },
    reviewer: { provider: "provider-c", model: "model-review", reasoningEffort: "max" },
  };
  for (const [responsibility, route] of Object.entries(mappings)) {
    const configured = await tool.execute({ action: "set", responsibility, ...route }, execution);
    assert.deepEqual(configured.roles[responsibility], route);
    assert.equal(configured.requiresNextTurn, true);
  }

  const shown = await tool.execute({ action: "show" }, execution);
  assert.deepEqual(shown.roles, mappings);
  assert.equal(shown.requiresNextTurn, false);
  assert.match(tool.output.render({}, shown)[0].text, /planner: provider-a\/model-plan \(reasoningEffort=high, maxTokens=2048\)/u);
  assert.equal(events.filter((event) => event.type === "odai/routing-configured").length, 3);

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
