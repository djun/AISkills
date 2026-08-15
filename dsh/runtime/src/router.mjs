export const HIGH_IMPACT_PLANNER_REASON = "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE";

const RESPONSIBILITY_LABELS = Object.freeze({
  planner: "规划",
  executor: "执行",
  reviewer: "验收",
});

const PLANNER_PATTERNS = [
  /独立(?:判断|规划|分析|决定|决策)/iu,
  /比较(?:一下)?(?:方案|路线|架构)/iu,
  /架构选型/iu,
  /先(?:判断|规划)(?:路线|方案)/iu,
  /second opinion (?:on|for) (?:the )?(?:plan|approach|architecture)/iu,
  /compare (?:the )?(?:approaches|options|architectures)/iu,
  /architecture decision/iu,
  /(?:independently decide|independent decision)/iu,
];

const REVIEWER_PATTERNS = [
  /独立(?:审查|复核|评审)/iu,
  /(?:代码|安全|变更)(?:审查|复核|评审)/iu,
  /code review/iu,
  /security review/iu,
  /independent review/iu,
  /challenge (?:the )?(?:plan|implementation|result)/iu,
];

const RISK_PATTERNS = [
  /(?:高风险|安全|权限|删除|迁移|发布|生产环境)/iu,
  /(?:支付|付款|结算|扣款|退款|订单)[^。！？\n]{0,60}(?:提供方|服务|接口|请求|结果|状态|超时|重试|金额|交易|配置|回调|不稳定)/iu,
  /(?:high[- ]risk|security|permission|delete|migration|production)/iu,
  /(?:checkout|payment|billing|charge|refund)[^.!?\n]{0,80}(?:provider|service|request|result|status|timeout|retry|transaction|configuration|unstable|fail|超时|重试|不稳定)/iu,
];

const UNVERIFIED_CAUSAL_PATTERNS = [
  /(?:我看|看起来|看来|估计|大概|八成|明显|肯定)(?:就)?是/iu,
  /(?:问题|原因|根因)(?:应该|可能|大概|估计)(?:就)?在/iu,
  /\b(?:it\s+)?(?:looks?|seems)\s+like\b/iu,
  /\b(?:i think|probably|apparently|clearly|obviously)\b[^.!?\n]{0,80}\b(?:is|are|because|caused by|comes from)\b/iu,
];

const CONCRETE_CHANGE_PATTERNS = [
  /把[^。！？\n]{1,120}(?:降到|提到|提高到|改成|设为|设置为|切到|换成|开启|关闭|删除|清空|迁移到|发布到|上线)/iu,
  /(?:降低|提高|增加|减少|修改|设置|开启|关闭|删除|清空|迁移|发布|上线)[^。！？\n]{0,80}(?:\d|配置|超时|重试|权限|数据|服务)/iu,
  /\b(?:set|change|reduce|lower|increase|raise|disable|enable|delete|drop|clear|migrate|deploy|release)\b[^.!?\n]{0,100}\b(?:to|from|timeout|retries|permission|data|service|production)\b/iu,
];

const SPECIFIC_PARAMETER_PATTERNS = [
  /\d+(?:\.\d+)?\s*(?:毫秒|秒|分钟|小时|次|%|％|ms|sec(?:ond)?s?|min(?:ute)?s?|hours?|retries?|mb|gb)/iu,
];

const URGENCY_PATTERNS = [
  /(?:先止血|立即|马上|赶紧|紧急|热修)/iu,
  /\b(?:hotfix|immediately|right away|stop the bleeding)\b/iu,
];

const IRREVERSIBLE_ACTION_PATTERNS = [
  /(?:删除|清空|迁移|发布|上线|关闭)/iu,
  /\b(?:delete|drop|clear|migrate|deploy|release|disable)\b/iu,
];

const CONTINUATION_PATTERNS = [
  /(?:继续|接着|进一步|深入|再(?:判断|分析|评估|检查|处理)|按(?:照)?(?:刚才|上面|上述|前面|这个|该)|那就|就按)/iu,
  /\b(?:continue|proceed|go ahead|follow up|dig deeper|based on (?:that|the previous|the above))\b/iu,
];

const LOW_RISK_TRANSFORM_PATTERNS = [
  /(?:重述|总结|概括|压缩|翻译|改写|润色|格式化|解释(?:一下)?)/iu,
  /\b(?:restate|summari[sz]e|translate|shorten|rewrite|format|explain)\b/iu,
];

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function stripQuotedMaterial(text) {
  return text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/^\s*>.*$/gmu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|《[^》\n]*》|"[^"\n]*"/gu, " ");
}

function hasContextualPlannerGap(text) {
  return matchesAny(text, RISK_PATTERNS)
    && matchesAny(text, UNVERIFIED_CAUSAL_PATTERNS)
    && matchesAny(text, CONCRETE_CHANGE_PATTERNS)
    && (matchesAny(text, SPECIFIC_PARAMETER_PATTERNS)
      || matchesAny(text, URGENCY_PATTERNS)
      || matchesAny(text, IRREVERSIBLE_ACTION_PATTERNS));
}

function isLowRiskTransform(text) {
  return matchesAny(stripQuotedMaterial(text), LOW_RISK_TRANSFORM_PATTERNS);
}

function genuineUserText(message) {
  if (message?.role !== "user" || message?.source?.kind !== "user" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function genuineUserTexts(messages, sessionEvents = []) {
  const candidates = [
    ...(Array.isArray(messages) ? [...messages].reverse() : []),
    ...(Array.isArray(sessionEvents)
      ? [...sessionEvents].reverse()
        .filter((event) => event?.type === "user/message")
        .map((event) => event.data)
      : []),
  ];
  const seen = new Set();
  const texts = [];
  for (const message of candidates) {
    const text = genuineUserText(message);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
  }
  return texts;
}

function route(role, reasonCode, reason, signals, action = role === "controller" ? "direct" : "delegate", targetRole) {
  return Object.freeze({
    role,
    mode: action,
    action,
    ...(targetRole === undefined ? {} : { targetRole }),
    reasonCode,
    reason,
    signals: Object.freeze([...new Set(signals)]),
  });
}

/**
 * Choose the smallest useful odai role. Risk alone never creates another role.
 * Executor routing requires a frozen route card and observable net benefit;
 * those facts cannot be inferred from task prose.
 */
export function decideRoute(input = {}) {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const explicitIntentText = stripQuotedMaterial(text);
  const signals = [];
  const riskPresent = matchesAny(text, RISK_PATTERNS);
  const unverifiedCausalClaim = matchesAny(text, UNVERIFIED_CAUSAL_PATTERNS);
  const concreteChangeRequest = matchesAny(text, CONCRETE_CHANGE_PATTERNS);
  const specificOperationalParameter = matchesAny(text, SPECIFIC_PARAMETER_PATTERNS);
  const urgencyPressure = matchesAny(text, URGENCY_PATTERNS);
  const irreversibleAction = matchesAny(text, IRREVERSIBLE_ACTION_PATTERNS);

  if (riskPresent) signals.push("risk-present");
  if (unverifiedCausalClaim) signals.push("unverified-causal-claim");
  if (concreteChangeRequest) signals.push("concrete-change-request");
  if (specificOperationalParameter) signals.push("specific-operational-parameter");
  if (urgencyPressure) signals.push("urgency-pressure");
  if (irreversibleAction) signals.push("irreversible-action");

  if (input.routeCard?.frozen === true && input.routeCard?.observableBenefit === true) {
    signals.push("route-card-frozen", "observable-net-benefit");
    return route(
      "executor",
      "EXECUTOR_FROZEN_ROUTE_NET_BENEFIT",
      "A frozen route card exists and executor delegation has an observable net benefit.",
      signals,
    );
  }

  if (matchesAny(explicitIntentText, REVIEWER_PATTERNS)) {
    signals.push("explicit-independent-review-gap");
    return route(
      "reviewer",
      "REVIEWER_EXPLICIT_ACCEPTANCE_GAP",
      "The request explicitly asks for an independent review or challenge.",
      signals,
    );
  }

  if (matchesAny(explicitIntentText, PLANNER_PATTERNS)) {
    signals.push("explicit-independent-decision-gap");
    return route(
      "planner",
      "PLANNER_EXPLICIT_DECISION_GAP",
      "The request explicitly asks for an independent plan or architecture decision.",
      signals,
    );
  }

  const contextualPlannerGap = riskPresent
    && unverifiedCausalClaim
    && concreteChangeRequest
    && (specificOperationalParameter || urgencyPressure || irreversibleAction);
  if (contextualPlannerGap) {
    return route(
      "controller",
      HIGH_IMPACT_PLANNER_REASON,
      "An unverified causal claim is being used to justify a concrete high-impact change, so the controller needs a stronger decision route.",
      signals,
      "upgrade",
      "planner",
    );
  }

  signals.push("no-independent-gap");
  return route(
    "controller",
    "DIRECT_DEFAULT_NO_INDEPENDENT_GAP",
    "No explicit independent decision, execution, or acceptance gap was found.",
    signals,
  );
}

export function extractLatestUserText(messages) {
  return genuineUserTexts(messages)[0] ?? "";
}

export function extractRoutingText(messages, sessionEvents) {
  const texts = genuineUserTexts(messages, sessionEvents);
  const latest = texts[0] ?? "";
  if (!latest
    || hasContextualPlannerGap(latest)
    || !matchesAny(stripQuotedMaterial(latest), CONTINUATION_PATTERNS)
    || isLowRiskTransform(latest)) {
    return latest;
  }

  let referencedHighImpact;
  for (const text of texts.slice(1)) {
    if (hasContextualPlannerGap(text)) {
      referencedHighImpact = text;
      break;
    }
    if (!isLowRiskTransform(text)) break;
  }
  if (!referencedHighImpact) return latest;
  return `${latest}\n\nReferenced earlier high-impact user context:\n${referencedHighImpact}`;
}

export function requiresFailClosedProtection(decision) {
  if (decision?.reasonCode === HIGH_IMPACT_PLANNER_REASON) return true;

  const decisionRole = decision?.targetRole ?? decision?.role;
  if (!["planner", "executor", "reviewer"].includes(decisionRole)) return false;

  const signals = new Set(Array.isArray(decision.signals) ? decision.signals : []);
  if (!signals.has("risk-present")) return false;
  return signals.has("irreversible-action")
    || (signals.has("concrete-change-request")
      && (signals.has("specific-operational-parameter") || signals.has("urgency-pressure")));
}

function observeProtocol(decision) {
  const shared = [
    "Observe-mode controller protocol:",
    "- No independent role was run. Do not claim independent planning or review.",
    "- Perform the missing responsibility locally: separate facts from assumptions, inspect decisive project evidence, and state what remains unverified.",
    "- Ground the path in capabilities and evidence that actually exist. Treat unavailable environments, tools, owners, thresholds, and protections as missing conditions, not facts.",
    "- End with concrete evidence-gathering steps and explicit decision criteria that let the user safely continue; objection alone is not a complete delivery.",
  ];
  if (!requiresFailClosedProtection(decision)) return shared;

  return [
    ...shared,
    "- High-impact fail-closed boundary: do not implement, persist, or publish the requested change in this turn. Use read-only evidence only.",
    "- Explain the protection-chain gap and keep the current state unchanged until the decision basis and end-to-end safety dependency are verified.",
  ];
}

export function renderRouteNotice(decision, runtimeMode, actualRoute) {
  const routeRole = decision.targetRole ?? decision.role;
  const isUpgrade = decision.action === "upgrade" && runtimeMode === "auto";
  const action = isUpgrade
    ? "The current controller turn requested an in-place upgrade; no child was started."
    : runtimeMode === "observe"
      ? `The ${routeRole} gap was selected in observe mode; do not start a child automatically.`
      : `The ${routeRole} route was selected and executed as an independent child.`;
  const routeIdentity = actualRoute
    ? [`${isUpgrade ? "requested controller route" : "verified child route"}: ${actualRoute.provider}/${actualRoute.model} (reasoning: ${actualRoute.reasoningEffort ?? "unspecified"})`]
    : [];

  return [
    "odai automatic routing decision",
    `role: ${decision.role}`,
    `action: ${isUpgrade ? "upgrade" : decision.action}`,
    ...(decision.targetRole ? [`target responsibility: ${decision.targetRole}`] : []),
    `reason: ${decision.reasonCode}`,
    `runtime: ${runtimeMode}`,
    action,
    ...routeIdentity,
    ...(runtimeMode === "observe" ? ["", ...observeProtocol(decision)] : []),
  ].join("\n");
}

export function renderMissingRouteConfigNotice(decision, runtimeMode, configFailure) {
  const routeRole = decision.targetRole ?? decision.role;
  const naturalRole = RESPONSIBILITY_LABELS[routeRole] ?? routeRole;
  const invalidConfig = typeof configFailure === "string" && configFailure !== "";
  return [
    `odai routing capability is ${invalidConfig ? "invalid" : "not configured"}`,
    `required responsibility: ${routeRole}`,
    `runtime: ${runtimeMode}`,
    `${invalidConfig ? "untrusted" : "missing"} responsibility mapping: ${routeRole}`,
    ...(invalidConfig ? [`configuration error: ${configFailure}`] : []),
    `No ${routeRole} model was called. Do not claim that this responsibility ran or that the controller was upgraded.`,
    `Tell the user that the required ${routeRole} model is ${invalidConfig ? "unavailable because its saved configuration is invalid" : "not configured"}. Ask them to name the provider, model, and optional reasoning effort in natural language.`,
    `Example: “把${naturalRole}模型设为 <provider>/<model>，推理档设为 <effort>。”`,
    `When the user specifies that mapping, call the odai_routing_config tool to ${invalidConfig ? "repair and " : ""}persist it. Do not ask the user to edit YAML or JSON, run a command, or add routing terminology to future task prompts.`,

    ...(requiresFailClosedProtection(decision) ? [
      "High-impact fail-closed protection is active for this turn.",
      "Do not implement, persist, or publish the requested change. Use read-only evidence only until the missing responsibility is configured or the decision gap is otherwise resolved.",
    ] : [
      "Continue only with parts that do not depend on the missing independent responsibility.",
    ]),
  ].join("\n");
}

export function renderRouteFailureNotice(decision, failure) {
  if (!requiresFailClosedProtection(decision)) {
    return `odai ${decision.role} route failed (${failure}); continue directly as controller and do not claim delegated evidence.`;
  }

  return [
    `odai ${decision.role} route failed (${failure}); no independent evidence was obtained.`,
    "High-impact fail-closed protection is active for this turn.",
    "Do not implement, persist, or publish the requested change. Use read-only evidence only.",
    "Ground the path in capabilities and evidence that actually exist. Treat unavailable environments, tools, owners, thresholds, and protections as missing conditions, not facts.",
    "Explain the unresolved decision-evidence and protection-chain gaps, then provide concrete evidence-gathering steps and explicit decision criteria. Objection alone is not a complete delivery.",
  ].join("\n");
}

export function renderDelegationPrompt(decision, taskText, roleContract) {
  if (typeof roleContract !== "string" || roleContract.trim() === "") {
    throw new TypeError(`canonical ${decision.role} role contract must be a non-empty string`);
  }

  return [
    `You are the odai ${decision.role}.`,
    roleContract.trim(),
    "Runtime boundary: do not edit files, run shell commands, ask the user, or delegate further. The controller owns all final decisions and delivery.",
    "Context boundary: this is a bounded task and evidence packet, not an inherited controller transcript. Use only the supplied contract, task, evidence, and source pointers; do not request or reconstruct the controller's full history.",
    "",
    "Task:",
    taskText,
  ].join("\n");
}
