#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repoRoot, "skills", "odai");
const ribaoRoot = path.join(repoRoot, "skills", "ribao");
const failures = [];
const warnings = [];

const files = listFiles(skillRoot);
const allowedFiles = new Set([
  "SKILL.md",
  "agents/openai.yaml",
  "assets/hooks-policy.example.json",
  "assets/task-state.md",
  "references/dao.md",
  "references/craft.md",
  "references/leverage.md",
  "references/support.md",
  "references/verification.md",
  "scripts/build-hooks.mjs",
  "scripts/odai-hook.mjs",
]);

for (const relativePath of allowedFiles) {
  if (!files.includes(relativePath)) fail(`${relativePath}: required resource is missing`);
}
for (const relativePath of files) {
  if (!allowedFiles.has(relativePath)) fail(`${relativePath}: resource has no owner in the current architecture`);
}

const skillFile = path.join(skillRoot, "SKILL.md");
if (!existsSync(skillFile)) fail("SKILL.md: missing");
const skillText = existsSync(skillFile) ? readFileSync(skillFile, "utf8") : "";
validateFrontmatter(skillText);
validateConstitution(skillText);
validateStructure();
validateBehavior();
validateOpenaiMetadata();
validateHookSources();
validateReferences();
warnRepeatedRules();
validateRibaoSkill();

const entryTokenEstimate = estimateTokens(skillText);
const markdownTokenEstimate = files
  .filter((file) => file.endsWith(".md"))
  .reduce((total, file) => total + estimateTokens(readFileSync(path.join(skillRoot, file), "utf8")), 0);
if (entryTokenEstimate > 2200) {
  warn(`SKILL.md: entry estimate ${entryTokenEstimate} exceeds review threshold 2200`);
}
if (markdownTokenEstimate > 8000) {
  warn(`skill markdown estimate ${markdownTokenEstimate} exceeds review threshold 8000`);
}

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
    `odai skill ecosystem is valid (${files.length} odai files, ${listFiles(ribaoRoot).length} ribao files, ` +
    `${warnings.length} warnings, entry estimate ${entryTokenEstimate} tokens, ` +
    `odai markdown estimate ${markdownTokenEstimate} tokens).`,
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
  const section = text.match(/^## 精神内核\r?\n([\s\S]*?)(?=^## )/m)?.[1] || "";
  for (const fragment of [
    "**事由人定，路由实证；法随势变，成由验定；止于边界，成事而不妄为。**",
    "用户拥有目标、价值取舍和不可接受结果",
    "模型核实事实、质疑会改变结果的前提",
    "成事是完成用户真正要的结果",
    "不曲事实、不越授权、不造工作",
  ]) {
    if (!section.includes(fragment)) fail(`SKILL.md: spiritual core missing: ${fragment}`);
  }
}

function validateStructure() {
  const checks = [
    {
      path: "SKILL.md",
      headings: ["精神内核", "当前判断", "按表现分配支撑", "共同行动边界", "完成"],
      anchors: [
        "`事｜实｜法｜成｜界`",
        "**自主完成**",
        "**证据纠偏**",
        "**结构化支撑**",
        "**风险保护**",
        "references/dao.md",
        "references/craft.md",
        "references/leverage.md",
        "references/support.md",
        "references/verification.md",
        ".odai/local.md",
      ],
    },
    {
      path: "references/dao.md",
      headings: ["合作与决定", "目标、参考与写入", "高影响动作"],
    },
    {
      path: "references/craft.md",
      headings: ["规划", "实施", "设计", "界面与实时交互", "写作与文档", "审查"],
    },
    {
      path: "references/support.md",
      headings: ["按表现升降", "状态与记忆", "独立复核与连续审查"],
      anchors: ["assets/task-state.md"],
    },
    {
      path: "references/leverage.md",
      headings: ["判断是否借力", "使用、安装与创建", "组合与下放"],
    },
    {
      path: "references/verification.md",
      headings: ["建立验收", "判断完成"],
    },
  ];

  for (const check of checks) {
    const fullPath = path.join(skillRoot, check.path);
    if (!existsSync(fullPath)) continue;
    const text = readFileSync(fullPath, "utf8");
    for (const heading of check.headings) {
      if (!new RegExp(`^#{1,3}\\s+${escapeRegExp(heading)}\\s*$`, "m").test(text)) {
        fail(`${check.path}: missing required section: ${heading}`);
      }
    }
    for (const anchor of check.anchors || []) {
      if (!text.includes(anchor)) fail(`${check.path}: missing routing or schema anchor: ${anchor}`);
    }
  }
}

function validateBehavior() {
  const checks = [
    {
      path: "SKILL.md",
      label: "adaptive support",
      patterns: [
        /不按模型名称预设强弱/,
        /自主完成[\s\S]{0,180}不额外写计划、清单或状态/,
        /只答不写[^。\n]*单一权威来源/,
        /命中后停止检索/,
        /用户纠正、工具或测试失败、证据冲突/,
        /支撑只能补当前缺口[^。\n]*不能降低目标、删减验收/,
      ],
    },
    {
      path: "SKILL.md",
      label: "shared boundaries",
      patterns: [
        /明确点名局部结果[^。\n]*只改完成该结果所必需的对象/,
        /相邻发现先保持[^。\n]*阻断当前结果/,
        /背景、约束、样式、示例和参考实现默认只读/,
        /名称、字段或输出相似不证明用途相同/,
        /用户给出的根因和手段[^。\n]*不自动成为事实或无条件目标/,
        /修改共享对象或既有契约[^。\n]*保持默认行为/,
        /“严格、完整、增强”提高证据、反证、保持项和验收强度/,
        /未读、未做、未跑、未验证或未调用都如实说明/,
      ],
    },
    {
      path: "references/dao.md",
      label: "authority and risk",
      patterns: [
        /事实判断由证据校准[^。\n]*价值冲突由用户决定/,
        /能自行查证的事实先查证/,
        /疑似误写、否定要求或彼此冲突的约束/,
        /感知目标先结合现有基线、参考和场景形成可逆方案/,
        /读取不产生写入授权/,
        /证据不足时不实施，也不另拍一个“更保守”的值/,
        /用户可以决定价值取舍并承担仍可控的剩余风险/,
        /方案未被现有证据否定、安全依赖已经成立[^。\n]*才可在原授权范围内实施并标明未验证/,
        /用户确认不能让已否定的手段重新满足原目标[^。\n]*不能替代未证实的保护链/,
        /不授权模型另拍数值、扩大范围或弱化回退/,
        /拒绝原手段后仍承接原目标/,
        /不为凑完整虚构[^。\n]*环境[^。\n]*责任人[^。\n]*替代方案/,
        /默认使用用户当前主要语言[^。\n]*产物语言遵循用户要求或项目约定/,
      ],
    },
    {
      path: "references/craft.md",
      label: "built-in craft",
      patterns: [
        /首次写入前确认预期结果、写入对象、必须保持的行为和完成证据/,
        /数值候选先说明它服务的决定、依据、计算、敏感性、极值和验证方式/,
        /只改解决目标所需的最小完整部分/,
        /补丁同时包含已证必要改动和替代、相邻或“保险”改动[^。\n]*先移除后者再验证/,
        /外来内容进入会执行、查询、解释或改变权限与数据的处理点前/,
        /不把未受信内容直接拼入可执行上下文/,
        /大改动按可独立验证的完整切片推进/,
        /普通任务不强制套用 TDD、SDD、BDD 或其他仪式/,
        /不靠放宽断言或吞错造绿/,
        /区分可复用基线、实现偏差和真正缺口/,
        /游戏、仿真和实时系统同时说明循环、输入、状态变化、反馈、资源、失败与恢复/,
        /只有多个使用方共享同一需求时才扩展公共能力/,
        /正文完成不冒充已发布/,
        /证据不足不判为缺陷/,
      ],
    },
    {
      path: "references/support.md",
      label: "weak-model support",
      patterns: [
        /同一路线没有新证据却继续尝试/,
        /把下一步缩成能独立验证的动作/,
        /触发支撑的缺口已闭合[^。\n]*先撤掉对应额外结构再继续/,
        /极复杂或真实并行任务[^。\n]*稳定标识、依赖、负责人、范围、产物与验收/,
        /没有维护授权不自动修改技能或项目规则/,
        /只有稳定、跨任务有用且可复核的信息才保存/,
        /\.odai\/local\.md[^。\n]*项目叠加层/,
        /每轮都检查当前状态[\s\S]{0,100}重新计数/,
        /审查者保持只读[^。\n]*未经主流程验证不能关闭问题/,
      ],
    },
    {
      path: "references/leverage.md",
      label: "external leverage",
      patterns: [
        /技能回交至少让主流程拿到可用结果、实际依据、未决项和已发生的外部动作/,
        /当前验收无法被现有知识、工具和证据可靠完成或验证的实质缺口[^。\n]*可验证的结果改善与稳定重复成本下降/,
        /说不出具体差额和结果变化就不找外部能力/,
        /新增能力对正确性、兼容性、可验证性、真实交付或重复成本的改善/,
        /无法说明这个差额就不推荐、不安装、不创建/,
        /通用缺口会实质影响结果[^。\n]*真实目录与权威来源/,
        /无法核实时只描述所需能力[^。\n]*不编造具体名称/,
        /安装或启用前征得用户同意/,
        /当前环境缺失[^。\n]*替代方案能否保持相同结果、格式、兼容与验证/,
        /不能证明等价就不静默改走较差路线/,
        /项目级 skill 需要同时成立/,
        /正确做法依赖本项目的权威来源[^。\n]*离开项目不能原样复用/,
        /有明确的再次使用证据/,
        /缺一项就不创建/,
        /description 写清可发现的触发面/,
        /禁止为了完整感串读技能、让技能互相递归调用/,
        /不能隔离写入或验证结果时改为串行/,
        /重复采样、增加席位和延长讨论不能把能力不足本身变成正确结果/,
      ],
    },
    {
      path: "references/verification.md",
      label: "honest completion",
      patterns: [
        /映射成可观察证据/,
        /各自只证明实际覆盖的内容，不能互相冒充/,
        /明确区分已实施、已验证与未验证/,
        /证据足够就停止/,
      ],
    },
  ];

  for (const check of checks) {
    const fullPath = path.join(skillRoot, check.path);
    if (!existsSync(fullPath)) continue;
    const text = readFileSync(fullPath, "utf8");
    for (const pattern of check.patterns) {
      if (!pattern.test(text)) fail(`${check.path}: missing ${check.label}: ${pattern}`);
    }
  }
}

function validateOpenaiMetadata() {
  const file = path.join(skillRoot, "agents", "openai.yaml");
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
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
  if (![policyFile, runtimeFile, builderFile].every(existsSync)) return;

  try {
    const policy = JSON.parse(readFileSync(policyFile, "utf8"));
    if (policy.version !== 1) fail("assets/hooks-policy.example.json: version must be 1");
    if (!Array.isArray(policy.protectedPaths)) fail("assets/hooks-policy.example.json: protectedPaths must be an array");
    if (!Array.isArray(policy.checks)) fail("assets/hooks-policy.example.json: checks must be an array");
  } catch (error) {
    fail(`assets/hooks-policy.example.json: invalid JSON: ${error.message}`);
  }

  const runtime = readFileSync(runtimeFile, "utf8");
  for (const fragment of ["protectedPaths", "blockUnresolvedWrites", "stop_hook_active", "collectChangedPaths"]) {
    if (!runtime.includes(fragment)) fail(`scripts/odai-hook.mjs: missing hook boundary: ${fragment}`);
  }

  const builder = readFileSync(builderFile, "utf8");
  for (const host of ["codex", "claude", "copilot", "gemini", "grok", "kimi"]) {
    if (!builder.includes(`"${host}"`)) fail(`scripts/build-hooks.mjs: missing host adapter: ${host}`);
  }
}

function validateReferences() {
  for (const relativePath of files.filter((file) => file.endsWith(".md"))) {
    const text = readFileSync(path.join(skillRoot, relativePath), "utf8");
    for (const match of text.matchAll(/`((?:references|assets)\/[A-Za-z0-9_./-]+)`/g)) {
      const target = match[1];
      const resolved = path.resolve(skillRoot, target);
      if (!isInside(skillRoot, resolved)) fail(`${relativePath}: reference escapes skill root: ${target}`);
      else if (!existsSync(resolved)) fail(`${relativePath}: missing reference target: ${target}`);
    }
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.length > 240) warn(`${relativePath}:${index + 1}: long rule line (${line.length} chars)`);
    });
  }
}

function validateRibaoSkill() {
  const ribaoFiles = listFiles(ribaoRoot);
  const allowed = new Set(["SKILL.md", "agents/openai.yaml"]);
  for (const relativePath of allowed) {
    if (!ribaoFiles.includes(relativePath)) fail(`skills/ribao/${relativePath}: required resource is missing`);
  }
  for (const relativePath of ribaoFiles) {
    if (!allowed.has(relativePath)) fail(`skills/ribao/${relativePath}: resource has no owner`);
  }

  const entryFile = path.join(ribaoRoot, "SKILL.md");
  if (!existsSync(entryFile)) return;
  const text = readFileSync(entryFile, "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || "";
  if (!/^name:\s*ribao\s*$/m.test(frontmatter)) fail("skills/ribao/SKILL.md: name must be ribao");
  if (!/^description:\s*\S+/m.test(frontmatter)) fail("skills/ribao/SKILL.md: description is required");
  for (const heading of ["确认交付", "收集事实", "形成正文", "验收与交回"]) {
    if (!new RegExp(`^##\\s+${heading}\\s*$`, "m").test(text)) {
      fail(`skills/ribao/SKILL.md: missing required section: ${heading}`);
    }
  }
  for (const pattern of [
    /既有模板[^。\n]*标题[^。\n]*(?:日期|周期)[^。\n]*分区[^。\n]*字段[^。\n]*信息粒度/,
    /最终答复先给出同结构的完整正文/,
    /不用一段摘要或追问替代正文/,
    /不能单独推出工时、完成比例、负责人、承诺或业务效果/,
    /每个实质独立的事项单独呈现/,
    /没有完成证据的既有事项保留原状态、责任与日期/,
    /缺少工时、比例等字段只阻断依赖它们的填报/,
    /正文完成不等于已保存、已发送或已提交/,
    /由 odai 调用[^。\n]*odai 统一核对目标、边界与最终交付/,
  ]) {
    if (!pattern.test(text)) fail(`skills/ribao/SKILL.md: missing reporting behavior: ${pattern}`);
  }

  const metadataFile = path.join(ribaoRoot, "agents", "openai.yaml");
  if (existsSync(metadataFile)) {
    const metadata = readFileSync(metadataFile, "utf8");
    for (const field of ["display_name", "short_description", "default_prompt"]) {
      if (!new RegExp(`^\\s*${field}:\\s*\"[^\"]+\"\\s*$`, "m").test(metadata)) {
        fail(`skills/ribao/agents/openai.yaml: missing quoted ${field}`);
      }
    }
    if (!metadata.includes("$ribao")) fail("skills/ribao/agents/openai.yaml: default_prompt must mention $ribao");
    if (!/^\s*allow_implicit_invocation:\s*true\s*$/m.test(metadata)) {
      fail("skills/ribao/agents/openai.yaml: implicit invocation must be enabled");
    }
  }

  const tokenEstimate = estimateTokens(text);
  if (tokenEstimate > 2200) warn(`skills/ribao/SKILL.md: estimate ${tokenEstimate} exceeds threshold 2200`);
}

function warnRepeatedRules() {
  const seen = new Map();
  for (const relativePath of files.filter((file) => file.endsWith(".md"))) {
    const lines = readFileSync(path.join(skillRoot, relativePath), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const normalized = line.replace(/^[#*\-\d.\s]+/, "").replace(/[`*_]/g, "").trim();
      if (normalized.length < 40) return;
      const previous = seen.get(normalized);
      if (previous && previous.path !== relativePath) {
        warn(`${relativePath}:${index + 1}: repeats ${previous.path}:${previous.line}`);
      } else {
        seen.set(normalized, { path: relativePath, line: index + 1 });
      }
    });
  }
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
  if (existsSync(root)) walk(root);
  return result.sort();
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
