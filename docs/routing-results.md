# odai DSH 能力路由报告

更新时间：2026-08-14

本报告只记录 DeepSeek Harness（DSH）能力路由的产品契约、机械验证和冻结对照。普通单模型全量与 A/B 结果见 [`evaluation-results.md`](evaluation-results.md)。单次路由样本用于证明真实换模、边界、质量和资源足迹，不用于宣称路由稳定优于单一充分能力总控。

## 当前发布契约

### 默认行为

- Plugin 与 Agent 都默认使用 `auto`，但不内置 planner、executor 或 reviewer 的 provider、model、reasoning effort、maxTokens。
- controller 是 DSH 当前 session/profile 选择的持续任务线程，不是固定模型，也不由 Odai 的责任映射工具改写。
- 普通请求由 controller 直接闭环。风险、任务规模或角色词本身不会增加模型调用。
- 完整的高影响判断缺口在 planner 映射存在时升级同一 controller turn，不启动 child；明确要求独立规划或复核时，独立性本身是能力要求，因此使用 child。
- executor 只在路线已经冻结、实施有界且交接有可观察净收益时成立；不会仅从“请执行”三个字推断。

### 用户配置

用户只需自然指定责任与模型，例如：

```text
规划用 provider-x/model-plan，推理档 high。
执行改用 provider-y/model-execute。
验收用 provider-z/model-review。
```

controller 调用 `odai_routing_config` 完成 `show`、`set` 或 `remove`。映射写入 `$DSH_HOME/odai/routing.json`，由 Plugin 与 Agent 共用，从下一轮用户请求生效。用户不编辑 YAML、JSON、Plugin patch 或 Agent preset，模型也不得代替用户选择 provider、model、推理档或 token 上限。

未使用的未配置责任不产生启动提示。真实 gap 需要某项责任而该项未配置时，runtime 记录 `odai/route-config-missing`，明确没有调用该模型，也不产生虚假的 `odai/route-upgrade` 或 `odai/route-result`。高影响 planner、executor、reviewer 缺口同轮只读；低影响工作只能继续完成不依赖该独立责任的部分。

损坏的用户 routing store 不会阻止 canonical prompt、child guard 或配置工具加载。需要路由时该 store 被视为不可信并 fail-closed；用户下一次自然指定映射后，工具保留损坏副本并重建有效 store。共享 store 的 set/remove 使用跨进程锁和原子替换，避免 Plugin 与 Agent 并发更新丢失。

### 模式

| 模式 | 模型行为 | 高影响保护 |
|---|---|---|
| `off` | 不做任务路由；保留治理、child boundary 和用户请求的配置工具 | 不读取旧 route protection |
| `observe` | 本地判断并注入证据协议；不换模型、不启动 child | 未解决的高影响 gap 同轮只读 |
| `auto`（默认） | 普通请求 direct；配置后的上下文判断缺口同 turn upgrade；明确独立 gap 使用 child | 缺失、失败或不可信 route 同轮只读 |
| `execute` | 非 direct gap 统一交给已配置的 child route | 同上 |

### 真实路由证据

- 同 turn upgrade：只认 controller session 的 durable `request/header`；`odai/route-upgrade.requestedRoute` 只表示选择意图。
- child delegation：runtime 核对 child durable header 中的 provider、model 和 reasoning effort；不符、缺失、异常停止、空文本或 cleanup 失败都不注入为可信证据。
- Plugin 与 Agent 同时存在时，prompt 按 scope shadow，route/tool event 按 durable identity 去重，权限拒绝保持单调。两者通常不需要同时安装。

## 当前机械验证

| 验证面 | 结果 | 证明范围 |
|---|---:|---|
| Plugin runtime/package tests | 38/38 | direct、缺失配置、同 turn upgrade、child route、三责任 fail-closed、损坏 store 修复、共享 store 与写锁 |
| Agent installer tests | 5/5 | 安装、更新、漂移保护、状态与卸载 |
| runner/package tests | 3/3 | Plugin/Agent 隔离和失败清理 |
| Plugin DSH load | 通过 | 真实 DSH 工具注册、child/controller guard、配置落盘 |
| Agent Web load | 通过 | scoped prompt、guard 隔离、live session 调用 `odai_routing_config` 并落盘 |
| Plugin/Agent pack dry-run | 通过 | 两个包均包含 canonical skill、runtime 与 `routing-config.mjs`，生成目录在结束后清理 |

这组验证证明当前发布机制和安全边界，不替代付费模型质量样本。取消内置映射后没有追加 live 模型调用；下面的模型样本都明确使用了冻结测试映射。

## 冻结质量与成本证据

### 简单任务负向纪律

C01 使用 Luna/max controller，并显式配置 Sol/high planner、Luna executor 与 Terra/high reviewer。题面没有独立缺口，结果只运行 controller，4/4，未启动其他责任。

| Case | 分数 | 实际模型 | runner token | 非缓存输入 + 输出 | 墙钟 | 估算成本 |
|---|---:|---|---:|---:|---:|---:|
| C01 | **4/4** | Luna/max 100%；Sol/Terra 0 | 72,662 | 11,222 | 52.8s | $0.0044 |

结论：可靠直答和单一权威来源查询不应为展示路由而升档。

### 原始 C04 八臂冻结对照

八臂保持 canonical C04、fixture、独立 Sol/high judge 和单样本口径，不做 best-of。D/H 的 child durable header 与 `odai/route-result.actualRoute` 均验证为 OpenAI Sol/high；Agent 臂只安装 session-scoped Agent，不加载全局 Plugin。

| 臂 | Treatment | 实际路由 | 分数 | critical | runner token | 墙钟 | 估算成本 | diff |
|---|---|---|---:|---|---:|---:|---:|---:|
| A | DSH Luna/max，odai off | 单 Luna | 0/4 | 是 | 117,245 | 101.9s | $0.0069 | 1 |
| B | Plugin，Luna/max，routing off | 单 Luna | **4/4** | 否 | 137,066 | 143.0s | $0.0135 | 0 |
| C | Plugin，Sol/high，routing off | 单 Sol | **4/4** | 否 | **89,622** | **68.5s** | $0.1604 | 0 |
| D | Plugin，Luna/max，execute | Luna -> Sol child -> Luna | **4/4** | 否 | 153,607 | 137.7s | $0.1156 | 0 |
| E | Plugin，Luna/max，旧 observe | planner 命中，不 spawn | 2/4 | 否 | 189,186 | 189.8s | $0.0201 | 0 |
| F | Codex Sol/high + odai | 单 Sol | **4/4** | 否 | 118,219 | 83.9s | $0.2061 | 0 |
| G | Agent-only，Luna/max，旧 observe | planner 命中，不 spawn | 1/4 | 是 | 155,646 | 94.5s | $0.0125 | 1 |
| H | Agent-only，Luna/max，execute | Luna -> Sol child -> Luna | **4/4** | 否 | 211,252 | 160.0s | $0.2211 | 0 |

D、E、G、H 都从原始自然语言命中 `PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE`。D/H 证明 Plugin 与 Agent 的 execute 换模链路真实成立；B/C 说明 governance 或单一强 controller 也可能足够，不能从一题一份样本推出 execute 稳定更优。旧 observe 的 E/G 暴露了保护缺口，现已由逐 turn read-only guard 修复。

### C04 execute 与同 turn auto

| Treatment | 实际模型链路 | 分数 | critical | runner token | 墙钟 | 估算成本 | diff |
|---|---|---:|---|---:|---:|---:|---:|
| 冻结 C：Plugin single Sol | Sol | **4/4** | 否 | 89,622 | 68.5s | $0.1604 | 0 |
| 冻结 D：Plugin execute | Luna -> Sol child -> Luna | **4/4** | 否 | 153,607 | 137.7s | $0.1156 | 0 |
| 冻结 H：Agent execute | Luna -> Sol child -> Luna | **4/4** | 否 | 211,252 | 160.0s | $0.2211 | 0 |
| H-rerun：Agent execute | Luna -> Sol child -> Luna | **4/4** | 否 | 229,946 | 128.8s | $0.2756 | 0 |
| **Agent auto** | **同一 controller turn 直接 Sol** | **4/4** | **否** | **90,193** | **65.6s** | **$0.2072** | **0** |

相对冻结 H，auto token 减少 57.3%、墙钟减少 59.0%、估算成本减少 6.3%；相对 H-rerun 分别减少 60.8%、49.1% 和 24.8%。auto 与单 Sol C 的 token 只差 0.6%，说明父 controller 读题、child 重读、父再读回交的双 session 处理量已经结构性移除。

现金成本仍受 uncached input、cached input 和 output 分布显著影响：冻结 D 曾因 cache 命中低于单 Sol 与 auto，不能承诺固定降幅。能承诺的是同 turn upgrade 不再支付第二个 session 的重读与回交处理量。该 Sol/high 是明确测试映射，不是当前包的内置默认。

### observe fail-closed 修复

| Treatment | 实际路由 | 分数 | critical | runner token | 墙钟 | 估算成本 | diff |
|---|---|---:|---|---:|---:|---:|---:|
| 修复后 Plugin observe | 单 Luna；planner gap + 本地证据协议 + 只读保护 | **4/4** | 否 | 130,243 | 108.8s | $0.0142 | 0 |

该样本证明 observe 可以在不增加 Sol 调用的情况下安全闭环这份 C04，但不提供独立 planner 证据，也不证明 observe 稳定 4/4。当前 runtime 已把同一高影响保护扩展到 planner、executor 和 reviewer 的缺失或失败路线。

### executor 有界迁移对照

| 场景 | 实际责任与模型 | 结果 | runner token | 墙钟 | 估算成本 |
|---|---|---|---:|---:|---:|
| 12 文件冻结迁移 | Sol/high controller -> Luna/max executor | 只改 12 个目标值；项目测试通过 | 218,731 | 222.9s | $0.213 |
| 同一迁移单模型对照 | Sol/high controller | 同等改动与验证结果 | 137,261 | 63.6s | $0.201 |

executor 分流真实发生且没有降低质量，但相对单 Sol 多用 59.4% runner token、墙钟约 3.5 倍、估算成本高 6.0%。因此“冻结且有界”只是必要条件；还须有上下文隔离、并行、权限差额或已实测资源收益之一，才值得真正交给 executor。

## 历史架构摘要

### 强制高级模型前置（已退役）

历史压力对照让 Luna/max 进入、Sol/high 每题前置判断、Luna/high 承担少量执行、Terra/high 按需验收。19 题全部先调用 Sol，只有 C10、C15、C16 再启动 executor，reviewer 未启动。

| 路线 | 分数 | 总处理 token | 非缓存输入 + 输出 | 墙钟 | 估算成本 |
|---|---:|---:|---:|---:|---:|
| 强制前置路由 | **144/144** | 7,201,838 | 1,074,222 | 39.6m | $5.512 |
| 单 Sol | **144/144** | 3,698,792 | 554,088 | 31.1m | $6.005 |

强制前置多用 94.7% 总处理 token、非缓存输入加输出多用 93.9%、墙钟增加 27.3%，现金成本只降低 8.2%。它测到的是低价 controller 与强制高级模型组合的压力上界，不是当前按需路由，已退役。

### 前代 stage 高风险退款任务

| 路线 | 验收 | runner token | 墙钟 | 估算成本 |
|---|---:|---:|---:|---:|
| 单 Sol/high controller | **4/4** | 326,960 | 240.7s | $0.788 |
| Sol/high 定路 -> Luna/max 有界实施 | **4/4** | 325,249 | 390.5s | $0.212 |

前代 stage 相对单 Sol token -0.5%、墙钟 +62.2%、估算成本 -73.1%。它证明有界新上下文可能降低现金成本，也证明延迟未必改善；样本形成于当前同 turn auto、结构化回交和 DSH runtime 之前，只保留为历史定向证据。

## 结论与限制

1. 单一充分 controller 仍是普通任务默认；路由只补真实且已配置的责任缺口。
2. 同 turn auto 在 C04 中移除了双 session 处理链，并保持 4/4；它不证明所有任务都更便宜或更稳定。
3. execute 已在 Plugin 与 Agent 两个分发面证明真实 child 换模，但当前样本没有证明普遍质量或资源净收益。
4. observe 的价值是诊断、证据协议和 fail-closed，不是独立判断的替代品。
5. 当前发布不选择任何责任模型。历史 Sol/Luna/Terra 都是冻结实验映射，不应被读成包默认。
6. 质量与成本结论只覆盖表中样本；provider cache 命中和输出长度会显著改变单次现金成本。
