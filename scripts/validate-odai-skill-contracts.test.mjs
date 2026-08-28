import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillText = readFileSync(fileURLToPath(new URL("../skills/odai/SKILL.md", import.meta.url)), "utf8");
const validatorText = readFileSync(fileURLToPath(new URL("./validate-odai-skill.mjs", import.meta.url)), "utf8");

const intentContracts = [
  "行动前须有充分且唯一的意图证据",
  "方向性改进有多个合理交付物时",
  "实施或提交授权在目标唯一后才生效，不能让目标变唯一",
  "低成本或可撤回不能替代对齐",
  "探索、决定与实施不自动切换",
  "意图证据充分且唯一",
];

test("intent-alignment entry contracts are registered in the canonical validator", () => {
  for (const contract of intentContracts) {
    assert.ok(skillText.includes(contract), `SKILL.md lost intent contract: ${contract}`);
    assert.ok(validatorText.includes(JSON.stringify(contract)), `validator lost intent anchor: ${contract}`);
  }
});
