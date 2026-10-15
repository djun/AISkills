# 宿主路由的安装与配置

用户要求为 Codex、Claude Code 或 Copilot 安装、更新、卸载或修复职责路由时读取。安装本技能和 `odai` 只使规则与脚本可发现，不自动修改宿主配置；DSH 已内置编排时使用其现有能力，不运行这里的安装器。

1. 从宿主确认实际模型、能力与作用域。controller、planner、reviewer 显式映射，researcher、frontend 和 creative 按需选择，默认不生成，也不从其他职责继承映射；creative 只读，交回内容由总控核对后落盘；从真实模型目录核对，不虚构模型 ID。默认当前项目，跨项目作用域须明确授权。
2. 先用 `scripts/build-routing.mjs --help` 查看生成接口；治理安装位置不相邻时显式传入 `--governance-root`。
3. 需要持久安装、更新或卸载时使用 `scripts/install-routing.mjs --help` 对应入口，说明映射、写入范围与新会话生效条件。已有授权覆盖本次动作时直接执行；否则完成准备后取得授权。
4. 按安装结果在新会话核对真实角色和模型的实际调用。生成文件和配置成功只证明文件生成，不证明路由已调用。托管清单负责更新、漂移检查、卸载与恢复，遇到外部修改不覆盖。

## Claude Code 总控调用本机 CLI

`build-routing.mjs` 与 `install-routing.mjs` 在 `--host claude` 下接受非 controller 职责的 `--<role>-cli <codex|antigravity|grok>`，必须同时显式提供该职责的 `--<role>-model`；`--<role>-effort` 可选。未指定 CLI 的职责仍使用 Claude Code 原生子代理，controller 始终保持原生。其他宿主不接受这些 CLI 选项，`claude` 不作为本机目标重复配置。

例如，先在临时输出目录生成 Claude Code 总控与 planner、由 Codex 承担 reviewer 的配置（模型名替换为已确认可用的 ID）：

```sh
node skills/odai-orchestration/scripts/build-routing.mjs \
  --host claude --out <临时输出目录> \
  --controller-model <Claude模型> --planner-model <Claude模型> \
  --reviewer-cli codex --reviewer-model <Codex模型> --reviewer-effort high
```

取得目标项目安装授权后，用相同的模型与 CLI 参数调用 `install-routing.mjs --host claude --scope project --target <项目目录> … --yes`。已有安装通过安装器更新；生成器遇到旧输出中相反后端的文件会拒绝并要求新的 `--out` 目录，避免留下同名原生代理。用户级安装使用 `--scope user --target <配置目录>`，其调用说明与权限指向配置目录内执行器的绝对路径。

本机职责不生成同名原生代理；安装器管理 `.claude/odai-run-role.mjs`、`.claude/odai-local-cli.mjs`、角色合同与路由清单，并向宿主设置的 `permissions.allow` 合并执行器 Bash 权限。既有权限与其他设置保留；更新、漂移检查和卸载覆盖新文件，卸载仅撤回安装器新增的权限。存在非托管的同名原生代理时拒绝安装，不覆盖它。

总控把有界任务包写入文件，再按生成的 controller 说明调用，例如：

```sh
node .claude/odai-run-role.mjs --role reviewer --input <任务包文件> \
  --evidence <证据文件> --output <正文文件>
```

执行器把角色合同和任务包交给目标 CLI，所有职责均只读；制作任务只能交回未应用补丁，由总控核对落盘。需要先安装并登录目标 CLI；子进程继承 Claude Code 的环境变量，需要代理时应在启动 Claude Code 的环境中配置 `HTTPS_PROXY` 等变量。可执行文件分别由 `ODAI_CODEX_COMMAND`、`ODAI_AGY_COMMAND`、`ODAI_GROK_COMMAND` 覆盖。默认超时 1200 秒，`--timeout` 接受 1–7200 整数秒。

执行器输出 version 1 证据；省略 `--evidence` 时持久保存在执行器同目录 `role-evidence/`，路径写到 stderr。证据是运行产物，卸载保留。只有调用完成、正文非空且实际模型核实时才输出正文并退出 0；能取得推理档证据的 CLI 出现推理档不一致时同样失败。失败退出非 0，不输出正文、不覆盖已有正文文件。Codex 通过本次会话的模型与推理档取证；Antigravity 和 Grok 目前只能把推理档记为 `requested-only`，证据如实记录、不阻断回交，与 DSH 的规则一致。

Antigravity 使用计划模式并禁用斜杠命令展开，制作请求可能返回实施计划；其浏览器、联网和生成工具是否全部受只读限制尚未逐项实测。Grok 适配继续标注**按官方文档及既有评测证据实现，当前适配未实测**：优先取 JSON `modelUsage`，缺失时回退会话 summary；格式不符或证据缺失就失败。各 CLI 自身的会话或计划目录可能产生运行记录，只读边界针对被委托项目。

安装只启用按缺口选择的分工，不注入每轮必走流程。没有宿主适配或无法取得所需能力时，治理仍独立工作：继续安全可完成的部分，准确交付剩余缺口；不要把技能已安装、角色已配置或一次自报当成调用和收益证明。
