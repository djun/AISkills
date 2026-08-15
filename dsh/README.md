# odai on DeepSeek Harness

The DSH integration has two independently published user surfaces and one internal source owner:

| Directory | Package | Scope | Installs |
|---|---|---|---|
| `runtime/` | none | canonical DSH implementation source | nothing |
| `plugin/` | `odai-dsh-plugin` | every agent in one DSH profile | profile bundle |
| `agent/` | `odai-dsh-agent` | sessions selecting the Odai preset | user agent preset |

The provider-neutral `cli/` remains a separate product and is not part of this subtree.

Both published DSH surfaces default routing to `auto` while keeping the governance skill source pinned to `bundled`; neither ships a planner, executor, or reviewer model mapping. Ordinary requests stay on the selected controller. A complete contextual decision gap upgrades that same turn only when the user has configured its responsibility model; explicit independent gaps still delegate when configured. If a needed responsibility is unconfigured, Odai names it and asks the user for a natural-language provider/model choice. A missing or failed high-impact route makes the controller read-only instead of silently proceeding.

## Install and use

Choose one surface for the scope you need. The Plugin manager requires `pnpm` on `PATH`; the Agent installer currently requires exactly `dsh@0.1.0-rc.6`.

```sh
# Profile-wide: every agent preset in this DSH profile
dsh plugin --profile web add odai-dsh-plugin

# Agent-scoped: install a selectable Odai preset
npx odai-dsh-agent install
```

For Plugin, start a new DSH process after installation and use that profile normally. The Agent preserves every capability from the pinned DSH Standard preset and adds Odai as a scoped extension; open a new DSH session and select `Odai` from the Agent preset picker. Then submit ordinary task requests; neither surface requires a routing command or special trigger wording. Current releases keep Odai audit evidence outside DSH's core event vocabulary. Before updating or removing an older Plugin, stop every DSH process and run `npx odai-dsh-plugin repair-sessions --yes` once so recognized historical Odai audit events receive DSH's official ignorable marker and a verified backup is retained; unknown Odai event types fail closed. The repair additionally refuses when local process inspection fails or finds DSH still running; keep DSH stopped until it exits.

Configure optional responsibility models by speaking naturally, for example:

```text
规划用 provider-x/model-plan，推理档 high。
执行改用 provider-y/model-execute。
验收用 provider-z/model-review。
```

Odai persists only the mapping the user explicitly names. A change applies from the next user turn. The Plugin already includes the canonical skill and runtime; the Agent also includes both and does not require the Plugin. Installing both is normally redundant.

An independently installed complete Odai skill bundle can update faster than either package without changing existing defaults. The user must explicitly ask to set the source to `auto` or `user`; `odai_skill_source_config` persists that choice in `$DSH_HOME/odai/source.json`. Project `.dsh/skills/odai` and `.agents/skills/odai` bundles participate only in `auto` and remain scoped to the current session cwd. The package READMEs define the complete precedence, manifest, compatibility, and fallback contract.

Controller output policy is also user-owned and disabled by default. `odai_output_config` can persist explicit concise presentation and/or a positive hard controller `maxTokens` ceiling in `$DSH_HOME/odai/output.json`; changes apply from the next user turn and never alter child-agent or compaction budgets. Provider APIs may count hidden reasoning inside a hard ceiling, so the runtime warns about truncation and never chooses a value for the user.

## Ownership

- `skills/odai/` is the only editable governance and role-contract source.
- `dsh/runtime/src/` is the only editable DSH adapter, guard, evidence, and automatic-routing implementation.
- `scripts/package-odai-artifact.mjs` generates package-local runtime and skill copies during lifecycle packaging.
- `scripts/run-package-pack.mjs` removes declared generated roots in `finally`, including when a dry-run pack fails before `postpack`.
- Generated copies under `dsh/plugin/{runtime,skills}` and `dsh/agent/preset/odai/{runtime,skills}` are ignored and never tracked.

No user-facing package depends on another Odai package:

- Plugin-only installation contains its canonical skill and runtime; no separate skill or Agent install is required.
- Agent-only installation contains its canonical skill and runtime, needs no Plugin, and does not edit a profile.
- Plugin is profile-wide; Agent is preset-scoped. Installing both is normally redundant and should be reserved for a deliberate combination of those scopes. Shared evidence under `$DSH_HOME/odai/session-evidence/` deduplicates that case without adding private event types to DSH's core session log.

Users configure optional responsibilities by speaking normally, for example, `规划用 provider/model，推理档 high` or `验收模型改成 provider/model-review`. The controller calls `odai_routing_config`; it must not choose a model that the user did not specify. Mappings persist in `$DSH_HOME/odai/routing.json`, outside both managed package artifacts, and take effect on the next user turn. Users never edit that file directly. If the store is invalid, governance still loads; a needed route fails closed, and the next explicit natural-language `set` preserves the invalid copy and repairs the store.

## Verification

```sh
node --test dsh/runtime/tests/*.test.mjs
npm --prefix dsh/plugin run verify:dsh
npm --prefix dsh/agent test
npm --prefix dsh/agent run verify:dsh
node scripts/verify-dsh-coexistence.mjs
npm --prefix dsh/plugin run pack:dry-run
npm --prefix dsh/agent run pack:dry-run
```

The coexistence probe uses a temporary `DSH_HOME`: it packs and installs the real Plugin into a temporary Web profile, installs the Agent preset into the same home, and proves an Agent-scoped non-bundled project skill atomically supplies both prompt governance and routing role contracts while the profile-wide Plugin remains bundled for Standard sessions.

Both packages currently pin `@deepseek-ai/dsh@0.1.0-rc.6`. A DSH version update must refresh the Agent composition from that version's `standard` preset and rerun both isolated load probes.
