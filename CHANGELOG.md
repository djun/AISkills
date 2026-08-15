# Changelog

本文只记已冻结版本的对外能力、架构、迁移和评测口径。试跑、复跑、中间分和临时输出不进入本日志；原始证据由临时运行目录与 Git 历史承担。

## 2026-08-16 — DSH 输出模式与缓存成本

- 发布 `odai-dsh-agent@0.0.7` 与 `odai-dsh-plugin@0.0.6`。两个包默认使用软精简输出，并提供正常、软精简、经济三种命名模式；经济模式默认发送可调的 `500` provider 输出 ceiling，用户可指定其他正整数。该 ceiling 不影响 child、compaction、checkpoint 或其他内部预算，provider 超限会从逐请求 usage 中显式报告。
- C04 / C05 的经济模式裁判均为 `4/4`，相对软精简合计成本下降约 `36.8%`；当前 provider 会超过 `500`，因此它是有效但非严格的预算信号，不冒充本地硬账单上限。默认软精简不设置 ceiling，正常模式保留为显式退出项。
- 同 provider/model compaction 在继承 controller reasoning 时默认请求 long cache retention，并保持独立 `8192` 摘要预算；普通连续请求的 clean A/B 中，`short` 与 `long` 第二请求均达到约 `95.9%` 缓存覆盖，不据此把 `long` 扩大为普通 controller 的通用默认。
- 新增普通请求缓存对照探针、provider ceiling 严格认证门、Plugin/Agent npm 徽章和完整六 reference 内部地图；真实 DSH load、Agent Web、共存安装、单测与 dry-run package 均通过。

## 2026-08-16 — DSH compaction 缓存兼容

- 发布 `odai-dsh-agent@0.0.6` 与 `odai-dsh-plugin@0.0.5`。同 provider/model 的 DSH compaction 在自身未显式配置 reasoning 时继承当前会话 `request/header` 中用户实际选择的 reasoning effort；跨模型 summarizer 与显式设置保持不变，不内置任何模型名称。
- 真实中转 A/B 使用同一随机前缀和 session：缺失 reasoning 的 compaction 为 `14,679` uncached / `0` cached，继承 `xhigh` 后为 `596` uncached / `14,080` cached，未缓存输入下降约 `95.9%`。压缩后因历史 summary 替换产生的新前缀仍需正常重建。

## 2026-08-15 — DSH skill source 与多轮路由

- 发布 `odai-dsh-agent@0.0.5` 与 `odai-dsh-plugin@0.0.4`。两个包继续不内置任何具体模型：controller 继承 DSH host 选择，planner、executor、reviewer 只使用用户明确配置的 provider/model；缺少高影响责任映射时保持 fail-closed。
- `auto` 在同一主会话按 turn 路由。普通请求留在当前 controller；完整高影响判断缺口在本 turn 使用用户配置的 planner 路线，不创建 child。低风险总结、重述和翻译保持直接路径；引用前文高影响任务继续决策时继承最近的相关用户上下文，新实质任务会切断继承。
- 新增完整 skill manifest 与 `bundled`、`auto`、`user` 来源选择。默认继续固定包内 bundle；只有用户明确设置后才考虑兼容的项目、自定义或用户安装，prompt 治理与路由 role contract 在同一 agent/turn 原子选择。
- agent 协作默认使用新鲜独立上下文和有界任务包，不再为方便 fork 完整长会话；只有无法裁剪的既往交互本身是决定性证据、继承范围与用量可核实且净收益覆盖缓存失效、压缩和延迟成本时才允许继承。
- Plugin 与 Agent 的真实 DSH load、共存安装、session 兼容、模型配置持久化、完整单测和 npm dry-run pack 均通过；发布产物生成后会清理仓库内临时 runtime/skill 副本。

## 2026-08-15 — DSH 会话兼容修复

- `odai-dsh-agent@0.0.4` 与 `odai-dsh-plugin@0.0.3` 不再把私有 `odai/*` 审计事件写入 DSH 核心 session log，改为保存到 `$DSH_HOME/odai/session-evidence/`，避免重启后旧 DSH 因未知事件拒绝加载历史。
- 新增停机迁移：给历史版本写入的八类已知 Odai 审计事件补上 DSH 官方 `ignorable: true` 标记；迁移覆盖 JSONL 与多 frame Zstandard，原子替换并保留校验备份，未知事件拒绝猜测处理，进程检查失败或发现 DSH 仍在运行时拒绝写入。
- Agent 安装、更新和卸载会先检查历史兼容性；Plugin 提供 `odai-dsh-plugin repair-sessions --yes`。真实 DSH 验证覆盖会话先以 `standard` 创建、再切换到 `odai` 后的 preset 恢复，确保迁移不把模式回退为标准。
- 两个包要求 Node.js 22.15.0 或更高版本，以匹配历史 Zstandard 会话迁移所依赖的原生 API。

## 2026-08-14 — DSH Agent 0.0.2

- `odai-dsh-agent` 的 DSH picker 与 npm package description 改为中文，并明确承诺完整继承对应版本 DSH Standard 的全部能力。
- 发布验证继续对完整 Agent composition 做逐字派生校验：只允许 model-neutral Odai persona 替换和末尾 Odai runtime 扩展；Standard 的能力行、设置、顺序发生缺失或漂移都会失败。

## 2026-08-14 — DSH Plugin 与 Agent 首发

### 分发与配置

- 新增 `odai-dsh-plugin@0.0.1`：把 canonical skill、共享 runtime、治理、自动路由和证据监听作为 profile-wide DSH bundle 分发。
- 新增 `odai-dsh-agent@0.0.1`：安装包含同一 canonical skill 与 runtime 的 session-scoped `Odai` Agent preset，不依赖 Plugin，也不修改 profile bundle。
- 两个包都不内置 planner、executor 或 reviewer 模型映射。用户自然指定责任、provider、model 与可选推理档后，controller 通过 `odai_routing_config` 持久化到 `$DSH_HOME/odai/routing.json`；未使用的缺失责任不提示，真实需要时才询问。
- Plugin 适合一个 profile 全局生效，Agent 适合按 session 选择；通常二选一。两者刻意共存时读取同一用户映射，并按 scope shadow prompt、去重 route/tool evidence、保持权限拒绝单调。

### 路由与保护

- 默认 `auto` 保持普通任务由当前 controller 直接闭环；配置后的完整上下文判断缺口同 turn upgrade，明确独立规划或复核才使用 child。`execute`、`observe`、`off` 保留为显式模式。
- planner、executor、reviewer 的缺失、失败或不可信高影响路线统一 fail-closed。损坏 routing store 不阻止治理加载；下一次用户明确 set 时保留损坏副本并自动修复。共享 store 更新使用跨进程锁和原子替换。
- 真实 DSH load、Agent Web live-session 工具 dispatch、Plugin/Agent 单测、隔离 runner 和 dry-run pack 均通过；当前质量与成本口径见 [`docs/routing-results.md`](docs/routing-results.md)。

## 2026-08-13 — 证据合并、跨平台隔离与可选宿主路由

### 能力与架构

- 普通 odai 继续以单一充分能力总控直接闭环；总控是持续持有目标、全局状态、失败恢复与最终交付的任务线程，不是必须额外启动的角色。
- 新增可选宿主路由安装、更新、卸载与运行时核验。`auto` 只注册能力并保持普通单总控路径；用户明确选择且真实任务证明净收益时，才用从任务起点显式运行的 `stage` runner 机械分离 planner、executor 或 reviewer。
- 默认 `auto` 不安装每轮路由 Hook 或机械 runner；Codex 安装会保留无关配置并记录原始总控设置，卸载时在无漂移前提下精确恢复。
- Codex 提供显式 `stage` runner、四责任注册与实际模型 / usage 核验；Claude Code 与 GitHub Copilot 只生成角色配置，未取得等价宿主证据前不宣称同等自动化。
- 路由角色正文保持单一 owner，宿主目录只保留必要外壳。实测证明 `PreToolUse` 透明接管无法承接外层只读证据、会重复调查，因此退役能力路由 Hook；项目写入护栏 Hook 仍独立保留。

### 评测与报告

- 普通模型结果表合并 GPT-5.6 Sol、Claude Opus 5、Grok 4.6 / 4.5、Gemini 3.6 Flash High、DeepSeek V4 Pro / Flash 与 Kimi K3。八个 runner 的历史配对 A/B 均取得正增益；除 Gemini 外，其余全量 on 与 A/B on 均满分。
- 新增统一的 `odai-canary-isolation/v1`：Codex / GPT、Claude Code 及兼容 provider、Grok、Kimi、Antigravity / Gemini、OpenAI-compatible runner 与 judge 分别使用隔离 HOME，只复用鉴权或连接材料；off 不加载 odai、ribao、项目叠加层、仓库指令、路由、Hooks、插件、MCP、记忆或旧会话。旧表保留为隔离契约前的历史能力证据，不冒充已按新口径重跑。
- 指纹回归复现用途，不再因未触达题目运行语义的路由资产、维护文档或其他无关变化整表作废；受影响 case 仍必须整份替换 runner、diff、status、judge 与 token 证据。
- GPT-5.6 Sol 全量主口径采用可拆分的 3,698,792 总处理 token，并同步披露 554,088 非缓存输入加输出；旧 618,944 CLI footer 只作历史口径说明。
- 模型全量 / A/B 与可选宿主路由分成两份报告。正式报告不记录失败管线、复跑流水、临时目录或已退役角色实验。
- 默认 `auto` 的 C01 对照为 4/4，100% 使用 Luna/max，未启动其他责任；历史强制预规划全量只作为退役压力对照，不冒充按需智能路由。

## 2026-08-07 — 轻量通用成事内核

### 架构与思想

- 从历史模块树收敛为 `SKILL.md` 与 `dao`、`craft`、`verification`、`support`、`leverage` 五个渐进加载 owner；高频表现支撑与低频外部能力决策分开加载。
- 保留“事由人定，路由实证；法随势变，成由验定；止于边界，成事而不妄为”，将治理、制作和验收统一为当前任务中的判断与行动，不另造凌驾任务的流程。
- 将人格、思想、主见与分寸落成行为：判断只到证据支持的粒度，敢于提出有据异议，也能诚实保留未知；面向用户自然表达，不表演人格、规则或内部框架。
- `craft.md` 保留规划、实施、设计、UI / 实时交互、写作与审查的最小内置工艺；`support.md` 承接失稳恢复、长期状态与记忆、关系连续性、合议和连续审查，`leverage.md` 单独承接外部能力与 agent 协作。

### 关键纪律与迁移

- 单一权威来源足以回答时先读后停；询问命令、入口或做法只授权回答，不授权代执行。
- 局部修改不把既有相邻偏差自动纳入修复；目标与参考、消费层定制与共享对象、相似接口与真实业务场景继续分离。
- 证据已经找到可独立闭合结果的必要动作时，删除未获授权的原手段、替代手段和顺手增强；涉及持续状态或多次动作的规划必须交代状态推进、冲突处理、失败恢复和最终确认。
- 用户确认只补授权、不补事实；知情授权只在未被证据否定、保护链成立且回退明确时形成有限出口，高影响候选仍须由真实实验边界承载。
- 用户明确要求在收口前须有对应结果或明确未决，不因内部取舍静默遗漏，也不为追求轻量降低目标或验收。
- 旧 `references/dao/`、`capabilities/`、`domains/`、`techniques/` 路径与 `task-ledger.md` 退役；CLI 路由、校验、README 与维护说明同步到当前扁平 owner 架构，不保留平行兼容源。

### 评测

- 全量扩展为 C01-C19，共 19 题、加权满分 144；A/B 扩展为 13 题、加权满分 96，新增缺失能力下的发现、安装边界与精确交接。
- C10 改成不向用户暴露内部能力形态的自然委托：模型须自行判断是否复用、引入或创建项目能力，同时完成当次真实结果；题本不再要求用户替 odai 做架构选择。
- 当前全量 on：GPT-5.6-sol / high、Claude Opus 5、Grok 4.5、Kimi K3 与 DeepSeek V4 Flash 均为 144/144，Gemini 3.6 Flash High 为 126/144。
- 配对 A/B on / off 与净增：GPT 96/80（+16）、Opus 96/77（+19）、Grok 96/69（+27）、Gemini 82/67（+15）、K3 96/75（+21）、D4F 96/61（+35）；除 Gemini 外 runner token on 均高于 off，不把质量增益表述为无条件省 token。
- 内部 skill、项目叠加层、项目 skill 与外部能力统一计入 odai 整体结果。结构性变更重跑全量，边界清楚的局部变更只替换受影响 case 的完整证据。完整分层与逐题结果见 [`docs/evaluation-results.md`](docs/evaluation-results.md)。

## 2026-08-03 — 明文硬门与完整可用交付

### 能力与纪律

- 将高注意规则改成更直接的判断与动作语言，保留 `事｜实｜法｜成｜界` 主轴、四档力度和按需支撑，不用内部黑话替代可观察行为。
- 强化高影响参数停止门：方向、幅度和保护链缺证时整组不写；替代数值只能作为待验证实验候选，用户确认或接受风险不能替代证据。
- 强化完整交付：既有模板、字段和结构进入验成；局部缺口只阻断依赖动作，先交付其余完整可用结果，不得用“已准备”或普通摘要代替正文。
- 明确规划、设计、文档等支撑资料的必读条件，同时保持逐份加载；普通问答和路径已知的局部实施不自动扩展流程。

### 评测与维护

- 全量仍为 18 题、136 分，A/B 仍为 12 题、88 分；确定性产物门按题面允许方案落在 `docs/` 或 `plans/`，不再用未声明目录误杀合理交付。
- 裁判只按用户请求、项目证据、可观察验收与失败门计分；材料无法支持具体值时，不以拒绝编造样本量、阈值、责任人、环境或窗口为由扣分。
- 补充 Antigravity runner 适配，并识别其 `view_file` 结构化轨迹；裁判提示不再携带 runner usage footer，避免 judge token 误取 runner token。
- 当前全量 on：GPT-5.6-sol / high、Claude Opus 5、Grok 4.5 与 Kimi K3 为 136/136，DeepSeek V4 Flash / 1M 为 132/136，Gemini 3.6 Flash / high 为 120/136。
- 当前 A/B on / off 与净增：GPT 88/74（+14）、Opus 88/71（+17）、Grok 88/67（+21）、Gemini 78/54（+24）、K3 88/73（+15）、D4F 86/61（+25）；同步保留逐题分数、分层 runner token 和支撑资料读取。
- canonical skill 为 20 个 Markdown 文件，入口约 2,483 token、总量约 15,217 token；体量警告只触发审查，不以硬上限迫使删除有效规则。

## 2026-07-31 — 人机共同成事与可信交付

### 能力与纪律

- 明确人和模型是共同成事的合作关系：价值取舍由用户决定，事实判断由双方以证据校准；既不盲从用户先验，也不以专业之名替用户改写目标。
- 强化要义不失、判别精度、实际复算和局部缺口隔离：用户点名的重点逐项进入验成，具体对象、输入、位置和约束不被宽泛类别替代，单个阻断不拖低其余可独立交付结果。
- 补齐目标与参考分离、既有扩展面优先、场景契约匹配和证据选择，防止把参考文件当写入目标、为局部定制污染共享基础、或因返回结构相似而选错接口与工具。
- 文档交付、长期连续性和守险交接均收敛到可核证据：沿用既有格式契约，不从提交记录编造工时与完成度，不固化临时秘密或绕法，责任未知时明确待认领动作。

### 架构与维护

- 保持 `事｜实｜法｜成｜界` 单一概念脊柱和按需加载架构；`SKILL.md` 只保留必须高注意的门，详细证据、授权、交付与连续性规则归各自 owner。
- 将入口视为高注意力定额：新规则优先合并或替换旧文字，避免真实学费继续退化成无限追加的规则堆。
- 退役未被运行时路由、宿主注册或发布产物使用的 `skill-author`；其有效维护纪律由 `MAINTAINING.md` 与 `AGENTS.md` 承担，删除只为保护自身存在的校验闭环。
- harness 补齐 C13-C18 的独立 fixture、评分与确定性门，并区分 runner 失败和外部可执行文件缺失；runner stdout 缓冲统一为 64MB，避免长上下文轨迹超过 Node 默认上限后形成基础设施假红。

### 评测

- 全量扩展为 C01-C18，共 18 题、加权满分 136；A/B 扩展为 12 题、加权满分 88，新增可信文档、长期记忆、参考与复用边界、场景契约等能力面。
- GPT-5.6-sol / high、Claude Opus 5 与 Grok 4.5 全量 on 均为 136/136；DeepSeek V4 Flash / 1M 为 130/136，Gemini 3.6 Flash / high 为 119/136，Kimi K3 为 122/136。
- 配对 A/B on / off 与净增分别为：GPT 88/88 / 74/88（+14）、Opus 88/88 / 71/88（+17）、Grok 88/88 / 67/88（+21）、D4F 84/88 / 61/88（+23）、Gemini 77/88 / 54/88（+23）、K3 80/88 / 73/88（+7）；同步保留 runner token 成本对比。
- 旧指纹结果不迁移；未形成完整当前指纹证据的模型不进入最终横向表。

## 2026-07-20 — 实证成事重构

### 架构

- 以“事由人定，路由实证；法随势变，成由验定；止于边界，成事而不妄为”统一总纲；用 `事｜实｜法｜成｜界` 持续判断目标、依据、路径、验收与边界，不把它们机械化为阶段或输出模板。
- 将治理融入从理解到交付的执行过程；保留直达、纠偏、展开与守险四档自适应力度，简单任务不交流程税，证据、风险或长期依赖变化时再升降。
- 能力面收敛为 `planning`、`design`、`delivery` 与 `review`；将外部 skill、项目规则、agent 和多模型协作合并到 `leverage`，将正式与收敛审查合并到 `review-modes`。
- 退役 `feature-plan`、`design-spec`、`diagnose`、`implement-code`、`review-sslb`、`composition`、`coordination`、`audit-loop`、`review-full` 与 `recipes/` 专属模块。README、报告和提交说明等普通产物改为直接服从任务与仓库约定。
- 保留只答不写、明确局部修改、根因授权、高影响参数停止门、证据三态、生产边界和真实验成等关键纪律；支撑资料继续按真实缺口渐进加载。

### 评测

- 将二元通过口径升级为 0–4 完成度乘预设权重：全量 12 题满分 88，A/B 8 题满分 56；严重越权、生产风险与虚报验证使用硬封顶。
- A/B on 从相同指纹、题面、fixture 与 runner 配置的全量结果直接抽取；off 保持独立基线，并继续记录逐题缺口、runner token、支撑读取和确定性检查。
- 当前全量 on：GPT-5.6-sol / high 与 Grok 4.5 为 88/88，Claude Opus 4.8 为 83/88，Qwen 3.8 Max Preview 为 85/88，Kimi K3 为 77/88，GLM-5.2 为 70/88，DeepSeek V4 Pro 为 71/88，MiMo 2.5 Pro 为 68/88。
- 当前 A/B 加权净增：GPT +15、Opus +11、Grok +19、Qwen +9、K3 -1、GLM +8、DeepSeek V4 Pro +12、MiMo +9。公开保留负增益与 token 成本，不把辅助 pass 或满分 on 单独表述为普遍价值证明。

### 维护与迁移

- CLI 路由、治理来源、临时打包、测试与 canonical skill 校验均已同步到新目录；`skills/odai/` 仍是唯一可编辑事实源，`cli/skills/` 只在打包期间临时生成。
- Claude runner 在同一 session 出现多个 `result` 事件时累加全部 usage，避免自动续跑只记录最后一段 token。
- 自定义叠加层若引用已退役路径，需要迁移到新的责任文件；不提供旧路径别名，避免维护第二套架构。
- README、维护说明、题本、评测契约和当前结果均已更新；当前指纹与逐题数据见 [`docs/evaluation-results.md`](docs/evaluation-results.md)。

## 2026-07-16 — r7

### 架构

- 定位为治理内核驱动的通用任务执行框架：治理融入每次判断、行动、验证与收口，不在执行之前制造额外仪式。
- 将多模块路由收敛为单一自适应主流程：判断、行动、验证、收口；按任务明确度、风险和证据动态收放。
- 保留“道可道”、谋定而后动、模型即谋士、六字诀与道儒心兵法五家合一，但不把它们拆成角色或工作流。
- 支撑资料重组为 `dao/`、`capabilities/`、`domains/`、`recipes/`、`techniques/` 和 `assets/`，实现渐进加载。
- 退役 `references/modules/` 以及 `game-plan` / `game-design` 专属路由。游戏任务改由通用规划、设计和实时交互能力自动承接。
- 保留自动发现、外部 skill 借力、项目 `.odai/local.md` 叠加、长任务恢复、agent 协作、合议和增强档，均改为条件触发。

### 评测

- 冻结 12 题全量现实委托与 8 题配对 A/B，覆盖 direct、judgment、complex 和 boundary 四层。
- 题面不针对 odai 模块出题；关键事实放在代码、日志、brief、diff、任务状态和 runbook 中。
- harness 补齐独立 fixture、确定性副作用门、多模型 runner、deferred judge、指纹和 token 统计。
- C04 在不改用户题面、fixture、确定性只读门或 skill 的前提下澄清裁判边界：明确标为待验证假设 / 实验候选且不实施的数值可通过；无证据生产值或直接落地仍失败。
- GPT-5.5、Grok 4.5 和 Kimi K3 的全量 on 均为 12/12；GPT-5.5、Claude Opus 4.8、Claude Sonnet 5、Claude Fable 5、Grok 4.5 与 GLM-5.2 的 A/B on 为 8/8。完整横向结果见 [`docs/evaluation-results.md`](docs/evaluation-results.md)。

### 维护与迁移

- `skills/odai/` 继续是唯一 canonical source；不维护平台镜像或常驻 `cli/skills/`。
- 公开评测记录统一收口到 `docs/evaluation-results.md`，退役 `plans/odai-canary-results.md`。
- 自定义叠加层若引用了旧模块路径，需迁移到新责任目录；不提供旧路径别名，避免形成第二架构。

本日志从 r7 开始；更早历史保留在 Git tags 与 commit 记录中。
