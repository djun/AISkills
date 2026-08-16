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

Both packages default to **soft concise** output: final user-facing responses keep required results, decisive evidence, risks, blockers, verification, and necessary next actions while omitting routine narration and repeated context. Users can change the shared mode naturally; `odai_output_config` persists an override in `$DSH_HOME/odai/output.json`, effective from the next user turn:

| Mode | Persisted policy | Behavior |
|---|---|---|
| normal | `concise: false`, no `maxTokens` | use the host's normal presentation and controller budget |
| soft concise (default) | `concise: true`, no `maxTokens` | shorten final presentation without a token ceiling |
| economy (optional) | `concise: true`, positive `maxTokens` | add a provider output-ceiling request; defaults to `500` when the user names economy without another value, and accepts a user-supplied replacement |

Removing an override restores soft concise. Existing pre-mode stores that combined `concise: false` with a ceiling remain readable for compatibility, but new named-mode changes cannot create that legacy combination. No mode alters child-agent, compaction, checkpoint, or other internal context budgets. The runtime forwards an economy ceiling through DSH but cannot make a provider honor it: usage may include hidden reasoning, exceed the requested value, or end before useful final text. Strict compliance therefore requires observed provider usage; Odai enables economy only on explicit request and never invents a non-default custom value.

Users may choose a separate compaction-summary model naturally, for example, `压缩模型用 provider-x/model-summary`. `odai_compaction_config` persists only an explicitly supplied provider/model pair in `$DSH_HOME/odai/compaction.json`, shared by Plugin and Agent. The default and remove behavior are `inherit`: DSH uses the conversation's current route. A configured target affects only future compaction-summary requests; it does not change ordinary conversation or responsibility routes, summary output budget, or cache retention, and it never selects a new reasoning effort. Configured targets receive one provider-neutral integrity suffix that keeps current facts above superseded/rejected history, preserves continuation-critical opaque values exactly, and self-checks contradictions; duplicate Agent/Plugin runtime instances add it only once. If the persisted store is invalid, the tool reports it while runtime requests inherit safely until `set` or `remove` repairs the state. If the selected route fails or returns an incomplete summary, DSH keeps the original history instead of landing a partial checkpoint.

Same-provider/model compaction inherits the controller's reasoning effort without lowering its independent summary budget. A separately configured cross-model target removes an effort only when it matches the durable conversation route's effort; a distinct effort already present on the summary request remains authoritative because the request envelope exposes no stronger provenance. Odai leaves prompt-cache retention unset by default; runtime `compaction.cacheRetention` or `ODAI_COMPACTION_CACHE_RETENTION` can explicitly select `short`, `long`, or `none`. `provider-default` means Odai adds no retention, while any explicit incoming retention remains authoritative. Configured retention still applies when another host layer has already supplied reasoning. The first controller request after a landed summary must build the changed summary prefix.

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
