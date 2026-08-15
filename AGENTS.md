# 仓库维护约束

## odai 必用

- 本仓库中的每次用户请求都必须使用 canonical `skills/odai/SKILL.md` 治理。若宿主明确声明当前 `odai-dsh-agent` 或 `odai-dsh-plugin` 已把完整 canonical governance 注入系统提示，并给出 skill version、runtime contract 与 bundle digest，则该注入本身视为已完整加载；声明有效且本会话未改动 canonical bundle 期间，不得再调用 skill 或 `read` 重复载入同一正文。仅当注入声明缺失或不可信、任务直接审查或修改 Odai、或 manifest 声明的 canonical 文件在注入后发生变化时，才须在行动前完整读取当前 `SKILL.md`，并以新内容继续治理。其他宿主若当前任务尚未完整读取其当下版本，任何调查、判断、修改或测试前先完整读取。
- 按 odai 的真实缺口决定是否读取支撑资料；使用 odai 不等于自动增加计划、路由、角色、文件、测试或流程，简单任务仍直接完成。
- 对 odai 自身及其配套机制的修改同样受 odai 治理：先判断是否必要、是否比现状更成事、是否有可验证净增益，再决定保留、修改或退役，不因已有实现、历史方案、题本得分或局部可实现性继续堆叠。
- 评测维护、题本设计、裁判与报告整理仍按上述要求治理；真正受测的 runner 则严格服从冻结的评测臂，不继承本节。`on` 只加载该臂声明的冻结 skill 与项目材料；`off` 必须在干净隔离环境运行，不读取或注入 odai、`.odai/local.md`、odai 路由或 Hooks、要求使用 odai 的仓库指令、其他臂输出、既往 runner 转录或其派生状态。

## 官方 skills 单一事实源

- `skills/odai/` 与 `skills/ribao/` 是各自唯一可编辑的 canonical source；odai 是统一入口与最终交付 owner，ribao 是可独立加载的专业汇报能力。
- `cli/skills/` 不在仓库中常驻；它只由 npm `prepack` 临时生成，并在 `postpack` 清理。
- 即使用户或 IDE 指向打包期间临时出现的 `cli/skills/`，也要把对应修改落到仓库根 `skills/<name>/`。
- source 修改完成后，运行 `node scripts/validate-odai-skill.mjs` 验证 canonical skills。
- 发布相关修改还需运行 `npm --prefix cli run pack:dry-run`，确认产物与当前声明的打包范围一致，且命令结束后没有遗留 `cli/skills/`。

## DSH 集成修改边界

- `odai-dsh-plugin` 与 `odai-dsh-agent` 的问题必须在本仓库内解决；修复实现、兼容层、配置、补丁、测试和文档只能落到本项目受版本控制的文件中。
- DeepSeek Harness 的源码 checkout、全局或本地安装包、`node_modules/@deepseek-ai/dsh` 及其核心文件一律只读，只能用于定位行为、核对契约和运行兼容性验证；不得直接修改、打补丁或用本机改造后的 DSH 冒充本项目修复。
- 必须处理 `$DSH_HOME` 中既有用户数据时，只能通过本项目内受版本控制、可审计并带备份与验证的迁移入口执行；迁移须遵守用户授权和停机要求，不得手工篡改 DSH 会话、profile 或核心状态来绕过问题。
