# Odai DSH same-turn controller route 作用域泄漏报告

状态：已复现，待修复
日期：2026-08-18
影响版本：Odai DSH `0.2.0` 源码，运行于 `@deepseek-ai/dsh@0.1.0-rc.7`
观察会话：`session-d8732c8c-ea3f-4b39-89b8-bbc89f4e28d9`

## 1. 摘要

本次真实事故由 reviewer 路径触发：Odai 在 `auto` 模式中发现 reviewer 责任缺口、但证据包不足以启动独立 reviewer child，于是把基础 controller `openai/gpt-5.6-sol` 原地升级到 reviewer 映射 `openai/gpt-5.6-terra`。运行时因 `REVIEWER_EVIDENCE_STATE_GAP` 将请求改为 Terra。

根因机制不是 reviewer 专用。`0.2.0` 的 planner、reviewer、executor、frontend 都可能进入共享的 `inPlaceUpgrade -> controllerUpgrades` 路径；researcher 当前不走这条 controller upgrade 路径。升级状态按 `agent + turn` 保存，并在该 turn 的每个后续 `agent/request` 上继续生效，只在后续 top-level turn 的 `step === 1` 才删除。DSH 的一个长回合可以包含多 step、后台通知、queued inbox 和工作期间追加的用户消息，因此任一职责升级都可能把后续不相关请求继续路由到该职责模型。

结论：这是 Odai DSH runtime 的通用 controller responsibility scope 生命周期 bug，reviewer 只是已取得真实证据的实例。修复不能统一假定所有职责只需一个请求；必须为每类 in-place responsibility 建立显式、有限且可验证终止的 scope，不能默认覆盖整个 turn。

## 2. 用户可见影响

- 用户选择并记住的是 `Sol/xhigh`，当前会话却在没有手动操作的情况下变成 `Terra/xhigh`；最终需要用户手动切回 Sol。
- planner/reviewer 的只读职责合同，或 executor/frontend 的制作职责合同，可能继续约束后续不相关请求，造成能力、权限、写域和任务所有权漂移。
- 请求成本、延迟、模型行为和缓存前缀可能改变，但界面只显示模型变化，用户无法知道职责 scope 何时结束。
- 同一 turn 中新增的直接用户消息可能被旧职责 route 处理，即使该消息本身没有相应责任缺口。
- session 的 durable `request/header` 会如实记录临时职责 route；依赖最新 durable route 的压缩、恢复、标题或其他辅助逻辑可能把它当成当前会话 route。

这不等于任何 persisted responsibility mapping 被修改。本次 `odai_routing_config` 仍然是 `planner -> Sol/xhigh`、`reviewer -> Terra/xhigh`；泄漏发生在当前 controller 请求路由，而不是映射存储。

## 3. 真实复现证据

原始会话日志仅用于本机来源追溯，不是复现或修复的前置，也不应上传：

```text
$DSH_SESSION_JSONL = /Users/orzi/.dsh/sessions/--Users-orzi-Documents-works-orzi-odai--/session-d8732c8c-ea3f-4b39-89b8-bbc89f4e28d9/session.jsonl.zstd
```

可移植的脱敏最小证据已保存为 [`odai-dsh-same-turn-route-leak-evidence.json`](./odai-dsh-same-turn-route-leak-evidence.json)。该文件不含完整对话、用户消息正文、系统提示、工具参数或凭据；晚间修复只需要报告和该证据包，不需要复制原 session。

`request/header` 时间线：

```json
{"seq":13,"reason":"initial","config":{"provider":"openai","model":"gpt-5.6-sol","reasoningEffort":"xhigh","maxTokens":500}}
{"seq":5189,"reason":"change","config":{"provider":"openai","model":"gpt-5.6-terra","reasoningEffort":"xhigh","maxTokens":500}}
{"seq":26156,"reason":"change","config":{"provider":"openai","model":"gpt-5.6-sol","maxTokens":500}}
{"seq":27125,"reason":"change","config":{"provider":"openai","model":"gpt-5.6-sol","reasoningEffort":"xhigh","maxTokens":500}}
```

Terra header 前一条消息由 Odai runtime 注入：

```text
seq: 5188
source.plugin: odai-dsh-runtime
summary: odai upgraded controller route (REVIEWER_EVIDENCE_STATE_GAP)
role: controller
action: upgrade
target responsibility: reviewer
requested controller route: openai/gpt-5.6-terra (reasoning: xhigh)
The current controller turn requested an in-place upgrade; no child was started.
```

该事件还明确说明 bounded packet 不足，要求进行 same-turn read-only check，不得声称独立验收。这证明 Terra 不是用户选择、模型 fallback 或 `odai_routing_config` 写入，而是 reviewer 原地升级。

会话中唯一的 `odai_routing_config` 工具调用是后续排查使用的 `{"action":"show"}`，没有 `set` 或 `remove`。

时间线中的两条 Sol header 都来自用户手动切换，不是 Odai runtime 自动恢复。`seq 26156` 先写回 Sol 但暂未带 `reasoningEffort`，`seq 27125` 再写入完整 `Sol/xhigh`，属于一次手动选择过程的两阶段持久化。手动操作前没有自动恢复 header，因此当前实证是：reviewer route 持续影响会话，直到用户主动切回。该证据仍不表示 reviewer 持久映射本身被改写，也尚未证明在没有手动干预时跨 top-level turn、重启或 resume 会如何恢复；这些必须由新增测试决定。

### 3.1 无原会话复现配方

原 session 只证明事故确实发生；代码复现应使用最小确定性测试，不重放对话：

1. 配置 base proposal 为 `Sol/xhigh`，reviewer route 为 `Terra/xhigh`。
2. 构造 `REVIEWER_EVIDENCE_STATE_GAP`，并令 reviewer evidence packet 不足，使 runtime 选择 same-turn in-place upgrade、不得启动 child。
3. 调用一次 `agent/request({ turn: 1, step: 1 })`，让 `next()` 返回 base proposal；断言当前缺陷实现返回 Terra。
4. 模拟该 Terra `request/header` receipt。
5. 再调用 `agent/request({ turn: 1, step: 2 })`，让 `next()` 再次返回 base proposal。
6. 当前缺陷应复现为第二次仍返回 Terra；修复后的期望是完整 `Sol/xhigh`。
7. 在 step 2 前增加 `agent/inbox/spliced` / direct-human message 变体，期望仍为 Sol，除非新消息独立产生新的 reviewer gap。

该测试直接命中 `controllerUpgrades` 的生命周期，不依赖 session ID、时间戳、用户文本或外部模型调用。

## 4. 代码级根因

在 `0.2.0` 源码中核对到：

- `dsh/runtime/src/router.mjs`：planner 与 frontend evidence gap 直接产生 `upgrade`；executor 的 frozen route card 可产生 `upgrade`；reviewer evidence packet 不足时在 `auto` 模式由 delegate 降级为 `upgrade`。
- `dsh/runtime/src/index.mjs`：`inPlaceUpgrade` 对 `auto` 模式的 upgrade 生效，executor/frontend 在对应模式下也可进入该路径。
- `dsh/runtime/src/index.mjs`：所有这些角色共享 `controllerUpgrades.set(agent, { turn, role, route, ... })`。
- `dsh/runtime/src/index.mjs`：`agent/request` 只检查 `upgrade.turn === turn`，所以同一 turn 的每个 step 都会继续套用当前职责 route。
- `dsh/runtime/src/index.mjs`：仅在后续 `agent/pre-step` 的 `step === 1` 删除 `controllerUpgrades`。

关键结构：

```js
const upgrade = controllerUpgrades.get(agent);
const upgradeRole = upgrade && upgrade.turn === turn ? upgrade.role : undefined;
// ...
request = {
  ...proposed,
  provider: roleRoute.provider,
  model: roleRoute.model,
  reasoningEffort: roleRoute.reasoningEffort,
};
```

清理逻辑：

```js
if (step === 1 && !subagentSession) {
  routeProtections.delete(agent);
  controllerUpgrades.delete(agent);
}
```

该组合把“same-turn”实现成了“整 turn”。实际需求是一个有界 responsibility scope：reviewer/planner 可能只需一次模型响应，executor/frontend 可能合法跨多个 tool step，但都必须有明确起点、继续条件和停止事件。在 DSH 中，turn 不是可靠的责任或用户意图边界：运行中的任务可接收 `agent/inbox/spliced` 消息，且工具循环会产生多个 step。

### 4.2 DSH 持久化放大了泄漏

DSH `packages/core/agent-loop/src/agent.ts` 会在实际请求 header 与 session baseline 不同时追加：

```js
session.append('request/header', { header, reason: 'change' })
```

因此任一 in-place responsibility override 都会成为合法、durable 的实际请求记录。这一记录本身是正确审计行为；错误在于 Odai 没有按该职责的真实完成条件收回 scope，导致后续请求继续产生或继承旧职责 route。本次 durable route 恰好是 reviewer/Terra。

不能通过禁止 DSH 记录 header 来修复，否则会破坏实际路由审计、route receipt 和恢复真实性。

## 5. 现有测试为何未捕获

现有测试分别证明 planner/reviewer/executor/frontend 能请求并应用目标 route；本次 reviewer fallback 测试还验证了不完整证据包不会启动 child、Terra receipt 为 applied、route mode 为 `same-turn`、结果不得声称独立验收。

缺失的是共享生命周期与角色停止语义：

1. reviewer/planner 的短 scope 完成后，同一 turn 的下一普通 step 应恢复 base route。
2. executor/frontend 合法跨多个 step 时，只能在明确授权的工作 scope 内继续；完成、失败、取消、route-card consume/release 或职责停止事件后必须恢复。
3. 任一 upgrade 后发生 `agent/inbox/spliced`，新的直接用户消息不得无条件沿用旧职责 route。
4. 长工具回合中的后台通知、追问和状态请求不得被已经完成或失效的职责 scope 捕获。
5. session restart/resume 以最新 durable 临时 header 为 baseline 时，应恢复用户/base controller route，而不是把临时职责 route 当成选择。
6. 恢复必须包括 `reasoningEffort`、`maxTokens` 等完整 call config；不能只恢复 provider/model。
7. 真实 `agent-loop` 集成应验证每类职责的 header 序列，而不只让 fake `next()` 显式返回 base config。

现有测试证明“升级成功”，但没有证明“每类升级在正确时机结束”。

## 6. 修复目标与边界

### 必须满足

- 所有 in-place upgrade 都必须绑定显式 responsibility scope；仅绑定 `agent + turn` 不充分。
- scope 至少记录 `{ scopeId, turn, startStep, role, route, source, decision }`，并由角色策略定义继续条件与停止事件。
- reviewer/planner 的只读或判断型 scope 在其有界响应/receipt 完成后应消费；不能捕获后续普通 step。
- executor/frontend 若确需多 step，必须只在冻结或证据支持的工作边界内续用 route，并在完成、失败、取消、route-card consume/release、职责撤销或新任务边界出现时终止。
- 请求失败、route validation failure、abort、route mismatch 或无有效请求时必须释放或按显式 retry policy 处理，不能静默泄漏。
- scope 结束后的下一次 `agent/request` 必须使用宿主/base controller proposal，并恢复完整配置，包括 provider、model、reasoning effort 和输出预算语义。
- queued direct-human message 不得无条件继承旧 scope；runtime 必须先判断它是同一职责的明确继续，还是应交回 controller 的新输入。
- session resume/restart 不得把职责临时 route 当成用户选择的 base controller；当前真实会话没有自动恢复证据，不能依赖用户手动切换。
- 保留真实 `request/header` 审计：日志可记录实际职责 route，但首个 scope 外请求必须自动记录完整 base route。
- 不修改用户的 persisted responsibility mappings，也不通过让职责模型等于 controller 来掩盖生命周期错误。

### 不应采用

- 不要删除或伪造实际职责 `request/header`。
- 不要在 scope/turn end 无条件写虚构 base header；只有真实恢复请求发生时才能记录实际 header。
- 不要把所有职责统一限制为一个请求；executor/frontend 的合法多 step 工作需要明确 scope，而不是被破坏。
- 不要把所有 reviewer gap 都改成 child；证据包不足时 child 仍不得启动。
- 不要禁用职责映射或统一模型来掩盖 bug。
- 不要让 compaction 猜测哪个 header 是“临时的”；路由生命周期应在源头正确。

## 7. 候选修复方向

优先方案：把 `controllerUpgrades` 从无界 turn flag 改为显式 responsibility scope。

建议状态至少包含：

```js
{
  id: scopeId,
  turn,
  startStep,
  role,
  route,
  source,
  decision,
  state: 'pending' | 'claimed' | 'active',
  continuationPolicy,
  stopPolicy,
}
```

建议生命周期：

1. `agent/pre-step` 决定 in-place upgrade，创建带 role-specific policy 的 pending scope。
2. `agent/request` 只有在当前 request 满足该 scope 的 claim/continuation 条件时才应用职责 route。
3. `request/header` / `assistant/chunk` receipt 确认实际 route，并更新 scope 状态。
4. reviewer/planner 默认在有界判断响应完成后 consume；若产品确需多步，必须另有明确协议和上限。
5. executor/frontend 可在冻结工作边界内 active 多 step，但 route-card consume/release、交付完成、失败、取消、职责撤销、新任务或用户接管必须 stop。
6. `agent/request-error`、abort、turn end、无有效请求、route mismatch 均按显式 policy stop/release；同 step retry 必须有 retry token，不能靠整 turn 状态续命。
7. 新 direct-human inbox 到达时先执行 scope ownership 判定；不能把“仍在同一 DSH turn”当作继续授权。

角色策略应参数化测试，而不是复制四套状态机。reviewer 本次事故适合“一次模型响应后 consume”；executor/frontend 的确切停止事件应从 route card、artifact/acceptance 和现有职责合同推导，实施时不得自行降低原有完整交付能力。

另需明确 base route 的事实源。优先使用当次 `next()` 返回的宿主 proposal；不要从最新 `session.requestHeader()` 推断用户选择，因为该 header 可能正是临时职责 route。若 resume 必须重建用户选择，应使用 DSH 的 Agent options/default selection 或独立保存的 pre-scope base config，并验证该来源不会陈旧。

## 8. 回归测试矩阵

### 单元测试

- `reviewer short scope ends`：reviewer 响应/receipt 后，下一普通 request 为完整 base route。
- `planner short scope ends`：planner 判断完成后不捕获后续普通 step。
- `executor bounded scope continues and stops`：冻结 route card 内允许多 step；consume/release 后立即恢复 base。
- `frontend bounded scope continues and stops`：允许完成当前界面职责所需 step；职责完成或新任务边界后恢复 base。
- `queued inbox requires ownership decision`：四种角色 upgrade 后插入 direct-human message，不能因 turn 相同而自动继承。
- `scope receipt and stop are idempotent`：重复 receipt/stop 不复活、不误消费新 scope。
- `failure releases scope`：validation failure、provider failure、abort、mismatch、no-effective-request 均不泄漏。
- `retry is explicit`：同 step 合法 retry 可预测，跨 scope/无授权 step 绝不复用。
- `full config restored`：provider/model/reasoningEffort/maxTokens 均符合 base 与全局 output policy。

### DSH 集成测试

- 使用真实 `agent-loop` 和 session persistence，分别验证 planner/reviewer/executor/frontend 的职责 route 与 base route header 序列。
- reviewer 事故回归必须得到 `Sol/xhigh -> Terra/xhigh -> Sol/xhigh`，最后一步无需用户手动切换。
- 在每类职责 scope 中通过 inbox splice 加入用户追问或新任务，验证 ownership 判定与 controller 回收。
- 每类 scope 中断并 resume，断言首个 scope 外普通请求恢复 base route。
- 验证 UI/model directory 不把临时职责 route 写入用户 persisted default settings。
- 验证 compaction 在职责 route 与 base 恢复之间触发时的语义；若仍存在该窗口，必须明确它跟随实际当前请求还是 base route，并覆盖缓存行为。

### 双发行面

同一修复必须同步进入：

- `odai-dsh-plugin`
- `odai-dsh-agent`

两包版本必须一致，并分别运行 rc6/rc7 的隔离 load probe、session compatibility probe 和新增路由生命周期测试。

## 9. 验收条件

- A1：planner、reviewer、executor、frontend 的 in-place upgrade 都有显式 scope、继续条件和停止事件。
- A2：reviewer 事故路径最多产生完成该只读检查所需的 Terra 请求；首个 scope 外请求自动恢复 Sol/xhigh，不得要求用户手动切换。
- A3：executor/frontend 的合法多 step 能力保持，但 scope 完成或失效后不再影响任何后续请求。
- A4：同一运行中 turn 内追加的用户消息必须重新判断 scope ownership，不被旧职责无条件捕获。
- A5：session 日志真实记录职责请求与恢复请求，scope/route receipt 均可核验。
- A6：用户默认模型和 responsibility mappings 均未被修改。
- A7：失败、取消、重试、resume 和 queued inbox 路径在四种职责上均无 route 泄漏。
- A8：Plugin 与 Agent 两种发行面在 DSH rc6 和 rc7 上通过相同的生命周期回归。
- A9：现有 reviewer 证据包门保持：不完整 packet 不得启动 independent child，也不得声称独立验收。

## 10. 晚间续作顺序

1. 只同步本报告与 `odai-dsh-same-turn-route-leak-evidence.json`；不复制或上传原 session。
2. 在 `0.2.0` 源码上确认 planner/reviewer/executor/frontend 的所有 `inPlaceUpgrade` 入口与共享 `controllerUpgrades` 实现。
3. 按 3.1 的最小配方新增 reviewer 失败测试，再为其余三种职责建立参数化生命周期测试。
4. 实现显式、role-aware 的 responsibility scope 生命周期；短 scope 可一次性 consume，多 step scope 必须有停止事件。
5. 补失败、retry、queued inbox、resume、幂等 stop 和完整 config 恢复测试。
6. 运行 runtime 全量测试、两个 DSH package 测试、rc6/rc7 load probes 与 pack dry-run。
7. 检查 session header、route receipt、用户默认模型和 mappings，确认审计真实性与用户选择均保持。
8. 两包同步升版、更新兼容说明并发布；发布后在新的真实 Web 会话复测一次。

## 11. 临时规避

修复发布前：

- 发现当前会话被任一职责模型原地升级且没有按预期退出后，用户可在模型选择器显式切回基础 controller。
- 不建议把 planner/reviewer/executor/frontend mapping 永久改成 controller 模型；这会隐藏生命周期 bug，并失去职责模型隔离。
- 长任务运行期间追加新消息时，若界面仍显示旧职责模型，应先确认当前 route，再继续高影响操作。
