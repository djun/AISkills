import assert from "node:assert/strict";
import test from "node:test";

import {
  decideRoute,
  extractLatestUserText,
  extractRoutingText,
  renderDelegationPrompt,
  renderMissingRouteConfigNotice,
  renderRouteFailureNotice,
  renderRouteNotice,
  requiresFailClosedProtection,
} from "../src/router.mjs";

test("direct is the default even when risk is present", () => {
  const decision = decideRoute({ text: "这是一次高风险生产迁移，请帮我实现" });
  assert.equal(decision.role, "controller");
  assert.equal(decision.reasonCode, "DIRECT_DEFAULT_NO_INDEPENDENT_GAP");
  assert.deepEqual(decision.signals, ["risk-present", "irreversible-action", "no-independent-gap"]);
});

test("explicit independent decision gap routes to planner", () => {
  const decision = decideRoute({ text: "请独立规划一下这次架构选型，再给我建议" });
  assert.equal(decision.role, "planner");
  assert.equal(decision.action, "delegate");
  assert.equal(decision.reasonCode, "PLANNER_EXPLICIT_DECISION_GAP");
  assert.equal(decideRoute({ text: "请替我独立决定是否删除生产数据" }).role, "planner");
});

test("quoted role language does not create an independent gap", () => {
  const cases = [
    "请把 README 中“请独立规划一下架构选型”这句话改短",
    "把 `architecture decision` 改成 decision",
    "将下面引用改短：\n> 请独立审查这个架构方案",
    "把代码块里的提示词改成小写：\n```text\nindependent review\n```",
  ];
  for (const text of cases) {
    assert.equal(decideRoute({ text }).role, "controller", text);
  }
});

test("explicit review gap routes to reviewer before planner", () => {
  const decision = decideRoute({ text: "请独立审查这个架构方案并 challenge the plan" });
  assert.equal(decision.role, "reviewer");
  assert.equal(decision.reasonCode, "REVIEWER_EXPLICIT_ACCEPTANCE_GAP");
});

test("unverified causal claim plus concrete high-impact change upgrades the controller", () => {
  const decision = decideRoute({
    text: "checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。",
  });
  assert.equal(decision.role, "controller");
  assert.equal(decision.action, "upgrade");
  assert.equal(decision.targetRole, "planner");
  assert.equal(decision.reasonCode, "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE");
  assert.deepEqual(decision.signals, [
    "risk-present",
    "unverified-causal-claim",
    "concrete-change-request",
    "specific-operational-parameter",
    "urgency-pressure",
  ]);
});

test("contextual planner gap works without C04-specific wording", () => {
  const decision = decideRoute({
    text: "It looks like the billing provider is unstable. Reduce the client timeout to 3 seconds and increase retries to 3 as a hotfix.",
  });
  assert.equal(decision.role, "controller");
  assert.equal(decision.action, "upgrade");
  assert.equal(decision.targetRole, "planner");
  assert.equal(decision.reasonCode, "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE");
});

test("high-impact observe and route failure notices require a read-only decision path", () => {
  const decision = decideRoute({
    text: "checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。",
  });
  assert.equal(requiresFailClosedProtection(decision), true);

  const observe = renderRouteNotice(decision, "observe");
  assert.match(observe, /No independent role was run/u);
  assert.match(observe, /concrete evidence-gathering steps and explicit decision criteria/u);
  assert.match(observe, /do not implement, persist, or publish/u);
  assert.match(observe, /Use read-only evidence only/u);
  assert.match(observe, /unavailable environments, tools, owners, thresholds, and protections as missing conditions/u);

  const upgrade = renderRouteNotice(decision, "auto", {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  assert.match(upgrade, /action: upgrade/u);
  assert.match(upgrade, /no child was started/u);
  assert.match(upgrade, /requested controller route: openai\/gpt-5\.6-sol/u);

  const failure = renderRouteFailureNotice(decision, "provider unavailable");
  assert.match(failure, /High-impact fail-closed protection is active/u);
  assert.match(failure, /provider unavailable/u);
  assert.doesNotMatch(failure, /continue directly/u);

  const explicitHighImpact = decideRoute({ text: "请独立规划这次生产发布，审批已经完成，按方案上线。" });
  assert.equal(explicitHighImpact.reasonCode, "PLANNER_EXPLICIT_DECISION_GAP");
  assert.equal(requiresFailClosedProtection(explicitHighImpact), true);
  assert.doesNotMatch(renderRouteFailureNotice(explicitHighImpact, "provider unavailable"), /continue directly/u);

  const explicit = decideRoute({ text: "请独立规划一下架构方案" });
  assert.equal(requiresFailClosedProtection(explicit), false);
  assert.match(renderRouteFailureNotice(explicit, "provider unavailable"), /continue directly/u);
});

test("every missing responsibility asks for a natural-language model choice", () => {
  for (const role of ["planner", "executor", "reviewer"]) {
    const notice = renderMissingRouteConfigNotice({
      role,
      action: "delegate",
      reasonCode: `${role.toUpperCase()}_TEST_GAP`,
      signals: [],
    }, "auto");
    assert.match(notice, new RegExp(`required responsibility: ${role}`, "u"));
    assert.match(notice, /Ask them to name the provider, model, and optional reasoning effort in natural language/u);
    assert.match(notice, /call the odai_routing_config tool/u);
    assert.doesNotMatch(notice, /routing:\n/u);
    assert.match(notice, /Do not ask the user to edit YAML or JSON, run a command/u);
  }

  const protectedNotice = renderMissingRouteConfigNotice(decideRoute({
    text: "checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。",
  }), "auto");
  assert.match(protectedNotice, /High-impact fail-closed protection is active/u);

  for (const role of ["executor", "reviewer"]) {
    assert.match(renderMissingRouteConfigNotice({
      role,
      action: "delegate",
      reasonCode: `${role.toUpperCase()}_HIGH_IMPACT_GAP`,
      signals: ["risk-present", "irreversible-action"],
    }, "execute"), /High-impact fail-closed protection is active/u);
  }
});

test("contextual signals do not delegate unless the complete planner gap exists", () => {
  const cases = [
    "这是一次高风险生产迁移，审批和路线已经冻结，请按文档实现。",
    "我看就是支付方不稳定，先帮我查日志和提供方说明。",
    "我看就是按钮颜色太淡，把灰色改成黑色。",
    "我看就是支付按钮太小。把宽度改成 44px，马上修。",
    "提供方 SLO 已确认 8 秒超时，请把生产配置从 6 秒设为 8 秒。",
  ];
  for (const text of cases) {
    assert.equal(decideRoute({ text }).role, "controller", text);
  }
});

test("executor requires a frozen route card and observable benefit", () => {
  assert.equal(decideRoute({
    text: "请执行这个方案",
    routeCard: { frozen: true, observableBenefit: false },
  }).role, "controller");

  assert.equal(decideRoute({
    text: "请执行这个方案",
    routeCard: { frozen: true, observableBenefit: true },
  }).role, "executor");
});

test("latest genuine user text ignores plugin notices", () => {
  const messages = [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "real task" }] },
    { role: "user", source: { kind: "plugin", plugin: "x" }, content: [{ type: "text", text: "notice" }] },
  ];
  assert.equal(extractLatestUserText(messages), "real task");
});

test("routing text inherits referenced high-impact context but keeps low-risk transforms direct", () => {
  const highImpact = "线上退款偶尔重复入账，我看就是确认超时太短。把确认超时改成 30 秒、最多重试 3 次。";
  const user = (text) => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
  const sessionEvents = [
    { type: "user/message", data: user(highImpact) },
    { type: "assistant/message", data: { role: "assistant", content: [{ type: "text", text: "不能直接执行。" }] } },
    { type: "user/message", data: user("用一句话重述刚才的结论") },
    { type: "user/message", data: { role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "routing notice" }] } },
  ];

  assert.equal(extractRoutingText([user("把结论压缩成十个汉字以内")], sessionEvents), "把结论压缩成十个汉字以内");

  const continued = extractRoutingText([user("继续深入判断刚才这个迁移是否可以安全发布")], sessionEvents);
  assert.match(continued, /Referenced earlier high-impact user context/u);
  assert.match(continued, /确认超时改成 30 秒/u);
  assert.equal(decideRoute({ text: continued }).action, "upgrade");

  const unrelated = extractRoutingText([user("把普通按钮文案改清楚")], sessionEvents);
  assert.equal(unrelated, "把普通按钮文案改清楚");
  assert.equal(decideRoute({ text: unrelated }).action, "direct");

  const afterNewTask = extractRoutingText(
    [user("继续处理")],
    [...sessionEvents, { type: "user/message", data: user("把普通按钮文案改清楚") }],
  );
  assert.equal(afterNewTask, "继续处理");
  assert.equal(decideRoute({ text: afterNewTask }).action, "direct");
});

test("delegation prompt requires a canonical role contract and bounded context", () => {
  const decision = { role: "planner" };
  assert.throws(() => renderDelegationPrompt(decision, "task"), /canonical planner role contract/u);
  const prompt = renderDelegationPrompt(decision, "task", "Canonical planner body.");
  assert.match(prompt, /Canonical planner body\.[\s\S]*Task:\ntask/u);
  assert.match(prompt, /bounded task and evidence packet, not an inherited controller transcript/u);
  assert.match(prompt, /do not request or reconstruct the controller's full history/u);
});
