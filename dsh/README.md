# odai on DeepSeek Harness

The DSH integration has two independently published user surfaces and one internal source owner:

| Directory | Package | Scope | Installs |
|---|---|---|---|
| `runtime/` | none | canonical DSH implementation source | nothing |
| `plugin/` | `odai-dsh-plugin` | every agent in one DSH profile | profile bundle |
| `agent/` | `odai-dsh-agent` | sessions selecting the Odai preset | user agent preset |

The provider-neutral `cli/` remains a separate product and is not part of this subtree.

Both published DSH surfaces default to `auto` but ship no planner, executor, or reviewer model mapping. Ordinary requests stay on the selected controller. A complete contextual decision gap upgrades that same turn only when the user has configured its responsibility model; explicit independent gaps still delegate when configured. If a needed responsibility is unconfigured, Odai names it and asks the user for a natural-language provider/model choice. A missing or failed high-impact route makes the controller read-only instead of silently proceeding.

## Install and use

Choose one surface for the scope you need. The Plugin manager requires `pnpm` on `PATH`; the Agent installer currently requires exactly `dsh@0.1.0-rc.6`.

```sh
# Profile-wide: every agent preset in this DSH profile
dsh plugin --profile web add odai-dsh-plugin

# Agent-scoped: install a selectable Odai preset
npx odai-dsh-agent install
```

For Plugin, start a new DSH process after installation and use that profile normally. The Agent preserves every capability from the pinned DSH Standard preset and adds Odai as a scoped extension; open a new DSH session and select `Odai` from the Agent preset picker. Then submit ordinary task requests; neither surface requires a routing command or special trigger wording.

Configure optional responsibility models by speaking naturally, for example:

```text
规划用 provider-x/model-plan，推理档 high。
执行改用 provider-y/model-execute。
验收用 provider-z/model-review。
```

Odai persists only the mapping the user explicitly names. A change applies from the next user turn. The Plugin already includes the canonical skill and runtime; the Agent also includes both and does not require the Plugin. Installing both is normally redundant.

## Ownership

- `skills/odai/` is the only editable governance and role-contract source.
- `dsh/runtime/src/` is the only editable DSH adapter, guard, evidence, and automatic-routing implementation.
- `scripts/package-odai-artifact.mjs` generates package-local runtime and skill copies during lifecycle packaging.
- `scripts/run-package-pack.mjs` removes declared generated roots in `finally`, including when a dry-run pack fails before `postpack`.
- Generated copies under `dsh/plugin/{runtime,skills}` and `dsh/agent/preset/odai/{runtime,skills}` are ignored and never tracked.

No user-facing package depends on another Odai package:

- Plugin-only installation contains its canonical skill and runtime; no separate skill or Agent install is required.
- Agent-only installation contains its canonical skill and runtime, needs no Plugin, and does not edit a profile.
- Plugin is profile-wide; Agent is preset-scoped. Installing both is normally redundant and should be reserved for a deliberate combination of those scopes. Durable event deduplication supports that case.

Users configure optional responsibilities by speaking normally, for example, `规划用 provider/model，推理档 high` or `验收模型改成 provider/model-review`. The controller calls `odai_routing_config`; it must not choose a model that the user did not specify. Mappings persist in `$DSH_HOME/odai/routing.json`, outside both managed package artifacts, and take effect on the next user turn. Users never edit that file directly. If the store is invalid, governance still loads; a needed route fails closed, and the next explicit natural-language `set` preserves the invalid copy and repairs the store.

## Verification

```sh
node --test dsh/runtime/tests/*.test.mjs
npm --prefix dsh/plugin run verify:dsh
npm --prefix dsh/agent test
npm --prefix dsh/agent run verify:dsh
npm --prefix dsh/plugin run pack:dry-run
npm --prefix dsh/agent run pack:dry-run
```

Both packages currently pin `@deepseek-ai/dsh@0.1.0-rc.6`. A DSH version update must refresh the Agent composition from that version's `standard` preset and rerun both isolated load probes.
