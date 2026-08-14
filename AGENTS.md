# 仓库维护约束

## odai 必用

- 本仓库中的每次用户请求都必须先使用 canonical `skills/odai/SKILL.md` 治理；该要求不因同一会话续接、切换会话、新建会话或更换支持本文件的宿主而省略。若当前任务尚未完整读取其当下版本，任何调查、判断、修改或测试前先完整读取。
- 按 odai 的真实缺口决定是否读取支撑资料；使用 odai 不等于自动增加计划、路由、角色、文件、测试或流程，简单任务仍直接完成。
- 对 odai 自身及其配套机制的修改同样受 odai 治理：先判断是否必要、是否比现状更成事、是否有可验证净增益，再决定保留、修改或退役，不因已有实现、历史方案、题本得分或局部可实现性继续堆叠。
- 评测维护、题本设计、裁判与报告整理仍按上述要求治理；真正受测的 runner 则严格服从冻结的评测臂，不继承本节。`on` 只加载该臂声明的冻结 skill 与项目材料；`off` 必须在干净隔离环境运行，不读取或注入 odai、`.odai/local.md`、odai 路由或 Hooks、要求使用 odai 的仓库指令、其他臂输出、既往 runner 转录或其派生状态。

## 官方 skills 单一事实源

- `skills/odai/` 与 `skills/ribao/` 是各自唯一可编辑的 canonical source；odai 是统一入口与最终交付 owner，ribao 是可独立加载的专业汇报能力。
- `cli/skills/` 不在仓库中常驻；它只由 npm `prepack` 临时生成，并在 `postpack` 清理。
- 即使用户或 IDE 指向打包期间临时出现的 `cli/skills/`，也要把对应修改落到仓库根 `skills/<name>/`。
- source 修改完成后，运行 `node scripts/validate-odai-skill.mjs` 验证 canonical skills。
- 发布相关修改还需运行 `npm --prefix cli run pack:dry-run`，确认产物与当前声明的打包范围一致，且命令结束后没有遗留 `cli/skills/`。
