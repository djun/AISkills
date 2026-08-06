# 仓库维护约束

## 官方 skills 单一事实源

- `skills/odai/` 与 `skills/ribao/` 是各自唯一可编辑的 canonical source；odai 是统一入口与最终交付 owner，ribao 是可独立加载的专业汇报能力。
- `cli/skills/` 不在仓库中常驻；它只由 npm `prepack` 临时生成，并在 `postpack` 清理。
- 即使用户或 IDE 指向打包期间临时出现的 `cli/skills/`，也要把对应修改落到仓库根 `skills/<name>/`。
- source 修改完成后，运行 `node scripts/validate-odai-skill.mjs` 验证 canonical skills。
- 发布相关修改还需运行 `npm --prefix cli run pack:dry-run`，确认产物与当前声明的打包范围一致，且命令结束后没有遗留 `cli/skills/`。
