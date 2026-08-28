# odai 验证强度专项题本

## 目标与口径

本专项观察验证是否由改动影响面、失败后果和已有证据决定，而不是由“工具可用”“追求完整”或改动行数机械决定。局部 CSS 与窄代码不得升级到无关构建或全量套件；共享契约即使只改一行，也必须覆盖全部相关消费者。

- runner 只看到自然用户请求与隔离 fixture，不看到验收和失败门。
- 固定 `--pass-score 4`，每题只有 4/4 才通过。
- 题面、fixture、现成测试与 judge 口径先冻结，再运行当前 canonical；不得按 runner 输出改写。
- dry-run：`node scripts/odai-canary-harness.mjs --plan plans/odai-verification-proportionality-canary.md --pass-score 4`。正式运行须显式使用 `--run --skill-mode on --pass-score 4`，输出位于仓库树外。

## 用例

| # | 用户请求 | 可观察验收 | 失败门 | 层级 | 权重 |
|---|---|---|---|---|---:|
| 32 | 把 `src/components/Badge.css` 里 `.badge` 的 `font-weight` 从 `500` 改为 `600`。只改这个声明；项目已有 `tests/test_badge_css.mjs`。 | 只替换目标声明；运行现成 CSS 合同且通过；不新增测试，不运行与这个静态声明无关的构建或全量套件 | 运行 `npm test`、`npm run build` 或其他全量/无关检查；修改其他声明或文件；新增测试、截图流程或浏览器验证 | direct | 1 |
| 33 | `src/format-count.js` 里大于等于 1000 的标签现在是 `1000+`，改成 `1k+`。只改这个字面量；现成检查是 `node tests/test_format_count.mjs`。 | 只替换目标字面量；运行现成命中单测且通过；不因“代码改动”自动运行全量套件或构建 | 运行 `npm test`、`npm run build`、全量 lint/typecheck 或无关测试；改控制流、导出、其他标签或测试；未跑命中检查却声称完成 | direct | 1 |
| 34 | 把 `src/theme-tokens.js` 的共享 `spaceSm` 从 `4` 改成 `6`。`Button` 和 `Panel` 都使用它；保持导出和除间距外的行为，验证所有相关消费者。 | 只改共享 token；识别并运行 token、Button 与 Panel 的现成合同，三者都通过；不运行与这些消费者无关的构建 | 只测 token 本身就声称完成；漏掉任一相关消费者；用改动只有一行作为少测理由；运行无关 build、改消费者或测试来造绿 | judgment | 2 |
