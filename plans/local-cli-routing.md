# 职责路由接入本机 CLI

状态（2026-10-15）：阶段 1、1b、2、3 均已实现并验收；双包 `0.2.51` 已发布（registry：Plugin 07:34:39Z、Agent 07:36:40Z）并由用户装入 DSH web profile。发布后补的 Control Center 本机 CLI 映射表单归入未发布候选 `0.2.52`（见文末“发布后补充”）。剩余：真实 DSH 中的端到端使用验证；Grok 未实测。

## 要解决的问题

用户同时订阅了 Claude Code、ChatGPT（Codex）和 Gemini，三者各有长处，但只能在各自环境里用。目标是让 odai 的职责路由能把某个职责交给本机已登录的 CLI 执行，用订阅额度而不是按量 API：

- DSH 里 GPT 当总控时，可以把创意类职责交给本机 Claude Code，前端交给本机 Gemini CLI。
- 某些任务由 Claude Code 当总控时，也能把工程类职责交给本机 Codex / Gemini（阶段 3）。

每个职责的路由二选一：现有的 API 渠道（provider/model），或本机 CLI（cli/model）。两种都要能指定模型和推理档。

## 已核实的事实

- `claude -p` 无交互可用，提示词可走 stdin；`--output-format json` 返回单个 JSON，含 `is_error`、`subtype`、`result`（正文）、`modelUsage`（以实际模型 ID 为键，含 `canonicalModel`、token 与 `costUSD`）、`usage`、`total_cost_usd`、`permission_denials`、`session_id`、`duration_ms`。实测样例（2026-10-15，节选）：

  ```json
  {"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"…","duration_ms":1211,
   "total_cost_usd":0.016755,"permission_denials":[],
   "modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":531,"outputTokens":52,"canonicalModel":"claude-haiku-4-5","costUSD":0.016755}}}
  ```

- 只读调用已实测：`--tools "Read,Glob,Grep" --permission-mode dontAsk` 能读文件，写文件工具不存在、写入失败；`--no-session-persistence` 不落会话。不要用 `--bare`：它跳过钥匙串读取，订阅登录会失效。
- `--model` 接受别名（`opus`、`sonnet`、`haiku`、`fable`）或完整模型 ID；`--effort` 取值 `low|medium|high|xhigh|max`。JSON 不回报实际推理档。
- 现有子职责派发入口是 `dsh/runtime/src/runtime-support.mts` 的 `runRoutedRole`，只经 DSH `subagents.start` 起子代理；调用点在 `lifecycle-runtime.mts`（researcher 专用路径与通用 delegate 路径）。
- 路由存储由 `routing-config.mts` 校验，`ModelRoute` 只有 provider/model/reasoningEffort/maxTokens，存储 schema 支持 1、2。
- DSH plugin 已通过 package imports `#odai-contracts` 复用随包的编排脚本 `compose-contracts.mjs`，这是“DSH 使用随包可信 canonical 脚本”的既有先例。
- 编排 skill 的 `scripts/run-role.mjs` 是 Codex 宿主的角色执行器：调用 `codex exec`、读取模型证据并写证据文件，可执行文件可由 `ODAI_CODEX_COMMAND` 覆盖。
- 本机暂无 Gemini CLI（只有 Antigravity IDE），Gemini 适配需用户先安装并登录。

## 阶段与范围

### 阶段 1：本机 CLI 后端（DSH 宿主，先接 Claude Code）

**结果**：routing.json 里 planner 或 frontend 可映射到本机 Claude Code；DSH 以 child 方式派发时启动只读 `claude -p`，把正文交回总控，并记录含实际模型的路由回执。

**路由配置形状**（用户可见，按此实现）：

```json
{
  "schemaVersion": 3,
  "roles": {
    "planner": { "provider": "openai", "model": "gpt-6-astra", "reasoningEffort": "xhigh" },
    "frontend": { "backend": "local-cli", "cli": "claude", "model": "opus", "reasoningEffort": "high", "timeoutSeconds": 1200 }
  },
  "dispatch": {}
}
```

- 省略 `backend` 即现有 API 渠道路由，行为与字段校验完全不变。
- `backend: "local-cli"` 时：必填 `cli`、`model`；可选 `reasoningEffort`、`timeoutSeconds`（正整数，上限 7200，默认 1200）；不得出现 `provider`、`maxTokens`。
- `cli` 本版只实现 `claude`；`codex`、`gemini` 是预留值，校验时明确报“本版本尚未支持”，不半实现。
- `cli: "claude"` 的 `reasoningEffort` 只接受 `low|medium|high|xhigh|max`。
- 本版允许 local-cli 的职责：planner、frontend。researcher（依赖受校验的研究包与 DSH 读工具链路）和 reviewer（依赖 `odai_review_evidence`）拒绝 local-cli 并说明原因。
- local-cli 路由只能 child 派发：该职责显式配置 `same-turn` 时校验报错；未配置 dispatch 时实际按 child。
- 存储只在存在 local-cli 路由时写 `schemaVersion: 3`，否则仍写 2；读取支持 1、2、3。旧版 runtime 遇到 3 会按既有逻辑明确拒绝，不会静默误派。
- `odai_routing_config` 的 set 支持 local-cli；与现有规则一致，cli 和 model 必须由用户明确给出，不推断、不代选。show 显示为 `local-cli:claude/opus (reasoning: high)`。`ROUTING_CONFIG_PROMPT` 同步说明。

**共用调用模块**：新增 `skills/odai-orchestration/scripts/local-cli.mjs`（附 `.d.mts` 类型），只含与宿主无关的“如何调用目标 CLI”：

- 路由校验（cli 取值、claude 推理档）、构造调用（可执行文件与参数数组）、解析结果（正文、实际模型、用量、错误）、带超时与取消的执行。
- Claude 调用固定为：`claude -p --output-format json --model <model> [--effort <effort>] --tools Read,Glob,Grep --permission-mode dontAsk --no-session-persistence`；提示词走 stdin；参数数组直传，不经 shell；`cwd` 为会话工作目录；可执行文件默认按 PATH 找 `claude`，可由环境变量 `ODAI_CLAUDE_COMMAND` 覆盖（对齐 `ODAI_CODEX_COMMAND` 先例）。
- 超时或 AbortSignal 触发时先 SIGTERM，宽限后 SIGKILL，确保子进程不残留；stdout 设上限（如 16 MiB），超限按失败处理。
- DSH 按 `#odai-contracts` 的同样方式经随包副本引用它（plugin 与 agent 两个包各自核对实际解析方式）；DSH 的派发、事件、回执映射仍只写在 `dsh/runtime/`。
- 新增 required file，编排 skill 版本升到 `0.2.1`（governanceContract 9 不变），同步所有版本事实载体。

**DSH 执行分支**：

- `runRoutedRole`（或其旁支）在 `roleRoute.backend === "local-cli"` 时不调用 `subagents.start`，改用共用模块执行；提示词与现有 child 相同（`renderDelegationPrompt` + 角色合同），另加一段本机 CLI 执行边界：只读、只有 Read/Glob/Grep、没有任何 DSH 工具、以纯文本交回、制作只交未应用补丁。
- 结果映射到现有 `RoutedRoleOutcome`：
  - 进程失败、非 JSON、`is_error` 或 `subtype` 非 success → fallback（infrastructure-error，附简短错误尾部）。
  - 正文为空 → fallback `route-empty-output`。
  - 超时 → fallback（stopReason 区分 timeout）；取消 → 沿用现有 `cancelled` 语义，不接收迟到输出。
  - 实际模型取 `modelUsage` 中 outputTokens 最多的一项。别名请求：实际 ID 或 `canonicalModel` 含该别名即匹配；完整 ID 请求：等于实际 ID、`canonicalModel`，或实际 ID 以“请求 ID + `-`”开头即匹配。不匹配 → fallback `route-unverified`；成功结果却没有 `modelUsage` → 同样 fallback `route-unverified`（自报不算证据）。
  - `actualRoute` 记为 `{ backend: "local-cli", cli: "claude", model: <实际 ID> }`；推理档无法核实，回执标明 effort 只是请求值，不写成已核实。
  - route-result 事件附加耗时、用量与 CLI 自报费用（订阅下只是参考值，字段名体现“自报”）。
- 防绕过：
  - 原生子代理工具用 `odai-planner:` / `odai-frontend:` 标签手动派发，而该职责映射到 local-cli 时，明确拒绝并提示改用 `odai_responsibility_gap`，不得用 DSH 模型冒充。
  - same-turn 升级路径不得对 local-cli 生效。
- 路由提示、失败提示等渲染路由的地方用统一的描述函数显示两类路由。

**测试**（`dsh/runtime/tests`，不调用真实 claude，用伪造可执行文件或注入执行器）：

- 配置：local-cli 合法与各类非法输入（缺 cli/model、带 provider 或 maxTokens、预留 cli、非法推理档、researcher/reviewer、显式 same-turn、timeoutSeconds 越界）；无 local-cli 时仍写 v2；v2 存储照常读取；show 渲染。
- 共用模块：参数数组正确（model、effort、只读工具、dontAsk、no-session-persistence，提示词不在 argv）；成功、`is_error`、非 JSON、空正文、模型不匹配、缺 `modelUsage`、超时后进程被终止、取消。
- 派发：映射 local-cli 的 planner/frontend 经 child 执行并把正文交回总控、事件与回执字段正确；手动标签被拒；API 渠道路由行为不变（现有测试保持通过）。

**验证命令**：`node scripts/validate-odai-skill.mjs`、`npm --prefix dsh/plugin test`、`npm --prefix dsh/agent test`。odai-cli 冻结：不运行 CLI 测试或 `pack:dry-run`。

**文档**：`dsh/README.md` 增加本机 CLI 路由说明（配置示例、需先安装并登录 CLI、只读、仅 child、允许的职责、回执核实规则与已知限制）；CHANGELOG 当前 Unreleased 条目补本次能力并更正“编排版本不变”的表述。

**边界**：只改 odai 仓库受版本控制的文件；不打包、不发布、不改版本号以外的发布事实；不安装到 `$DSH_HOME`，不改 `~/.dsh/odai/routing.json`；DSH 源码与 `node_modules/@deepseek-ai/*` 只读；不提交 Git。

**阶段 1 之后**（总控负责，不交给实施方）：审查 diff、复跑验证；用共用模块对真实 `claude`（haiku / low）跑一次最小调用，核对参数与解析和实测一致。真实 DSH 端到端需要把新插件装进 DSH profile，属于安装动作，须用户另行授权。

**阶段 1 验收记录**：

- registry 实查：双包 `0.2.50` 已发布，候选改为 `0.2.51`（不含数字 4）；编排 `0.2.1`。
- 复跑：`validate-odai-skill` 通过；Plugin 301/301、Agent 24/24；`git diff --check` 通过。
- 真机：共用模块调用真实 `claude`（haiku / low）返回 `completed`，实际模型 `claude-haiku-4-5-20251001` 核实通过，能读文件，写入未发生。
- 遗留到 1b 的两处修正：未指定 `timeoutSeconds` 时不得把默认值写入用户配置；拒绝以 `-` 开头的模型名。
- 已知限制：Windows 只终止直接子进程；真实 DSH 端到端未测（需安装授权）。

### 阶段 1b：Codex、Antigravity、Grok 适配器

用户要求支持其所有本机 CLI。各家参数、只读方式和模型证据差异很大，按“每家一个适配器”实现；共用模块的执行器（启动、超时、进程组清理、输出上限）保持通用。

**前置修正**：
- 路由归一化不再补默认 `timeoutSeconds`；默认 1200 秒只在执行时使用。用户配置只保存用户给出的字段。
- 模型名拒绝以 `-` 开头或含空白、控制字符。

**结构**：
- `local-cli.mjs` 改为适配器表：`claude`、`codex`、`antigravity`、`grok`。每个适配器负责：字段与推理档校验、构造调用（可执行文件、参数数组、提示词传入方式）、解析输出、取得模型证据。
- `gemini` 仍为预留值（指 Gemini CLI，未适配），拒绝时提示可改用 `antigravity`。
- 可执行文件覆盖：`ODAI_CLAUDE_COMMAND`、`ODAI_CODEX_COMMAND`（沿用 `run-role.mjs` 先例）、`ODAI_AGY_COMMAND`、`ODAI_GROK_COMMAND`。
- 回执的推理档核实分三种：`verified`、`mismatch`、`requested-only`。能核实的适配器出现推理档不一致时，按模型不一致处理（fallback `route-unverified`）。
- 子进程继承 DSH 进程环境。文档写明：需要代理时（例如 Codex、Grok 访问境外接口），在启动 DSH 的环境里设置 `HTTPS_PROXY` 等变量；本机实测 Clash TUN 对终端进程无效、显式代理 `127.0.0.1:7890` 有效。

**codex**（已实测，2026-10-15，codex 0.159.2，经代理）：
- 调用：`codex exec --json --model <model> [-c model_reasoning_effort="<effort>"] -c features.multi_agent=false --sandbox read-only --skip-git-repo-check -C <cwd> -`，提示词走 stdin。
- 实测只读：`--sandbox read-only` 下能读文件（模型经只读命令读取），写入未发生。
- 正文：JSONL 中最后一个 `item.completed` 且 `item.type === "agent_message"` 的 `item.text`。退出码非 0 或没有正文按失败处理。
- 模型与推理档证据：取 `thread.started` 的 `thread_id`，在 `$CODEX_HOME/sessions`（默认 `~/.codex/sessions`）下找文件名含该 ID 的 `rollout-*.jsonl`；核对 `session_meta.payload.id` 等于该 ID、`payload.cwd` 与本次 cwd 的真实路径一致；取最后一个 `turn_context.payload.model` 与 `.effort`。模型须与请求完全相等；请求了推理档时须相等，否则 mismatch。找不到会话文件 → `route-unverified`。
- 推理档只校验为小写字母串，具体取值由 CLI 判定；不一致由会话证据发现。
- 实测样例（节选，cwd 已替换）：

  ```text
  {"type":"thread.started","thread_id":"01a13d65-468d-7e71-a6f4-5ae3f0d6b2d9"}
  {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"marker-7781"}}
  {"type":"turn.completed","usage":{"input_tokens":33621,"cached_input_tokens":26368,"output_tokens":84,"reasoning_output_tokens":24}}
  会话文件：{"type":"session_meta","payload":{"id":"01a13d65-…","cwd":"<cwd>"}} … {"type":"turn_context","payload":{"cwd":"<cwd>","model":"gpt-6.1-sol","effort":"low"}}
  ```

**antigravity**（可执行文件 `agy`，已实测，agy 1.1.12，经代理）：
- 调用：`agy -p <prompt> --output-format stream-json --mode plan --model <model> [--effort <effort>] --print-timeout <timeoutSeconds>s`，cwd 为会话目录。
- 提示词只能作为参数传入（实测 `-p -` 不读 stdin）；超过 256 KiB 直接报错，不截断。提示词末尾追加：读文件只用 `view_file`、`grep_search`、`list_dir`、`find_by_name`，命令行不可用、会被拒绝（实测模型若用命令读取会被自动拒绝并返回空正文）。
- 推理档：`low|medium|high`。部分模型 ID 自带档位（如 `gemini-3.8-flash-high`），用户未给 `--effort` 时不传。
- 只读：`--mode plan` 下 headless 无法弹窗的权限请求被自动拒绝，实测写文件、执行命令均被拒。工具清单里还有浏览器、联网、生成类工具，计划模式下是否全部受限未逐一验证，文档列为已知限制。
- NDJSON 解析：`init` 事件的 `init.model` 与 `conversation_id`；最后的 `result` 事件 `result.status`（`SUCCESS`/`ERROR`）、`result.response`（正文）、`result.error`、`usage`、`denied_actions`。`status` 非 `SUCCESS` 或正文为空按失败处理；记录被拒动作数。
- 模型证据：`init.model` 须与请求完全相等。实测无效模型会直接报错（`status: ERROR`，不回退默认模型），因此 `init.model` 代表实际选用的模型。推理档为 `requested-only`。
- 实测样例（节选）：

  ```text
  {"event":"init","conversation_id":"b8ec26a5-…","init":{"model":"gemini-3.8-flash-medium","cwd":"<cwd>","tools":[…],"permission_mode":"request-review"}}
  {"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\n","usage":{…}}}
  {"event":"result","result":{"conversation_id":"b8ec26a5-…","status":"SUCCESS","response":"OK\n","duration_seconds":4.81,"num_turns":1,"usage":{"input_tokens":13175,"output_tokens":90,"thinking_tokens":89}}}
  无效模型：{"event":"result","result":{"status":"ERROR","response":"","error":"invalid model selection (--model \"bogus-model-xyz\" …)"}}
  ```

**grok**（按官方文档实现，未实测：用户当前无订阅，明确要求不实测）：
- 依据：本机 `~/.grok/README.md`（grok 1.0.3）的 Headless Mode、Sandbox、Built-in Tools、Session Persistence 章节。
- 调用：`grok --prompt-file <临时文件> --output-format json -m <model> [--effort <effort>] --tools read_file,grep,list_dir --disallowed-tools Agent --sandbox read-only --permission-mode dontAsk --no-memory --cwd <cwd>`。提示词写入 `mkdtemp` 建立的私有临时目录（文件权限 0600），结束后删除。
- 推理档：`none|minimal|low|medium|high|xhigh|max`。
- 只读：工具白名单只开读文件、搜索、列目录；`--sandbox read-only` 为系统内核级沙箱（只能写 `~/.grok/`，子进程不能联网）；`--disallowed-tools Agent` 禁止派生子代理。
- 输出：单个 JSON `{text, stopReason, sessionId, requestId}`；`stopReason === "EndTurn"` 且正文非空才算成功。
- 模型证据：`~/.grok/sessions/<URL 编码的 cwd>/<sessionId>/summary.json` 中的模型 ID（字段名文档未给出，依次接受 `model`、`modelId`、`model_id`），须与请求完全相等；文件缺失、字段缺失或格式不符 → `route-unverified`。推理档为 `requested-only`。
- 文档与 CHANGELOG 明确标注“按官方文档实现，未实测”；与文档不符时一律失败回退，不当作成功。

**DSH 侧**：工具参数、`routeSchema`、配置提示、show 渲染同步四个 cli；`actualRoute.cli` 记录实际适配器；允许的职责仍为 planner、frontend（阶段 2 加 creative）。

**测试**：不调用任何真实 CLI。用上面的真实样例构造 fixture：codex（JSONL + 临时 `CODEX_HOME` 下的会话文件，含 cwd 真实路径差异）、antigravity（成功、`ERROR`、空正文、模型不符）、grok（JSON + 临时目录下的 `summary.json`，含缺文件、缺字段）；参数数组逐项断言（只读参数、模型、推理档、提示词传入方式）；默认超时不写入配置；`-` 开头模型名被拒。

**验证命令与边界**：同阶段 1。

**1b 之后**（总控负责）：经代理用真实 codex、agy 各跑一次最小调用核对；grok 不实测。

**阶段 1b 验收记录**：

- 复跑：`validate-odai-skill` 通过；Plugin 318/318、Agent 24/24；`git diff --check` 通过。
- 真机（经代理，共用模块）：codex（gpt-6.1-sol / low）读文件成功，模型与推理档均核实；要求写文件时回复失败、未写入。antigravity（gemini-3.8-flash-medium）读文件成功（按提示词点名的工具读取），模型核实；要求写文件时项目内未写入，但它在自身目录 `~/.gemini/antigravity-cli/brain/` 生成了一份“实施计划”并以计划形式回答；无效模型 9 秒内失败并给出明确错误。
- 观察：Codex、antigravity 解析对非 JSON 行严格失败（与 `run-role.mjs` 跳过非 JSON 行不同），实测未遇到；若出现误失败再放宽。
- 待文档补充：antigravity 计划模式下，制作类请求会得到计划形式的回答。

### 阶段 2：creative 职责

**结果**：新增可选职责 `creative`，不限领域，承接发散构思、面向用户或读者的写作与表达、视觉与表现方向和品味把关（用户 2026-10-15 纠正：要通用，不只针对某款游戏；初版措辞偏游戏，已改）。只读，交回候选、取舍依据或审查意见，由总控核对落盘。用户可把它映射到 API 渠道或本机 CLI（典型用法：本机 Claude Code）。

**canonical（跨宿主，不写宿主机制与模型）**：

- 新增 `assets/routing-roles/creative.md`，正文按下文原样使用（总控撰写，不改写措辞）：

  ```markdown
  ## 创意专业责任

  只承接已经明确的创意判断或创意制作缺口，不限领域：需要发散的构思（点子、概念、命名与创意方向），面向用户或读者的写作与表达（介绍与宣传、产品与界面文字、叙事与内容创作、语气与文风），视觉与表现方向，以及这类内容的品味与体验把关。不是第二个总控；业务目标、产品范围、价值取舍、授权或验收未定时，回交准确的决定缺口，不自行补定。

  先读清受众、语境、项目已有设定与风格约定、禁用项和既有决定，再出方案；写作与设计方法遵循随合同提供的 治理 craft reference。发散时候选要实质有别，不只是换种说法，各写明意图、取舍和适用条件；需要定案时给出推荐及依据，不以数量或形容词代替判断。体验判断只基于给定材料，说明哪些结论需要实际使用或用户反馈才能确认。

  把关时逐条给出位置、问题、对受众的影响和可直接替换的写法，区分事实或设定错误、违背既有约定与个人偏好。套话、空泛修饰、模板句式、不像真人会说的话、前后语气不一致与设定冲突都在检查范围内；偏好不作为阻断条件。

  只读：交回构思、文字、候选或审查意见，不编辑文件，不把建议写成已采纳或已落盘；需要改动时给出原文与替换文本，由总控核对后落盘。不扩大到相邻内容的重写，顺带发现的问题单列为建议。模型、预算及执行权限由宿主选择，不写入本通用责任合同。回交实际产物、决定性取舍、依据、未决项和需要用户判断之处。
  ```

- `manifest.json`：roleFiles 加 `creative`，rolePresets 为 `{ "references": ["craft"] }`，requiredFiles 加该文件；`compose-contracts.mjs` 的角色名单与必需 reference 同步（creative → craft）。
- `references/orchestration.md` 的“选择职责”列表在 frontend 之后加入（原样使用）：

  ```markdown
  - **creative**：发散构思、面向用户或读者的写作与表达、视觉与表现方向或品味把关存在当前能力不能可靠闭合的专业缺口时使用，不限领域。普通措辞调整、已定稿内容的机械替换和局部文字修正直接完成；目标、受众或风格约定未定先回交决定缺口。只读，回交构思、候选、取舍依据或审查意见，由总控核对后落盘。
  ```

- `SKILL.md` 中“researcher、planner、reviewer、frontend 是可选职责预设”加入 creative；`assets/routing-roles/controller.md` 的可选职责占位加入 `__ODAI_CREATIVE_ROLE__`。
- 宿主适配脚本（`build-routing.mjs`、`install-routing.mjs`、`verify-routing.mjs`、`run-role.mjs`）按“可选职责、默认不生成”处理 creative，与 frontend 相同：`--creative-model` / `--creative-effort`、映射名 `odai_creative` / `odai-creative`、build 的角色说明为“只在玩家或用户可见内容、玩法与表现取舍存在专业缺口时提供候选、取舍或把关意见。”；只读角色集合包含 creative。
- 编排版本仍为未发布的 `0.2.1`，不再升版。

**DSH**：

- `CONFIGURABLE_ROLES`、路由角色类型、Control Center 角色列表、routing 工具枚举与提示加入 creative；local-cli 允许职责加入 creative。
- creative 本版只支持 child（API 与 local-cli 路由都是）：配置显式 `same-turn` 报错，未配置时按 child；不进入同轮 token 预算等 in-place 机制。
- 角色 overlay（`role-overlays.mts`）：只读 child，收到有界任务包，交回候选、取舍与带替换文本的审查意见；不编辑、不执行命令、不派生、不做最终交付。
- 手动原生标签 `odai-creative:` 与 planner/frontend 的规则一致：映射为 API 路由时可用，映射为 local-cli 时拒绝并提示改用 `odai_responsibility_gap`。
- 触发（宁可漏判，不可误判；总控经 `odai_responsibility_gap` 提出 creative 是主要入口）：
  - 只在 creative 已有映射时生效（与其他职责一致）。
  - 用户原话需同时有“产出或审查动作”和“创意对象”，二者相邻（同一短句内）：动作如 写、改写、重写、润色、起名/取名、拟、审、把关、评估、优化（英文 write / rewrite / polish / draft / review / name）；对象如 文案、台词、对白、剧情、旁白、商店页、宣传语、口号、世界观、人设、角色设定、玩法、关卡设计、数值平衡、美术方向、画风、AI 味（英文 copy / dialogue / narrative / story / tagline / store page / lore / game design / level design / balance / art direction / tone of voice）。
  - 对象后紧跟代码或数据后缀时不触发：常量、变量、字段、文件、配置、键、key、表、列、模块、组件、接口、函数、id。
  - 正例（应触发）：“帮我润色这段对白”“给新地图写三版商店页宣传语”“审一下第二章的台词有没有 AI 味”“这个玩法的数值平衡你评估一下”“rewrite the store page copy”。
  - 反例（不应触发）：“把文案常量改成从配置读取”“台词表加一列 speaker”“修一下对白组件的渲染 bug”“给这个函数起个名字”“把剧情模块拆成两个文件”“改一下 PR 描述”“review this code”。
- 测试：上述正反例全部入测；creative child 经 local-cli 与 API 路由各一条派发用例；same-turn 拒绝；手动标签规则；现有测试保持通过。

**文档**：`dsh/README.md`、编排相关说明、CHANGELOG（Unreleased 候选）同步 creative。

**验证命令与边界**：同阶段 1。

**阶段 2 之后**（总控负责）：审查 creative 合同与触发正反例；经本机 Claude Code 跑一次真实 creative 小任务（只读）核对回交形态。

**阶段 2 验收记录**：

- 复跑：`validate-odai-skill` 通过；`test-odai-routing` 通过；Plugin 325/325、Agent 24/24；`git diff --check` 通过。
- creative 合同与编排条目与计划原文逐字一致。
- 真机：共用模块经本机 Claude Code（sonnet / low，实际 `claude-sonnet-5`，模型核实）跑一次 creative 审查任务，回交逐条给出位置、问题、影响和替换写法，区分套话、风格违约与设定未决项，并列出需用户判断之处，符合合同。
- **缺陷（阶段 3 前置修正）**：自动触发误判。用编译后的 `decideRoute` 实测，以下工程类请求全部被派给 creative：“写一下玩法的单元测试”“优化一下剧情的加载速度”“审一下玩法代码”“把剧情写进存档”“文案写到配置里”“write a copy of the config to /tmp”“review the balance sheet export”“优化剧情系统的性能”“评估一下玩法逻辑的复杂度”。原因：代码后缀只检查对象后紧邻的词，跳不过“的”，且名单缺少代码、测试、存档、性能等词；“写进/写到”被当成写作；英文 copy、balance 过宽。
- 可接受的漏判（总控仍可经 `odai_responsibility_gap` 提出）：“帮我想想这一关的玩法”“第三章旁白太啰嗦了，帮我改写一下”。

**通用化修正（2026-10-15，用户纠正后由总控直接修改）**：合同、编排条目、build 角色说明、README 与 CHANGELOG 改为不限领域的措辞；触发词表在保留游戏用语的同时加入通用对象（介绍、简历、宣传语、名字、创意、文字、语气、AI 味/翻译腔等）与动词（想、构思、脑暴、改改等），工程词否决名单补充数据库、日志、部署、构建、API 等；新增“上一短句抱怨创意内容、下一短句只提修改”的跨句触发（如“这段话 AI 味太重，帮我改改”），工程类抱怨不触发。复跑：路由测试 26/26、Plugin 330/330、Agent 24/24、`test-odai-routing` 退出 0、技能校验通过。



### 阶段 3：Claude Code 当总控时把职责派给本机 CLI

**结果**：用 odai 编排为 Claude Code 安装路由时，除 controller 外的任一职责可映射到本机 CLI（codex、antigravity、grok）；Claude Code 总控用 Bash 调用角色执行器，执行器只读启动目标 CLI，并写下含实际模型的证据。未映射到本机 CLI 的职责保持现状（Claude Code 原生子代理）。

**前置修正（来自阶段 1b、2 之后的发现）**：
- creative 触发误判：改为短句级否决——同一短句内出现工程或数据词时一律不做词法触发（中文如 代码、逻辑、系统、测试、单元测试、脚本、实现、bug、报错、加载、性能、存档、数据、配置、模块、组件、接口、函数、变量、常量、字段、文件、表、列、键、类、方法、结构、渲染、解析、导入、导出、格式、编码、缓存、复杂度、PR、提交；英文如 code、test(s)、logic、system、script、bug、load/loading、performance、data、config、module、component、interface、function、variable、constant、field、file、table、column、key、class、method、parser、renderer、import、export、cache、sheet、PR、commit）；“写进/写到/写入/写在”不算写作动作；英文 copy 后接 of 不算文案。阶段 2 验收记录中的 9 条误判全部加入反例测试且必须不触发；原有正例保持触发；两条可接受漏判不要求修复。
- grok：仓库评测脚本 `scripts/grok-canary-runner.mjs` 在 2026-07/08 的真实评测中从 JSON 输出的 `modelUsage`（形如 `{"grok-4.5": {...}}`）取实际模型，README 未记载该字段。模型证据改为优先取 `modelUsage`：单个键即为实际模型；多个键时取 token 数最多者；缺失时再用 `summary.json`。仍须与请求完全相等，文档继续标注未实测。
- antigravity：调用加 `--disable-slash-commands`（与仓库评测脚本 `scripts/antigravity-canary-runner.mjs` 一致），防止提示词中的斜杠命令或技能被展开。

**宿主适配（canonical，跨宿主脚本）**：
- `build-routing.mjs --host claude`：每个非 controller 职责新增 `--<role>-cli <codex|antigravity|grok>`，与已有的 `--<role>-model`、`--<role>-effort` 组合；路由按共用模块 `validateLocalCliRoute` 校验。`claude` 不作为 Claude Code 宿主内的本机 CLI 选项（原生子代理已覆盖）。`--<role>-cli` 只在 `--host claude` 下接受，其他宿主报错。
- 映射到本机 CLI 的职责：
  - 不生成该职责的 `.claude/agents/odai-<role>.md`。
  - 生成 `.claude/odai-run-role.mjs`（由 `run-role.mjs` 复制）、`.claude/odai-local-cli.mjs`（由 `local-cli.mjs` 复制）、`.claude/role-contracts/odai-<role>.md`（`roleBody(role, "claude")`）、`.claude/odai-routing.json`（`{ id: "odai-routing-installation", host: "claude", mapping: { <role>: { backend: "local-cli", cli, model, reasoning_effort } } }`）。
  - controller 正文中该职责的占位渲染为调用说明，例如：`odai-reviewer（本机 codex，只读；把有界任务包写入文件后运行 node .claude/odai-run-role.mjs --role reviewer --input <文件>）`。
  - `.claude/settings.patch.json` 在 `agent: "odai-controller"` 之外加入 `permissions.allow: ["Bash(node .claude/odai-run-role.mjs:*)"]`。
  - `ADAPTER.json` 的 mapping 与 runtime_verification 如实反映本机 CLI 职责（证据来自执行器）。
- `install-routing.mjs --host claude`：托管清单、生成文件列表、漂移检查、卸载与恢复纳入上述新文件与设置合并；接受相同的 `--<role>-cli` 参数。
- `run-role.mjs`：新增本机 CLI 分支——当清单 `mapping[role].backend === "local-cli"` 时，提示词为角色合同 + 输入任务包，经共用模块只读执行；输出正文到 stdout；证据文件沿用 version 1 结构（requested 记 `provider: "local-cli:<cli>"`、模型、推理档；observed 记实际模型、model_verified、推理档核实状态、用量、耗时、退出状态与错误）。未完成、模型或推理档未核实时以非 0 退出并写明原因，不输出正文当作成功。清单 host 为 `claude` 时只接受本机 CLI 映射；Codex 宿主现有分支的行为与证据格式完全不变。
- 执行器按运行位置解析共用模块：安装后为同目录 `odai-local-cli.mjs`，源码中为同目录 `local-cli.mjs`。
- Codex 宿主映射本机 CLI 不在本阶段范围。

**文档**：`references/install.md` 增加 Claude Code 宿主映射本机 CLI 的用法与限制（只读、需已安装并登录、子进程继承 Claude Code 环境变量与代理）；CHANGELOG（Unreleased 候选）同步。

**测试**：
- `scripts/test-odai-routing.mjs`：claude 宿主带 `--reviewer-cli codex …` 构建与安装——不生成原生 reviewer 代理，生成执行器、模块副本、合同、清单与权限设置，controller 正文含调用说明；其他宿主拒绝 `--<role>-cli`；卸载清理新文件。
- 执行器本机 CLI 分支：用伪造可执行文件（`ODAI_CODEX_COMMAND` 等）与临时 `CODEX_HOME` fixture——成功时输出正文、证据 model_verified 为真、退出 0；模型不符或无证据时非 0 退出且不输出正文。
- 前置修正：grok `modelUsage` 单键、多键、缺失回退 `summary.json`；agy 参数含 `--disable-slash-commands`。

**验证命令**：`node scripts/validate-odai-skill.mjs`、`node scripts/test-odai-routing.mjs`、`npm --prefix dsh/plugin test`、`npm --prefix dsh/agent test`。

**边界**：同阶段 1；另外不在任何真实项目（包括 game-3）安装路由，安装属于用户另行授权的动作。

**阶段 3 之后**（总控负责）：在临时目录构建 claude 宿主产物，用真实 codex 经执行器跑一次只读角色调用核对证据。

**阶段 3 验收记录**：

- creative 触发：用编译后的 `decideRoute` 复测，阶段 2 记录的 9 条误判全部不再触发，原正例保持触发，两条可接受漏判仍漏判。
- 总控修正：执行器原把“请求了推理档但只能记为 `requested-only`”判为失败，与 DSH 规则不一致；已改为只有可核实的推理档不一致才失败（`run-role.mjs`、对应测试、`references/install.md`、CHANGELOG 同步）。
- 复跑：`validate-odai-skill` 通过；`test-odai-routing` 退出 0；Plugin 329/329、Agent 24/24；`git diff --check` 通过。
- 真机：临时目录构建 claude 宿主产物（reviewer → codex gpt-6.1-sol / low，creative 原生）：不生成 reviewer 原生代理，生成执行器、模块副本、合同、清单与 Bash 放行规则，controller 正文含调用说明。经代理用真实 codex 运行执行器审查一段有缺陷的代码：准确指出缺陷与影响，声明仅静态阅读；证据中模型与推理档均核实，退出 0，源文件未改。
- 未做：真实 DSH 安装后的端到端、在真实项目安装 Claude 宿主路由（均需用户授权）；grok 未实测；antigravity 计划模式下浏览器、联网、生成工具未逐项验证；Windows 只终止直接子进程。

### Gemini CLI（未排期）

- 用户的 Gemini 订阅经 Antigravity 的 `agy` 使用（阶段 1b），不需要另装 Gemini CLI。`gemini` 保留为预留值，有实际需要并实测后再适配。

## 目标配置（用户自行设置，示例）

- 总控、planner、reviewer、researcher：保持 GPT（API 渠道）。
- creative：本机 Claude Code（如 `opus` / `high`），阶段 2 后可用。
- frontend：本机 Antigravity（如 `gemini-3.8-flash-high`），阶段 1b 后可用；此前保持现状。

## 发布后补充（0.2.52 候选）

- 用户在 Control Center 发现映射表单新建时只能填 API 渠道，无法选择本机 CLI（底层配置工具已支持，表单只显示已有的 CLI 映射）。总控补上“渠道（API）/本机 CLI”接入方式切换与 CLI 下拉（planner、frontend、creative；researcher、reviewer 不提供），保存请求由可测的 `routeEditorPayload` 生成；本机 CLI 不经 API 预检，按钮为“保存”。
- 验证：Control Center 客户端测试 14/14（含新表单用例）、Plugin 331/331、Agent 24/24、客户端语法检查通过；界面外观未目视验证。
- 版本：双包升至 `0.2.52`，CHANGELOG 在 0.2.52 条目记录 0.2.51 的 registry 发布时间；版本策略校验通过。

## 发布后补充（0.2.53 候选）

- 0.2.52 已发布（registry：Plugin 08:12:37Z、Agent 08:17:04Z）。
- 用户配置 creative → 本机 Claude Code（`opus` / `max`）后实测：Claude Code 把自身的 haiku 辅助调用也记入 `modelUsage`，短回答时其输出多于路由模型，旧规则判为模型不符并回退。改为“有条目匹配请求模型即核实通过、无匹配才以输出最多者报告不符”，Grok 同理；回归测试含当次真实样例。复跑 Plugin 333/333、Agent 24/24，真机复测通过。
- 另：本机 `claude` 2.1.224 不支持 Opus 5.5（API 要求 ≥ 2.1.280），用户更新到 2.1.300 后 `opus` 实际为 `claude-opus-5-5`。
- 版本：双包 0.2.53、编排 0.2.2（已发布的 `local-cli.mjs` 内容变化，避免同版本异内容）。
