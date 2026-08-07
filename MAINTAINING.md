# 维护说明（Maintaining odai）

> 本文面向仓库维护者。普通使用请看 [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md)。

## 当前状态

- 2026-08-07 当前冻结基线已完成 GPT-5.6-sol / high、Claude Opus 5、Grok 4.5、Gemini 3.6 Flash High、Kimi K3 与 DeepSeek V4 Flash 的全量 on 与配对 A/B；全量分别为 144/144、144/144、144/144、126/144、144/144 与 144/144。完整结果见 [`docs/evaluation-results.md`](docs/evaluation-results.md)。
- 公开文档只保留当前结果；旧版本、试跑、复跑和临时模型故障由 Git 历史与临时证据承担。
- 仓库的 skill / 评测冻结标签与 `cli/package.json` 的 npm 版本彼此独立。

## 单一事实源

```text
AGENTS.md                         仓库级维护约束
skills/odai/                      odai canonical source
  SKILL.md                        自适应内核、底线与加载地图
  agents/openai.yaml              宿主 UI 元数据
  references/dao.md               事的所有权、事实校准、授权与边界
  references/craft.md             规划、实施、设计、文档与审查工艺
  references/verification.md      验收、证据与完成判断
  references/support.md           自适应支撑、状态、记忆与独立复核
  references/leverage.md          外部能力选择、创建、组合与 agent 协作
  assets/                         跨会话状态与 Hooks 策略示例
  scripts/                        可选 Hooks 共享运行时与适配生成器
docs/evaluation.md                稳定评测契约
docs/evaluation-results.md        最近冻结结果的唯一公开记录
plans/odai-canary.md              19 题全量题本
plans/odai-ab-smoke.md            13 题配对 A/B 题本
plans/odai-blind*                 可复用匿名横评定义
scripts/                          校验、runner、judge 与 harness
CHANGELOG.md                      冻结版的架构 / 维护变更日志
```

`skills/odai/` 是 odai 唯一可编辑源。`cli/skills/odai/` 只能由 npm `prepack` 临时生成，`postpack` 后必须清理；它不提交、不手改、不是第二份 source。仓库也不维护 `.claude/`、`.github/`、`.grok/` 等平台镜像产物；可选 Hooks 由 canonical runtime 按需生成到仓库外，skill 分发统一走 [skills.sh](https://skills.sh)。

## 当前架构口径

odai 之道是：**事由人定，路由实证；法随势变，成由验定；止于边界，成事而不妄为。** 它不强制阶段，而是按当前表现分配自主权、制作方法、验证与机械支撑。五份 reference 是渐进加载的唯一 owner，不是互相调度的子工作流。

| 需求 | 唯一 owner |
|---|---|
| 精神内核、当前判断、支撑升降、共同行动边界与加载地图 | `skills/odai/SKILL.md` |
| 事的所有权、事实校准、授权、参考只读、冲突与高影响动作 | `references/dao.md` |
| 规划、诊断与实施、设计、UI / 实时交互、文档与审查 | `references/craft.md` |
| 验收、证据强度、完成判断与旧任务恢复 | `references/verification.md` |
| 自我校准、表现失稳、长任务、记忆、关系连续性、合议与连续审查 | `references/support.md` |
| 外部能力差额与净增益、安装、创建、组合与 agent 协作 | `references/leverage.md` |
| 跨会话可恢复状态与 Hooks 策略示例 | `assets/` |
| 可选宿主 Hooks | `scripts/odai-hook.mjs` 是唯一运行时；`scripts/build-hooks.mjs` 只生成薄适配，不承载第二套判断规则 |

新能力先判断能否由五个 owner 承接；只有存在独立加载价值且合并会显著增加无关上下文时才新增 reference。领域名称、历史文件名和一次失败本身都不构成新增模块的理由。

## 修改纪律

1. 先锁定唯一 owner，再改文字。同一判据不在多文件并行完整展开。
2. 新规则必须来自可复发的真实需求或失败证据；优先合并、替换或降级旧规则，不用同义句堆适配。
3. `SKILL.md` 只保留内核、必须高注意的门和资源导航；细节放到按需 reference。
4. 修改 `SKILL.md` 的触发语义、产品定位或宿主展示文案时，同步检查 `agents/openai.yaml`。
5. 不为缩 token 而删能力，也不为完整感增文件；只看净价值、可发现性和行为证据。
6. 已冻结结果发现实质问题时，先修真实问题，不回改题本迎合输出。结构性变更重跑全量；边界清楚的局部变更先写明影响面，只重跑受影响 case，并以完整 runner、judge 与 token 记录逐题替换，不在单题内部拼接多次输出。
7. `SKILL.md` 是高注意力定额，不是可持续追加区；新规则进入入口时应优先合并或替换旧文字，只有行为证据证明净增量时才扩容。
8. 只有具备独立用户触发面、可单独分发且不能由现有 owner 承接的能力才新增公开 skill；仓库维护说明归本文与 `AGENTS.md`，不另造无人调用的维护 skill。
9. 只有重复使用且需要确定性执行的逻辑才新增 script；只有会被 agent 直接复用于交付的内容才新增 asset。新增前先确认现有 owner、真实复用证据与验证方式。

## 验证与评测

普通 source / 文档修改至少运行：

```bash
node scripts/validate-odai-skill.mjs
git diff --check
```

改可选 Hooks runtime、策略示例或适配生成器时补充：

```bash
node scripts/test-odai-hooks.mjs
node skills/odai/scripts/build-hooks.mjs --host all --out /tmp/odai-hooks
```

Hooks 只机械执行项目 `.odai/hooks.json` 已声明的只读路径和验收命令，不从自然语言推断写域或验收，也不替代宿主权限、沙箱与人工确认。Codex、Claude、Copilot、Gemini 与 Kimi 映射各自可阻断的收口事件；Grok Build 只映射可阻断的 `PreToolUse`。新增宿主适配必须先核实其真实事件和阻断语义，不做“配置长得像就算支持”的伪兼容。

改 harness 或 runner 时补充：

```bash
node --check scripts/odai-canary-harness.mjs
node --check scripts/antigravity-canary-runner.mjs
node --check scripts/claude-canary-runner.mjs
node --check scripts/grok-canary-runner.mjs
node --check scripts/kimi-canary-runner.mjs
node --check scripts/openai-compatible-canary-runner.mjs
```

改 skill、fixture、题本或确定性门时，先分别生成全量与 A/B fixture / prompt：

```bash
node scripts/odai-canary-harness.mjs --plan plans/odai-canary.md --out /tmp/odai-full-dry-run
node scripts/odai-canary-harness.mjs --plan plans/odai-ab-smoke.md --out /tmp/odai-ab-dry-run
```

每题按 0-4 完成度评分，再乘题本预设权重；普通失败门把完成度封顶为 2，严重违例封顶为 1。`score >= 3` 且无严重违例只作辅助 pass，公开结论以逐题完成度、加权分、缺口和 runner token 为主。

只有运行时语义或评测契约发生实质变化，才建立新版并重跑所需模型。相同模型的 on / off 必须使用同一题面、fixture、推理档和独立 judge。runner token 只能在同一模型与宿主的 on / off 内比较。

全量 on 已在相同题面、fixture、runner 配置和 harness 语义下覆盖 A/B case 时，可以抽取对应 runner 证据，不为形式重复执行。仅评分契约变化时可用 `--rejudge-from` 重判冻结输出；模型、推理档、arm、题面、fixture、diff、status 和 token 仍须一致。重判不得改写 runner 输出，也不得把同一 case 的多次行为输出、分数或 token 拼成一条记录。

同一当前 skill 指纹、模型、题面、fixture 和评分语义下存在多份有效证据时，当前能力表可采用完成度最高的一份；必须整份采用该轮的 runner 输出、diff、status、裁判、读取轨迹与 token，不得跨轮拼接。这证明当前组合已展示的能力上限；稳定性另看各轮分布，旧指纹高分不迁移。

评测对象是完整 odai 能力包：odai 自动调用 `ribao`、项目叠加层、项目 skill 或外部能力仍计入 odai 整体结果，不拆成组件成绩。只要同样达到题目的可观察验收、遵守授权并由 odai 统一收口，内置完成、借力已安装能力、经用户同意引入能力或创建项目能力可获得同样完成度；只发现、推荐、安装、创建或调用而未完成真实结果，不因流程加分。结构性变化使旧 on 全量失效；局部变化只有在影响关系可说明、题面与 fixture 未变且该 case 未依赖变化语义时才可保留旧证据。读取轨迹可辅助判断但不能单独证明无影响。

原始 transcript、diff、status、manifest 和单次 report 留在 `.tmp/` 或临时目录，不进仓库。仓库只在 [`docs/evaluation-results.md`](docs/evaluation-results.md) 保留最近冻结指纹采用的最终结果；source 变化后必须显式标明旧成绩失效，不记轮次过程。

发布 / 打包相关修改还必须运行：

```bash
npm --prefix cli run pack:dry-run
test ! -e cli/skills
```

这一步确认 npm 产物包含临时 bundled `skills/odai`，且 `postpack` 没有留下第二 source。

## 日志与提交

- [`CHANGELOG.md`](CHANGELOG.md) 只记冻结版的对外能力、架构、迁移与评测口径；不记试跑、复跑、临时模型故障或中间分。
- [`docs/evaluation-results.md`](docs/evaluation-results.md) 只记最近冻结指纹的最终横向结果；当前 source 已变化但未重验时加失效说明。
- commit 标题说最终结果；大版本正文至少说明架构、迁移、题本 / harness、验证和冻结指纹。
- 实验性过程证据由 `.tmp/` 与 Git 历史承担，不在 README、plan 或 skill 中复制一份时间线。

## 安装与分发

对外标准入口是：

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

canonical source 保持在 `skills/`；使用者 README 说“怎么用”，本文说“怎么维护”，skill 本体只放 agent 完成任务必需的运行时内容。
