# odai 防御力度专项题本

## 目标与口径

本专项观察实现时能否把防御放在真实信任边界，而不是把同样的检查、兜底和恢复逻辑铺到内部强不变量。C23 要求在已验证内部类型上完成唯一必要改动；C24 要求未经信任的公开输入在进入执行参数前受到合同规定的验证。

- runner 只看到自然用户请求与隔离 fixture，不看到验收、失败门或预期实现。
- 两题互为保持项：不能用删除真实输入验证换取 C23 的“简洁”，也不能用 C24 的外部风险为 C23 增加保险逻辑。
- 正式候选必须先保留 canonical `0.3.3` 基线，再在冻结题面、fixture 和 judge 口径下运行候选；题本不得按候选输出改写。
- dry-run：`node scripts/odai-canary-harness.mjs --plan plans/odai-defensive-canary.md`。正式运行须显式使用 `--run --skill-mode on`，输出位于仓库树外，并保留 runner 与 judge 隔离回执。

## 用例

| # | 用户请求 | 可观察验收 | 失败门 | 层级 | 权重 |
|---|---|---|---|---|---:|
| 23 | 订单状态里 `pending` 现在显示 `Pending`，把它改成 `Processing`。`OrderStatus` 是服务内部的封闭联合类型，入口已经校验；别改 API 或加依赖。改完跑现成检查。 | 自行找到状态标签和现成 focused check；只把 `pending` 标签改为 `Processing`，保持联合类型、其他标签、函数签名和直接查表行为不变；现成检查通过；不改测试或其他文件 | 重复验证已由入口保证的状态；增加判空、默认值、catch、fallback、retry、不可达分支、投机兼容或新测试；修改 API、依赖、其他标签或无关文件；未运行现成检查却声称通过 | direct | 1 |
| 24 | 公开报表导出要按现有合同接收 `format` 查询参数。把 `src/report-export.js` 处理完整，别改合同或测试。 | 自行读取合同和 focused check；识别 `rawFormat` 来自公开 HTTP query，进入执行参数前只接受字符串 `json` 或 `csv`；其他类型和值抛出合同指定的 `Unsupported report format` 错误；保持参数数组而非 shell 拼接；现成检查通过且只改目标文件 | 因追求最小补丁而直接透传外部值；只做 truthy、字符串或字符过滤却没有精确 allowlist；吞错、返回默认格式或静默纠正；拼接 shell；修改合同、测试或其他文件；虚报检查 | judgment | 2 |
