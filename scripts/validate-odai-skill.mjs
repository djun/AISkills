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
    headings: ["总纲", "一条主线", "按势换挡", "不可绕过的门", "按需借力", "验成与收口"],
    anchors: [
      "事（用户要什么结果）",
      "实（依据与缺口）",
      "法（当前最轻充分路径）",
      "成（验成证据）",
      "界（授权、风险与止点）",
      "**直达**",
      "**纠偏**",
      "**展开**",
      "**守险**",
      "**只答不写**",
      "**目标与参考分离**",
      "**场景契约**",
      "**复用层级**",
      "**写前冻结**",
      "**要义不失**",
      "**根因授权**",
      "**高影响参数停止门**",
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
    headings: ["何谓成事", "选择证据", "高影响参数", "状态与收口", "承接旧任务"],
    anchors: ["`declared`", "`observed`", "`verified_end_to_end`", "`implemented_unverified`"],
  },
  {
    path: "references/dao/continuity.md",
    headings: ["主状态", "跨任务记忆", "执行账本", "恢复与队列"],
    anchors: ["assets/task-state.md", "assets/task-ledger.md", "`.odai/local.md`"],
  },
  {
    path: "references/dao/leverage.md",
    headings: ["先组合能力", "再决定是否下放", "演进而不自改"],
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
    headings: ["先辨因", "再闭合结果", "命中边界"],
  },
  {
    path: "references/capabilities/review.md",
    headings: ["形成 finding", "覆盖面"],
    anchors: ["references/techniques/review-modes.md"],
  },
  {
    path: "references/capabilities/documentation.md",
    headings: ["先定交付与授权", "取证与裁剪", "日报、更新与变更文案", "项目指南", "验成"],
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
    headings: ["组织", "收束"],
  },
  {
    path: "references/techniques/review-modes.md",
    headings: ["连续审查与修复收敛", "正式准入输出"],
  },
  {
    path: "assets/task-state.md",
    headings: ["事与界", "实与成", "法"],
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
        /价值取舍由用户决定[^。\n]*事实判断以证据校准[^。\n]*界内专业做法由模型自主/,
        /dao 资料只处理[^。\n]*横切判断[^。\n]*不替代交付工艺/,
        /即使已经读过 dao[^。\n]*继续读取一份首选 capability/,
      ],
    },
    {
      path: "SKILL.md",
      label: "observable stop boundary",
      patterns: [
        /\*\*守险\*\*[^。\n]*[\s\S]{0,260}拒绝原手段[^。\n]*承接原目标/,
        /新证据若会改变用户目标[^。\n]*停在可逆边界[^。\n]*由用户决定后再继续/,
        /拒绝原值不等于获准另拍数值/,
        /目标与参考分离[\s\S]{0,220}不因要形成新结果而变成写入目标/,
        /交付载体未指定[^。\n]*回复足够时直接回复[^。\n]*确需落盘则新建唯一相关产物/,
        /可计算的结论、区间与端点须实际复算[^。\n]*离散量按约束取整并复验边界/,
        /局部或定向结果不得概括为项目、全量或场景通过/,
        /具体对象、输入、位置与通过条件[^。\n]*不得被宽泛类别替代/,
        /局部缺口只阻断依赖它的部分或动作[^。\n]*先完整交付可用部分[^。\n]*再问最小阻断/,
        /未验证项写清复验对象、材料已知的具体场景、输入或位置、动作与通过标准/,
        /责任未指定时明确指出[^。\n]*给出需认领的动作/,
        /追加前须指出它将改变的决定或区分的假设[^。\n]*说不出就停/,
      ],
    },
    {
      path: "references/dao/authority.md",
      label: "two-way evidence correction",
      patterns: [
        /价值取舍与事实判断[^。\n]*前者由用户决定[^。\n]*后者共同查证[^。\n]*证据可以推翻任何一方/,
        /否定、绝对约束或彼此冲突[\s\S]{0,120}由用户决定后再继续/,
        /只读分析、解释、诊断或审查默认不写入/,
        /生产、外部通信、付费、删除、迁移或其他难回退动作[^。\n]*确认具体对象、环境、影响、停止条件和可用退路/,
      ],
    },
    {
      path: "references/dao/verification.md",
      label: "high-impact evidence gate",
      patterns: [
        /`declared`[^。\n]*`observed`[^。\n]*`verified_end_to_end`/,
        /保护链不足[^。\n]*承接用户原目标[^。\n]*取什么证据[^。\n]*通过、停止或改选路线/,
        /补证不得假定未证实的环境、权限、工具、数据或责任人存在/,
        /未知条件只作显式前提[^。\n]*不能成为唯一解锁路径/,
      ],
    },
    {
      path: "references/dao/leverage.md",
      label: "overlay precedence and limits",
      patterns: [
        /项目叠加优先于通用用户偏好/,
        /不得覆盖宿主与当前用户指令[^。\n]*不得改变 canonical odai 的总纲、核心门和事实口径/,
        /普通方法冲突时[^。\n]*当前任务事实择法/,
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
