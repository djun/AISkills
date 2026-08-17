export const HIGH_IMPACT_PLANNER_REASON = "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE";
export const RESEARCHER_EVIDENCE_REASON = "RESEARCHER_MULTI_SOURCE_DECISION_EVIDENCE";
export const FRONTEND_SPECIALIST_REASON = "FRONTEND_SUBSTANTIAL_INTERFACE_WORK";
export const EXECUTOR_ROUTE_CARD_REASON = "EXECUTOR_FROZEN_ROUTE_NET_BENEFIT";

const RESPONSIBILITY_LABELS = Object.freeze({
  researcher: "多源事实调查",
  planner: "规划",
  executor: "执行",
  reviewer: "验收",
  frontend: "前端设计与制作",
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
  /(?:继续|接着|进一步|深入|再(?:判断|分析|评估|检查|处理)|按(?:照)?(?:刚才|上面|上述|前面|这个|该)|那就|就按|能做不|能不能做|可以做不|可以做吗)/iu,
  /\b(?:continue|proceed|go ahead|follow up|dig deeper|based on (?:that|the previous|the above)|can you (?:do|handle|implement) (?:it|that))\b/iu,
];

const LOW_RISK_TRANSFORM_PATTERNS = [
  /(?:重述|总结|概括|压缩|翻译|改写|润色|格式化|解释(?:一下)?)/iu,
  /\b(?:restate|summari[sz]e|translate|shorten|rewrite|format|explain)\b/iu,
];

const EXPLICIT_EXECUTION_CONTINUATION_PATTERNS = [
  /(?:继续|接着|就按|按(?:照)?(?:(?:这个|该|上述|上面|前面|刚才)的?)?(?:方案|计划|卡片))/iu,
  /\b(?:continue|proceed|go ahead|follow the plan)\b/iu,
];
const EXECUTION_ACTION_PATTERNS = [
  /(?:开始|执行|实施|落实|动手)/iu,
  /\b(?:start|execute|implement|apply)\b/iu,
];
const ROUTE_CARD_REFERENCE_PATTERNS = [
  /(?:(?:这个|该|上述|上面|前面|刚才)的?(?:方案|计划|卡片|实现|改动|工作))/iu,
  /\b(?:(?:this|that|the|above|previous)\s+(?:plan|proposal|route card|implementation|change)|(?:it|that))\b/iu,
];
const NEW_TASK_PATTERNS = [
  /(?:另一个|另一项|另一件|另外(?:一个|一项|一件)?|新(?:的)?(?:问题|任务|需求|工作))/iu,
  /\b(?:another|a new|new task|new issue|different task|separate task)\b/iu,
];

const FRONTEND_SCOPE_PATTERNS = [
  /(?:前端|界面|页面|网页|网站|着陆页|应用界面|仪表盘|控制台|组件|交互界面|移动端|桌面端|游戏界面|3D场景)/iu,
  /\b(?:front[- ]?end|ui|ux|interface|web(?:site| app)?|landing page|page|dashboard|component|mobile|desktop|game ui|3d scene)\b/iu,
];
const FRONTEND_DELIVERY_PATTERNS = [
  /(?:设计|制作|实现|开发|构建|创建|搭建|改版|重做|重构|优化|美化|修复)/iu,
  /\b(?:design|build|implement|develop|create|craft|redesign|revamp|rework|optimi[sz]e|fix)\b/iu,
];
const FRONTEND_STRONG_WORK_PATTERNS = [
  /(?:从零|新建|新做|整页|整站|整体改版|完整界面|设计并实现|重新设计|重做|改版|搭建)/iu,
  /\b(?:build|create|design and implement|redesign|revamp|rebuild)\b[^.!?\n]{0,60}\b(?:ui|interface|page|website|web app|dashboard|component|game)\b/iu,
];
const FRONTEND_SURFACE_PATTERNS = [
  /登录(?:页|页面)/iu,
  /(?:登录后)?首页/iu,
  /(?:个人空间|个人中心|用户中心|个人主页)/iu,
  /(?:注册|设置|搜索|列表|详情|结算|支付)(?:页|页面)/iu,
  /\b(?:login page|home page|profile|personal space|settings page|search page|list page|detail page|checkout page)\b/iu,
];
const FRONTEND_NON_UI_PATTERNS = [
  /(?:API|接口)(?:调用|请求|响应|超时|缓存|鉴权|数据|字段|契约)/iu,
  /\b(?:api|endpoint|backend|server-side)\b/iu,
];
const FRONTEND_UI_PRODUCTION_PATTERNS = [
  /(?:UI|UX|用户界面|界面介绍|布局|样式|排版|配色|交互|视觉|响应式|移动端|桌面端|截图|浏览器验收)/iu,
  /\b(?:ui|ux|interface|layout|styling|typography|interaction|visual|responsive|mobile|desktop|screenshot|browser acceptance)\b/iu,
];
const FRONTEND_EXPLICIT_SPECIALIST_PATTERNS = [
  /(?:交给|使用|用)[^。！？\n]{0,30}(?:前端|UI|UX)(?:专长|专家|模型)/iu,
  /\b(?:use|with|via)\b[^.!?\n]{0,30}\b(?:front[- ]?end|ui|ux) (?:specialist|expert|model)\b/iu,
];
const FRONTEND_AXIS_PATTERNS = Object.freeze({
  responsive: [/(?:响应式|移动端|桌面端|多端|窄屏|宽屏|视口)/iu, /\b(?:responsive|mobile|desktop|viewport|breakpoint)\b/iu],
  interaction: [/(?:交互|动效|动画|拖拽|手势|状态流转|多状态)/iu, /\b(?:interaction|animation|motion|drag|gesture|state flow|multiple states)\b/iu],
  visual: [/(?:视觉|品牌|排版|配色|设计系统|素材|图片|图标|3D|游戏界面)/iu, /\b(?:visual|brand|typography|palette|design system|asset|image|icon|3d|game ui)\b/iu],
  comprehension: [/(?:一眼(?:就)?(?:看懂|明白|理解)|做什么|首屏认知|价值表达|信息架构|界面介绍)/iu, /\b(?:understand at a glance|first-screen comprehension|value proposition|information architecture|what (?:it|the product) does)\b/iu],
  acceptance: [/(?:截图|浏览器验收|视觉验收|无障碍|Playwright|真机)/iu, /\b(?:screenshot|browser acceptance|visual acceptance|accessibility|playwright|device testing)\b/iu],
});

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

function isExecutionContinuation(text) {
  if (matchesAny(text, NEW_TASK_PATTERNS)) return false;
  if (matchesAny(text, EXPLICIT_EXECUTION_CONTINUATION_PATTERNS)) return true;
  return matchesAny(text, EXECUTION_ACTION_PATTERNS)
    && matchesAny(text, ROUTE_CARD_REFERENCE_PATTERNS);
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

function frontendSpecializationSignals(text) {
  const explicit = matchesAny(text, FRONTEND_EXPLICIT_SPECIALIST_PATTERNS);
  const surfaceCount = FRONTEND_SURFACE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const explicitScope = matchesAny(text, FRONTEND_SCOPE_PATTERNS);
  const scope = surfaceCount > 0 || explicitScope;
  const delivery = matchesAny(text, FRONTEND_DELIVERY_PATTERNS);
  const strongWork = matchesAny(text, FRONTEND_STRONG_WORK_PATTERNS);
  const axes = Object.entries(FRONTEND_AXIS_PATTERNS)
    .filter(([, patterns]) => matchesAny(text, patterns))
    .map(([axis]) => axis);
  const nonUiRequest = matchesAny(text, FRONTEND_NON_UI_PATTERNS)
    && !matchesAny(text, FRONTEND_UI_PRODUCTION_PATTERNS);
  const specialistDepth = explicit
    || strongWork
    || axes.length >= 2
    || (surfaceCount >= 2 && (explicitScope || axes.length >= 1));
  return Object.freeze({
    explicit,
    scope,
    delivery,
    strongWork,
    nonUiRequest,
    specialistDepth,
    surfaceCount,
    axes: Object.freeze(axes),
    substantial: scope && delivery && specialistDepth && !nonUiRequest,
  });
}

function frontendRouteSignals(frontend) {
  return [
    ...(frontend.scope ? ["frontend-interface-scope"] : []),
    ...(frontend.delivery ? ["frontend-delivery-request"] : []),
    ...(frontend.explicit ? ["explicit-frontend-specialist"] : []),
    ...(frontend.strongWork ? ["substantial-frontend-work"] : []),
    ...(frontend.surfaceCount >= 2 ? ["frontend-multi-surface"] : []),
    ...frontend.axes.map((axis) => `frontend-${axis}`),
  ];
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

export function decideResearchPrefetch(input = {}) {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const explicitIntentText = stripQuotedMaterial(text);
  if (!explicitIntentText || isLowRiskTransform(explicitIntentText)) {
    return route("controller", "RESEARCHER_PREFETCH_NOT_NEEDED", "No separable multi-source evidence compression gap was found.", ["no-research-prefetch"]);
  }
  if (!hasContextualPlannerGap(explicitIntentText)) {
    return route("controller", "RESEARCHER_PREFETCH_NOT_NEEDED", "No separable multi-source evidence compression gap was found.", ["no-research-prefetch"]);
  }
  const signals = [
    "decision-blocking-causal-claim",
    "high-impact-change",
    "bounded-evidence-compression",
  ];
  return route(
    "researcher",
    RESEARCHER_EVIDENCE_REASON,
    "A bounded read-only pass over multiple decisive sources can reduce downstream context while preserving provenance.",
    signals,
  );
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
  const frontend = frontendSpecializationSignals(explicitIntentText);

  if (riskPresent) signals.push("risk-present");
  if (unverifiedCausalClaim) signals.push("unverified-causal-claim");
  if (concreteChangeRequest) signals.push("concrete-change-request");
  if (specificOperationalParameter) signals.push("specific-operational-parameter");
  if (urgencyPressure) signals.push("urgency-pressure");
  if (irreversibleAction) signals.push("irreversible-action");

  if (input.routeCard?.frozen === true
    && input.routeCard?.observableBenefit === true
    && isExecutionContinuation(explicitIntentText)) {
    signals.push("route-card-frozen", "observable-net-benefit", "explicit-execution-continuation");
    return route(
      "controller",
      EXECUTOR_ROUTE_CARD_REASON,
      "A frozen route card exists, executor separation has an observable net benefit, and the user explicitly continued implementation.",
      signals,
      "upgrade",
      "executor",
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
      "controller",
      "PLANNER_EXPLICIT_DECISION_GAP",
      "The request explicitly asks for a planning or architecture decision that needs the current controller context.",
      signals,
      "upgrade",
      "planner",
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

  const frontendSignals = frontend.scope || frontend.explicit ? frontendRouteSignals(frontend) : [];
  if (frontend.substantial && !isLowRiskTransform(explicitIntentText)) {
    signals.push(...frontendSignals);
    return route(
      "controller",
      FRONTEND_SPECIALIST_REASON,
      "Substantial user-facing interface work can benefit from a configured frontend specialist without a child handoff.",
      signals,
      "upgrade",
      "frontend",
    );
  }

  signals.push(...frontendSignals, "no-independent-gap");
  const direct = route(
    "controller",
    "DIRECT_DEFAULT_NO_INDEPENDENT_GAP",
    "No explicit independent decision, execution, or acceptance gap was found.",
    signals,
  );
  if (frontendSignals.length === 0) return direct;
  const lowRiskTransform = isLowRiskTransform(explicitIntentText);
  return Object.freeze({
    ...direct,
    considerations: Object.freeze([Object.freeze({
      role: "frontend",
      match: "partial",
      action: "skip",
      reasonCode: frontend.nonUiRequest
        ? "FRONTEND_API_REQUEST"
        : lowRiskTransform
          ? "FRONTEND_LOW_RISK_TRANSFORM"
          : "FRONTEND_BELOW_SPECIALIST_THRESHOLD",
      signals: Object.freeze(frontendSignals),
      unmet: Object.freeze(frontend.nonUiRequest
        ? ["ui-production-request"]
        : [
            ...(frontend.scope ? [] : ["interface-scope"]),
            ...(frontend.delivery ? [] : ["delivery-request"]),
            ...(frontend.specialistDepth ? [] : ["specialist-or-substantial-scope"]),
          ]),
    })]),
  });
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
  let referencedFrontend;
  for (const text of texts.slice(1)) {
    if (hasContextualPlannerGap(text)) {
      referencedHighImpact = text;
      break;
    }
    const frontend = frontendSpecializationSignals(stripQuotedMaterial(text));
    if (frontend.scope && frontend.delivery) {
      referencedFrontend = text;
      break;
    }
    if (!isLowRiskTransform(text)) break;
  }
  if (referencedHighImpact) {
    return `${latest}\n\nReferenced earlier high-impact user context:\n${referencedHighImpact}`;
  }
  if (referencedFrontend) {
    return `${latest}\n\nReferenced earlier frontend user context:\n${referencedFrontend}`;
  }
  return latest;
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
  const isUpgrade = decision.action === "upgrade"
    && (runtimeMode === "auto" || ["executor", "frontend"].includes(routeRole));
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
  const routeRole = decision.targetRole ?? decision.role;
  if (!requiresFailClosedProtection(decision)) {
    return `odai ${routeRole} route failed (${failure}); continue directly as controller and do not claim delegated evidence.`;
  }

  return [
    `odai ${routeRole} route failed (${failure}); no independent evidence was obtained.`,
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
