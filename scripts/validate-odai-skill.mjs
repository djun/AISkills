#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repoRoot, "skills", "odai");
const failures = [];
const warnings = [];

const skillFile = path.join(skillRoot, "SKILL.md");
if (!existsSync(skillFile)) fail("SKILL.md: missing");
const skillText = readFileSync(skillFile, "utf8");
const entryTokenEstimate = estimateTokens(skillText);
if (entryTokenEstimate > 2200) {
  warn(
    `SKILL.md: entry token estimate ${entryTokenEstimate} exceeds review threshold 2200; ` +
    "review clarity and semantic rent, but do not trim required behavior to satisfy a quota",
  );
}

validateFrontmatter(skillText);
validateConstitution(skillText);
validateBehavioralInvariants();
validateOpenaiMetadata();
validateHookSources();
validateRepositoryAlignment();

const files = listFiles(skillRoot);
const markdownTokenEstimate = files
  .filter((file) => file.endsWith(".md"))
  .reduce((total, file) => total + estimateTokens(readFileSync(path.join(skillRoot, file), "utf8")), 0);
if (markdownTokenEstimate > 12000) {
  warn(
    `skill markdown estimate ${markdownTokenEstimate} exceeds total review threshold 12000; ` +
    "review ownership and duplication, but do not remove useful capability to satisfy a quota",
  );
}

const requiredFiles = [
  "assets/hooks-policy.example.json",
  "assets/task-ledger.md",
  "assets/task-state.md",
  "references/dao/authority.md",
  "references/dao/continuity.md",
  "references/dao/leverage.md",
  "references/dao/verification.md",
  "references/capabilities/design.md",
  "references/capabilities/delivery.md",
  "references/capabilities/documentation.md",
  "references/capabilities/planning.md",
  "references/capabilities/review.md",
  "references/domains/ui-design.md",
  "references/domains/interactive-systems.md",
  "references/techniques/consensus.md",
  "references/techniques/review-modes.md",
  "scripts/build-hooks.mjs",
  "scripts/odai-hook.mjs",
];
for (const relativePath of requiredFiles) {
  if (!files.includes(relativePath)) fail(`${relativePath}: required resource is missing`);
}

const retiredPrefixes = [
  "assets/dao/",
  "references/modules/",
  "references/feature-plan/",
  "references/design-spec/",
  "references/implement-code/",
  "references/review-sslb/",
  "references/game-plan/",
  "references/game-design/",
  "references/recipes/",
];
const retiredFiles = new Set([
  "references/dao/composition.md",
  "references/dao/coordination.md",
  "references/capabilities/diagnose.md",
  "references/capabilities/design-spec.md",
  "references/capabilities/feature-plan.md",
  "references/capabilities/implement-code.md",
  "references/capabilities/review-sslb.md",
  "references/techniques/audit-loop.md",
  "references/techniques/review-full.md",
]);
for (const relativePath of files) {
  if (retiredFiles.has(relativePath) || retiredPrefixes.some((prefix) => relativePath.startsWith(prefix))) {
    fail(`${relativePath}: retired architecture path must not return`);
  }
  if (/references\/techniques\/(?:sdd|tdd|bdd)(?:-|\.)/.test(relativePath)) {
    fail(`${relativePath}: SDD/TDD/BDD must remain optional methods, not first-class technique files`);
  }
}

for (const relativePath of files.filter((file) => file.endsWith(".md"))) {
  const text = readFileSync(path.join(skillRoot, relativePath), "utf8");
  for (const match of text.matchAll(/\b((?:references|assets)\/[A-Za-z0-9_./-]+\.(?:md|mjs|js))\b/g)) {
    const target = match[1];
    const resolved = path.resolve(skillRoot, target);
    if (!isInside(skillRoot, resolved)) fail(`${relativePath}: reference escapes skill root: ${target}`);
    else if (!existsSync(resolved)) fail(`${relativePath}: missing reference target: ${target}`);
  }

  text.split(/\r?\n/).forEach((line, index) => {
    if (line.length > 240) warn(`${relativePath}:${index + 1}: long rule line (${line.length} chars)`);
  });
}

const structureChecks = [
  {
    path: "SKILL.md",
    headings: ["总纲", "五个判断", "根据情况选择力度", "行动前必须守住", "按需读取支撑资料", "完成与说明"],
    anchors: [
      "`事｜实｜法｜成｜界`",
      "**直达**",
      "**纠偏**",
      "**展开**",
      "**守险**",
      "**只答不写**",
      "**参考不是修改对象**",
      "**先确认真实用途**",
      "**共享内容默认保持**",
      "**修改前明确边界**",
      "**不漏关键要求**",
      "既有模板、字段或结构也是验成契约",
      "先交付其余完整可用结果，不得只声称已准备",
      "**根因和手段仍需验证**",
      "**高影响参数先停后查**",
      "references/dao/authority.md",
      "references/dao/continuity.md",
      "references/dao/leverage.md",
      "references/dao/verification.md",
      "references/capabilities/planning.md",
      "references/capabilities/design.md",
      "references/capabilities/delivery.md",
      "references/capabilities/review.md",
      "references/capabilities/documentation.md",
      "references/domains/ui-design.md",
      "references/domains/interactive-systems.md",
      "references/techniques/consensus.md",
      "references/techniques/review-modes.md",
      "`.odai/local.md`",
    ],
  },
  {
    path: "references/dao/authority.md",
    headings: ["事的所有权", "自主与提问", "动作边界", "模糊与感知任务"],
  },
  {
    path: "references/dao/verification.md",
    headings: ["什么算完成", "选择证据", "高影响参数", "状态与结束方式", "继续旧任务"],
    anchors: ["`declared`", "`observed`", "`verified_end_to_end`", "`implemented_unverified`"],
  },
  {
    path: "references/dao/continuity.md",
    headings: ["主状态", "跨任务记忆", "执行账本", "恢复与队列"],
    anchors: ["assets/task-state.md", "assets/task-ledger.md", "`.odai/local.md`"],
  },
  {
    path: "references/dao/leverage.md",
    headings: ["先用已有能力", "再决定是否下放", "改进规则但不擅自改技能"],
    anchors: ["references/dao/continuity.md", "references/techniques/consensus.md", "`.odai/local.md`"],
  },
  {
    path: "references/capabilities/planning.md",
    headings: ["形成决定", "开放项与数值"],
  },
  {
    path: "references/capabilities/design.md",
    headings: ["形成可交接设计"],
    anchors: ["references/domains/ui-design.md", "references/domains/interactive-systems.md"],
  },
  {
    path: "references/capabilities/delivery.md",
    headings: ["先辨因", "再完成结果", "特殊边界"],
  },
  {
    path: "references/capabilities/review.md",
    headings: ["记录问题", "检查范围"],
    anchors: ["references/techniques/review-modes.md"],
  },
  {
    path: "references/capabilities/documentation.md",
    headings: ["先定交付与授权", "取证与裁剪", "日报、更新与变更文案", "项目指南", "完成标准"],
  },
  {
    path: "references/domains/ui-design.md",
    headings: ["先定骨架", "真实性与压力态", "新建、重设计与验收"],
  },
  {
    path: "references/domains/interactive-systems.md",
    headings: ["循环、内容与数值", "界面、反馈与表现", "交付与验收"],
  },
  {
    path: "references/techniques/consensus.md",
    headings: ["组织", "汇总结论"],
  },
  {
    path: "references/techniques/review-modes.md",
    headings: ["连续审查与修复", "正式判断输出"],
  },
  {
    path: "assets/task-state.md",
    headings: ["事与界", "事实与完成", "法"],
  },
  {
    path: "assets/task-ledger.md",
    headings: ["状态口径", "风险与回退"],
  },
];
for (const check of structureChecks) validateStructure(check);

if (warnings.length > 0) {
  console.log("Warnings:");
  for (const warning of warnings) console.log(`- ${warning}`);
}

if (failures.length > 0) {
  console.error("Validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `odai skill is valid (${files.length} files, ${warnings.length} warnings, ` +
    `entry estimate ${entryTokenEstimate} tokens, total markdown estimate ${markdownTokenEstimate} tokens).`,
  );
}

function validateFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return fail("SKILL.md: missing or invalid YAML frontmatter");

  const fields = new Map();
  for (const [index, line] of match[1].split(/\r?\n/).entries()) {
    const field = line.match(/^([a-z0-9-]+):\s*(.*)$/);
    if (!field) {
      fail(`SKILL.md frontmatter line ${index + 2}: expected a top-level key/value`);
      continue;
    }
    fields.set(field[1], unquote(field[2].trim()));
  }

  for (const key of fields.keys()) {
    if (!new Set(["name", "description"]).has(key)) fail(`SKILL.md frontmatter: unexpected key ${key}`);
  }
  const name = fields.get("name") || "";
  const description = fields.get("description") || "";
  if (!/^[a-z0-9-]+$/.test(name)) fail(`SKILL.md frontmatter: invalid name ${JSON.stringify(name)}`);
  if (name !== path.basename(skillRoot)) fail(`SKILL.md frontmatter: name ${name} does not match folder`);
  if (!description) fail("SKILL.md frontmatter: description is required");
  if (description.length > 1024) fail(`SKILL.md frontmatter: description is ${description.length} chars`);
  if (/[<>]/.test(description)) fail("SKILL.md frontmatter: description contains angle brackets");
}

function validateConstitution(text) {
  const section = (text.match(/^## 总纲\r?\n([\s\S]*?)(?=^## )/m)?.[1] || "").replaceAll("\r\n", "\n");
  const fragments = [
    "**事由人定，路由实证；法随势变，成由验定；止于边界，成事而不妄为。**",
    "推进用户定义的事",
    "经验证的可交付结果",
    "主动端出会改变结果的反例",
    "事实、用户决定与底线不可曲",
    "无据不断",
    "无权不越",
    "无必要不造工作",
    "发现不等于获准实施",
  ];
  for (const fragment of fragments) {
    if (!section.includes(fragment)) fail(`SKILL.md: constitutional core missing: ${fragment}`);
  }
}

function validateBehavioralInvariants() {
  const checks = [
    {
      path: "SKILL.md",
      label: "collaborative agency",
      patterns: [
        /授权不是盲从[^。\n]*质疑也不是夺权/,
        /价值取舍由用户决定[^。\n]*事实判断以证据校准[^。\n]*授权内的专业做法由模型自主/,
        /治理资料不能替代专业方法/,
        /仍有明确专业问题时读最相关的交付资料/,
      ],
    },
    {
      path: "SKILL.md",
      label: "observable stop boundary",
      patterns: [
        /\*\*守险\*\*[\s\S]{0,180}条件不足就安全停手/,
        /新证据若会改变目标[^。\n]*停在可撤回位置[^。\n]*由用户决定后继续/,
        /拒绝原值不等于获准另拍数值/,
        /替代数值只能明确标为“待验证的实验候选”[^。\n]*不得建议批准、实施或进入生产/,
        /不得补造材料未提供的实验环境、流量、观察窗口或门槛/,
        /用户坚持原值、再次确认或表示愿意承担风险[^。\n]*不能替代证据或解除停止/,
        /参考不是修改对象[^。\n]*默认只读/,
        /计算结论、区间和端点必须实际复算[^。\n]*离散数量取整后复查边界/,
        /局部结果不得说成全量或真实场景均已通过/,
        /具体对象、输入、位置和通过条件[^。\n]*不得被宽泛说法替代/,
        /完成前逐项核对明确要求[^。\n]*事实、建议和决定不得混淆/,
        /局部未知只阻断依赖它的部分/,
        /每份都要解决一个已说明的问题/,
        /按既有格式整理事实[^。\n]*必须读 .*documentation\.md[^。\n]*不得被摘要替代/,
        /从约束中形成方案、比较路线或提出数值候选时[^。\n]*必须读 .*planning\.md/,
      ],
    },
    {
      path: "references/dao/authority.md",
      label: "two-way evidence correction",
      patterns: [
        /价值取舍与事实判断[^。\n]*前者由用户决定[^。\n]*后者共同查证[^。\n]*证据可以推翻任何一方/,
        /否定、绝对约束或彼此冲突[\s\S]{0,120}由用户决定后再继续/,
        /只读分析、解释、诊断或审查默认不写入/,
        /未指定交付文件[^。\n]*直接回复[^。\n]*新建唯一相关产物/,
        /生产、外部通信、付费、删除、迁移或其他难回退动作[^。\n]*确认具体对象、环境、影响、停止条件和可用退路/,
      ],
    },
    {
      path: "references/dao/verification.md",
      label: "high-impact evidence gate",
      patterns: [
        /`declared`[^。\n]*`observed`[^。\n]*`verified_end_to_end`/,
        /替代数值只能明确标为“待验证的实验候选”[^。\n]*不得建议批准、实施或进入生产/,
        /用户愿意承担风险也不能替代证据/,
        /实验环境、流量边界、观察窗口[^。\n]*只能来自已知材料[^。\n]*不得自行命名或给值/,
        /保护措施证据不足[^。\n]*推进用户原目标[^。\n]*取得什么证据[^。\n]*继续、停止或改选路线/,
        /补证不得假定未证实的环境、权限、工具、数据或责任人存在/,
        /未知条件只能明确写成前提[^。\n]*不能成为唯一可行路径/,
        /未验证内容时[^。\n]*具体场景、输入或位置[^。\n]*复查动作和通过标准/,
        /责任人不明时明确指出[^。\n]*需要认领的动作/,
      ],
    },
    {
      path: "references/dao/leverage.md",
      label: "overlay precedence and limits",
      patterns: [
        /项目规则优先于通用偏好/,
        /不得覆盖宿主和当前用户指令[^。\n]*不得改变 odai 的总纲、必须遵守的门和事实标准/,
        /普通方法冲突时[^。\n]*当前任务事实选择/,
      ],
    },
    {
      path: "references/capabilities/documentation.md",
      label: "stale action continuity",
      patterns: [
        /逾期但无完成证据[^。\n]*保留原责任与日期/,
        /标为待确认或逾期[^。\n]*确认、重排或补负责人 \/ 日期/,
      ],
    },
    {
      path: "references/capabilities/documentation.md",
      label: "blocked-field full draft",
      patterns: [
        /缺值只阻断保存、发送或个别字段[^。\n]*按既有格式交付其余完整正文并保留待补位/,
        /既有格式或模板的结构就是交付契约[^。\n]*沿用标题、日期、分区、必填字段与信息粒度/,
        /不改成普通摘要[^。\n]*不靠删除标题、日期或字段化解缺口/,
      ],
    },
  ];

  for (const check of checks) {
    const file = path.join(skillRoot, check.path);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const pattern of check.patterns) {
      if (!pattern.test(text)) fail(`${check.path}: missing ${check.label}: ${pattern}`);
    }
  }
}

function validateOpenaiMetadata() {
  const openaiFile = path.join(skillRoot, "agents", "openai.yaml");
  if (!existsSync(openaiFile)) return fail("agents/openai.yaml: missing");
  const text = readFileSync(openaiFile, "utf8");
  requireQuotedField(text, "display_name");
  const shortDescription = requireQuotedField(text, "short_description");
  const defaultPrompt = requireQuotedField(text, "default_prompt");
  if (shortDescription && (shortDescription.length < 25 || shortDescription.length > 64)) {
    fail(`agents/openai.yaml: short_description must be 25-64 chars, got ${shortDescription.length}`);
  }
  if (defaultPrompt && !defaultPrompt.includes("$odai")) {
    fail("agents/openai.yaml: default_prompt must mention $odai");
  }
}

function validateHookSources() {
  const policyFile = path.join(skillRoot, "assets", "hooks-policy.example.json");
  const runtimeFile = path.join(skillRoot, "scripts", "odai-hook.mjs");
  const builderFile = path.join(skillRoot, "scripts", "build-hooks.mjs");
  for (const file of [policyFile, runtimeFile, builderFile]) {
    if (!existsSync(file)) fail(`${path.relative(skillRoot, file)}: missing optional hooks source`);
  }
  if (![policyFile, runtimeFile, builderFile].every(existsSync)) return;

  let policy;
  try {
    policy = JSON.parse(readFileSync(policyFile, "utf8"));
  } catch (error) {
    fail(`assets/hooks-policy.example.json: invalid JSON: ${error.message}`);
    return;
  }
  if (policy.version !== 1) fail("assets/hooks-policy.example.json: version must be 1");
  if (!Array.isArray(policy.protectedPaths)) {
    fail("assets/hooks-policy.example.json: protectedPaths must be an array");
  }
  if (!Array.isArray(policy.checks)) fail("assets/hooks-policy.example.json: checks must be an array");

  const runtime = readFileSync(runtimeFile, "utf8");
  for (const fragment of [
    '".odai", "hooks.json"',
    "protectedPaths",
    "blockUnresolvedWrites",
    "stop_hook_active",
    "collectChangedPaths",
    'decision: "block"',
  ]) {
    if (!runtime.includes(fragment)) fail(`scripts/odai-hook.mjs: missing hook boundary: ${fragment}`);
  }

  const builder = readFileSync(builderFile, "utf8");
  for (const host of ["codex", "claude", "copilot", "gemini", "grok", "kimi"]) {
    if (!builder.includes(`"${host}"`)) fail(`scripts/build-hooks.mjs: missing host adapter: ${host}`);
  }
  if (!builder.includes('host === "grok" ? ["pre-tool"]')) {
    fail("scripts/build-hooks.mjs: Grok adapter must not claim blocking stop validation");
  }
}

function validateRepositoryAlignment() {
  const planFile = path.join(repoRoot, "plans", "odai-canary.md");
  const maintainingFile = path.join(repoRoot, "MAINTAINING.md");
  const readmeFile = path.join(repoRoot, "README.md");
  const readmeZhFile = path.join(repoRoot, "README.zh-CN.md");
  const resultsFile = path.join(repoRoot, "docs", "evaluation-results.md");
  for (const file of [planFile, maintainingFile, readmeFile, readmeZhFile, resultsFile]) {
    if (!existsSync(file)) {
      fail(`${path.relative(repoRoot, file)}: repository alignment source is missing`);
      return;
    }
  }

  const plan = readFileSync(planFile, "utf8");
  const caseIds = [...plan.matchAll(/^\|\s*(\d+)(?:\s+★)?\s*\|/gm)].map((match) => Number(match[1]));
  const uniqueIds = [...new Set(caseIds)];
  if (uniqueIds.length === 0) fail("plans/odai-canary.md: no case rows found");
  uniqueIds.forEach((id, index) => {
    if (id !== index + 1) fail(`plans/odai-canary.md: expected continuous case C${String(index + 1).padStart(2, "0")}`);
  });

  const maintaining = readFileSync(maintainingFile, "utf8");
  if (!new RegExp(`${uniqueIds.length} 题全量(?:候选)?题本`).test(maintaining)) {
    fail(`MAINTAINING.md: full plan count must be ${uniqueIds.length}`);
  }

  if (!readFileSync(readmeFile, "utf8").includes("latest frozen results")) {
    fail("README.md: evaluation table must be labeled as the latest frozen results");
  }
  if (!readFileSync(readmeZhFile, "utf8").includes("最近冻结结果")) {
    fail("README.zh-CN.md: evaluation table must be labeled as the latest frozen results");
  }
  if (!readFileSync(resultsFile, "utf8").startsWith("# odai 最近冻结评测结果")) {
    fail("docs/evaluation-results.md: title must identify the current frozen results");
  }
}

function validateStructure(check) {
  const fullPath = path.join(skillRoot, check.path);
  if (!existsSync(fullPath)) return;
  const text = readFileSync(fullPath, "utf8");
  for (const heading of check.headings || []) {
    const pattern = new RegExp(`^#{1,3}\\s+${escapeRegExp(heading)}\\s*$`, "m");
    if (!pattern.test(text)) fail(`${check.path}: missing required section: ${heading}`);
  }
  for (const anchor of check.anchors || []) {
    if (!text.includes(anchor)) fail(`${check.path}: missing routing or schema anchor: ${anchor}`);
  }
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  return value;
}

function estimateTokens(value) {
  const text = String(value || "");
  const cjkChars = (
    text.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g) || []
  ).length;
  return Math.ceil(cjkChars + (text.length - cjkChars) / 4);
}

function requireQuotedField(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}:\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"));
  if (!match) {
    fail(`agents/openai.yaml: missing quoted ${key}`);
    return "";
  }
  return JSON.parse(match[1]);
}

function listFiles(root) {
  const result = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) result.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
  }
  walk(root);
  return result.sort();
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}
