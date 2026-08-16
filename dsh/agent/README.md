# odai dsh agent

`odai-dsh-agent` installs a selectable, session-scoped Odai Agent preset for DeepSeek Harness (`dsh`). It is independent from the profile-wide `odai-dsh-plugin`: installing this package does not edit any DSH profile or activate a global bundle.

The installed preset is self-contained:

```text
$DSH_HOME/.agent-presets/odai/
  agent.cordis.yml
  preset.yml
  runtime/*.mjs
  skills/odai/**
  .odai-agent.json
```

The composition preserves every capability row and setting from the `standard` agent surface in `@deepseek-ai/dsh@0.1.0-rc.6`, then adds the scoped Odai runtime in default `auto` mode. Release verification compares the complete derived composition against that exact DSH Standard source; a missing, added, reordered, or changed Standard row fails the probe. Host-owned persistence, sandbox, approval, registries, and base controller selection remain in the selected DSH profile. Ordinary requests stay on that controller. A complete contextual high-impact decision gap upgrades the same turn only when a planner mapping exists; the controller's durable `request/header` proves the actual route. Explicit independent planning/review requests still start a verified child when their mappings exist. `execute` remains an explicit all-delegation comparison mode. `observe` changes no model and starts no child; it injects a local evidence-and-decision protocol and makes an unresolved high-impact turn read-only. For DSH compaction on the same provider/model, an omitted summarizer reasoning setting inherits the session's current user-selected reasoning effort so the auxiliary call remains cache-compatible. A user-selected cross-model target removes an effort matching that durable route; a distinct preselected effort is preserved because the request envelope exposes no stronger provenance.

## Install

With DSH already installed, run the single Agent package command below. The package already contains the canonical skill and shared runtime; it does not require the Plugin or a separate skill installation:

```sh
npx odai-dsh-agent install
```

The installer checks `dsh -V` and currently requires exactly `0.1.0-rc.6`; a preset built from one developer-preview composition is not silently installed into another version.

`DSH_HOME` is honored. An explicit location can be supplied without changing the environment:

```sh
npx odai-dsh-agent install --dsh-home /path/to/dsh-home
```

Open a new DSH session and select `Odai` from the Agent preset picker. Existing sessions retain the preset they were composed with.

In `dsh@0.1.0-rc.6`, the one-shot `--profile headless` driver creates a global agent directly and neither mounts nor accepts a session Agent preset. Automated Agent runs must create a Web session with `agentPreset: odai`; use the profile-wide Plugin for one-shot headless tasks.

The installer copies through a mode-tightened staging directory and atomically publishes the preset. Updates verify every previously managed file first, refuse to overwrite local edits, and always change the composition generation key so new sessions in a running DSH process do not reuse stale runtime code. If install or update finds recognized historical Odai audit records, it refuses to change the preset until every DSH process is stopped and the command is rerun with `--yes`. The confirmed migration adds DSH's official `ignorable: true` envelope marker, covers both plaintext and concatenated-frame Zstandard session artifacts, verifies each replacement, and retains a content-addressed backup without deleting messages or evidence. Confirmation alone is insufficient: migration also refuses when local process inspection fails or finds any active DSH process. Keep DSH stopped until the installer exits because historical runtimes do not participate in a migration lock. An unknown unmarked `odai/*` type blocks the operation instead of being assumed safe to ignore.

DSH classifies this as a `trust: user` preset. User presets have the same privileges as shell access, so install only reviewed package versions; the installer repeats this trust notice in both plain and JSON output.

## Responsibility models

The Agent ships no planner, executor, or reviewer model mapping. It stays quiet when an unconfigured responsibility is not needed. If a real task gap needs one, Odai says which responsibility is missing, confirms that no route ran, and asks for the provider, model, and optional reasoning effort in natural language. For example:

```text
规划用 provider-x/model-plan，推理档 high。
执行模型设为 provider-x/model-y。
验收改用 provider-z/model-review，推理档 max。
```

The controller calls `odai_routing_config` to persist that explicit choice. The user does not edit Agent files, YAML, or JSON and does not add trigger terms to later tasks. Mappings live in `$DSH_HOME/odai/routing.json`, outside the managed preset, so installer updates do not report them as drift. Audit evidence likewise lives under `$DSH_HOME/odai/session-evidence/` instead of using private DSH session-event types, so changing or removing the preset cannot make a session unreadable. Changes apply from the next user turn. If reasoning effort is omitted, the target provider/model uses its own default rather than inheriting the source controller's setting. Plugin and Agent read the same stores when both are deliberately present.

Planner, executor, and reviewer are independent optional responsibilities. If any needed one has no mapping, high-impact work fails closed and remains read-only; lower-impact work continues only where it does not depend on the missing independent responsibility. Odai never chooses a model on the user's behalf.

## Controller output policy

The Agent defaults to **soft concise** output and shares three controller output modes with the Plugin. A user can naturally ask to inspect or change the mode; `odai_output_config` persists an explicit override in `$DSH_HOME/odai/output.json`:

| Mode | Policy | Behavior |
|---|---|---|
| normal | `concise: false`, no `maxTokens` | use the host's normal presentation and controller budget |
| soft concise (default) | `concise: true`, no `maxTokens` | shorten only the final user-facing presentation without relaxing required results, evidence, risks, blockers, or verification |
| economy (optional) | `concise: true`, positive `maxTokens` | add a provider output-ceiling request; default to `500` when the user names economy without another value, or use the user's supplied positive value |

Natural requests include `use normal output`, `use soft concise output`, `enable economy mode`, and `set economy mode to 1200 tokens`. Removing the persisted override restores soft concise. Existing pre-mode stores that combined `concise: false` with a ceiling remain readable for compatibility, but new named-mode changes cannot create that legacy combination. The selected mode is stable within one turn and changes from the next user turn.

An economy ceiling only tightens an existing lower host request value and is not a locally enforceable hard billing boundary. A provider may count hidden reasoning inside it, exceed or ignore it, or end before useful final text, especially at a high reasoning effort; strict compliance must be checked from per-request usage. Odai enables economy only when requested and never invents a non-default custom value. The mode does not alter child-agent role budgets, compaction, checkpoints, or other internal context; an incomplete token-capped compaction fails closed instead of replacing history.

A same-provider/model compaction inherits controller reasoning while keeping its independent summary budget. Odai leaves prompt-cache retention unset by default; `ODAI_COMPACTION_CACHE_RETENTION` can explicitly select `short`, `long`, or `none`. `provider-default` means Odai adds no retention, while any explicit incoming retention remains authoritative; configured retention still applies when host routing has already supplied reasoning. Custom preset compositions can set the same value through runtime `compaction.cacheRetention`. The first controller request after a landed summary still rebuilds the changed summary prefix.

## Compaction model

The default compaction-summary model is `inherit`, which preserves the conversation's current provider/model behavior. A user can explicitly set a separate target in natural language, such as `压缩模型用 provider-x/model-summary`; `odai_compaction_config` persists that provider/model pair in `$DSH_HOME/odai/compaction.json`. Removing it restores inheritance. Agent and Plugin share the store when both are deliberately present.

The target applies only to future `compaction` summary requests. It does not change the controller, planner, executor, reviewer, ordinary conversation, summary output budget, or cache-retention policy, never selects a new reasoning effort, and a cross-model target removes only reasoning proven by equality with the durable controller route while preserving a distinct preselected effort. Each configured target receives one provider-neutral integrity suffix that keeps current facts above superseded/rejected history, preserves continuation-critical opaque values exactly, and self-checks contradictions; duplicate Agent/Plugin runtime instances add it only once. Odai never chooses the target on the user's behalf. An invalid store is reported by the tool while runtime requests inherit safely until `set` or `remove` repairs it. An unavailable route, provider error, or incomplete summary fails closed: DSH retains the original history rather than replacing it with a partial checkpoint.

## Skill sources

The Agent keeps the managed preset's complete skill copy as its `bundled` default, so existing installations do not change behavior. When the user explicitly asks to show, set, or reset the Odai skill source, the controller uses `odai_skill_source_config` and stores the choice in `$DSH_HOME/odai/source.json`, outside the managed preset:

- `bundled`: use the skill shipped with this Agent release.
- `auto`: allow a compatible current-project `.dsh/skills/odai` or `.agents/skills/odai` bundle, then DSH custom roots and newer user installs under `$DSH_HOME/skills/odai` or `$DSH_AGENTS_HOME/skills/odai` (default `~/.agents/skills/odai`), with bundled fallback.
- `user`: ignore project roots and require a compatible custom or user-level bundle. An unusable source produces an explicit bundled fallback diagnostic so it can be repaired through the same tool.

An independent install must be a complete directory bundle containing `SKILL.md`, `manifest.json`, and every manifest-declared file. The runtime checks SemVer 2.0.0 `skillVersion`, an exact supported `runtimeContract`, complete-file SHA-256 integrity, and same-version content conflicts. Prompt governance and routing role contracts are selected atomically for one agent turn; project sources are scoped by that session's cwd, and changes are reconsidered on the next user turn. Explicit deployment `skillPath` or `ODAI_SKILL_PATH` remains highest priority and requires a DSH restart.

## Status and uninstall

```sh
npx odai-dsh-agent status
npx odai-dsh-agent status --json
npx odai-dsh-agent uninstall
```

`status` reports `absent`, `installed`, or `drifted`. Update and uninstall fail closed when managed files were changed or unmanaged files were added. Uninstall first checks for legacy Odai session events and, when any exist, requires the same stopped-DSH `--yes` confirmation before making them ignorable; a failed inspection or migration refuses removal. It also refuses while `agent-presets.default` still names `odai`; select another default first so the next session cannot fail on a missing preset. Stop DSH before install, update, or uninstall so session artifacts are not being written concurrently.

## Plugin versus Agent

Use only the surface that matches the desired scope:

- `odai-dsh-plugin`: profile-wide governance for every preset in that profile.
- `odai-dsh-agent`: selectable Odai governance for only sessions using this preset.
- both: supported only for a deliberate combination of profile-wide and Agent-scoped behavior; normally redundant, so it is not the default recommendation.

When both are deliberate, a process-shared per-agent/per-turn skill snapshot keeps prompt governance and role contracts identical, the compatibility-safe evidence store deduplicates tool and route records, and denials remain monotonic. Neither package installs or changes the provider-neutral `odai-cli`.

## Development

`dsh/runtime/` and `skills/odai/` remain the only editable sources. `npm pack` generates the preset's `runtime/` and `skills/` directories and removes them immediately afterward:

```sh
npm --prefix dsh/agent test
npm --prefix dsh/agent run verify:dsh
npm --prefix dsh/agent run pack:dry-run
```

The DSH verification uses a temporary home and one isolated Web process. It creates standard and Odai sessions, proves the canonical prompt appears only for Odai, dispatches `odai_routing_config` through the live Odai session and checks its persisted mapping, and proves the child write guard does not leak into the standard preset.
