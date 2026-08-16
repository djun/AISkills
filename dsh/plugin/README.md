# odai dsh plugin

`odai-dsh-plugin` is the profile-wide Odai bundle for DeepSeek Harness (`dsh`). Install it when every agent preset in one DSH profile should receive Odai governance and routing. It does not install or select the separate Odai Agent preset, and it leaves the provider-neutral `odai-cli` runtime unchanged.

The bundle contributes:

- canonical `skills/odai/SKILL.md` governance as a system-prompt section;
- deterministic routing that keeps ordinary work on the current controller, upgrades configured contextual decision gaps in place, and delegates only genuine independent gaps;
- monotonic write boundaries for child agents and unresolved high-impact controller turns;
- durable route decisions, upgrades, child outcomes, protections, policy denials, and compact tool outcomes stored outside DSH's core session-event vocabulary;
- actual controller/child provider-model evidence, fail-closed high-impact failures, and direct fallback only where it is safe;
- configurable compaction calls: summaries inherit the conversation provider/model by default, a user may persist a separate explicit target and optional reasoning effort, omitted reasoning keeps same-route inheritance and cross-model isolation, and retention stays at the provider default unless explicitly configured;
- a default soft-concise controller output policy, an explicit normal-mode escape, and an optional user-selected economy ceiling without changing child-agent, compaction, checkpoint, or other internal context budgets.

## Install

Install the package into only the profile that should receive Odai. DSH's plugin manager requires `pnpm` on `PATH`:

```sh
dsh plugin --profile web add odai-dsh-plugin
```

The package declares `dsh.bundle`, so DSH adds it to that profile's bundle stack. It already contains the canonical Odai skill and runtime; a separate skill install is optional and remains inactive until the user explicitly changes the source mode. Do not install the Agent package separately for ordinary Plugin use. Start a new DSH process after installation. Agent-only users should install `odai-dsh-agent` instead; that package is self-contained and does not activate this bundle.

Odai audit evidence is stored under `$DSH_HOME/odai/session-evidence/`, not as private event types in DSH's core session log. This keeps every session written by the current Plugin readable when the Plugin is removed or upgraded.

Older releases wrote `odai/*` audit records into DSH's core log without its official `ignorable: true` envelope marker. Stop every DSH process before updating or removing an older Plugin, then run the explicit compatibility repair:

```sh
npx odai-dsh-plugin repair-sessions --yes
```

The repair adds only that marker to the eight audit event types written by historical Odai releases; it does not remove messages or audit payloads. An unknown unmarked `odai/*` type is refused rather than guessed to be ignorable. `DSH_HOME` is honored; use `--dsh-home /path/to/dsh-home` for another home and `--json` for a machine-readable report. It handles both `session.jsonl` and DSH's concatenated-frame `session.jsonl.zstd` format, verifies every rewritten artifact, replaces it atomically, and retains a content-addressed backup beside each changed log. `--yes` is not the only guard: the command also inspects local process command lines and refuses when that check fails or any DSH process is active. If an artifact changes during preparation or contains malformed committed data, that artifact is not rewritten and the command reports a failure. Do not restart DSH until the whole migration exits because historical runtimes do not participate in a migration lock.

## Skill sources

Existing installations stay pinned to `bundled`, the complete skill copy shipped with this Plugin. A user can naturally ask Odai to show, set, or reset its skill source; the controller uses `odai_skill_source_config` and persists the explicit choice in `$DSH_HOME/odai/source.json`. Users do not edit Plugin files or configuration stores. The available modes are:

- `bundled`: always use the version shipped with the installed Plugin release.
- `auto`: check the current project's `.dsh/skills/odai` and `.agents/skills/odai`, then DSH custom skill roots, `$DSH_HOME/skills/odai`, and `$DSH_AGENTS_HOME/skills/odai` (default `~/.agents/skills/odai`), with bundled fallback. A valid compatible project/custom bundle may intentionally pin another version. A user-level bundle must be newer than bundled.
- `user`: ignore project roots and require a compatible custom or user-level bundle. If none is usable, Odai keeps bundled governance visible with an explicit fallback diagnostic so the user can recover through the same tool.

Every independently installed Odai skill must be a complete directory bundle with `SKILL.md`, `manifest.json`, and every file named by the manifest. The runtime requires a supported `runtimeContract`, uses SemVer 2.0.0 for `skillVersion`, hashes every declared file, rejects same-version/different-content conflicts, and continues past invalid candidates. A selected bundle supplies both the canonical prompt and planner/executor/reviewer role contracts as one immutable per-turn snapshot. Project choices are scoped by the session cwd, Plugin and Agent share one selection when deliberately combined, and a setting or skill update is reconsidered on the next user turn. Explicit deployment `skillPath` or `ODAI_SKILL_PATH` remains highest priority and requires a DSH restart.

## Controller output policy

Plugin and Agent share three controller output modes. The package default is **soft concise**; users can ask naturally to inspect or change the mode, and `odai_output_config` persists an explicit override in `$DSH_HOME/odai/output.json`:

| Mode | Policy | Behavior |
|---|---|---|
| normal | `concise: false`, no `maxTokens` | restore the host's normal presentation and controller budget |
| soft concise (default) | `concise: true`, no `maxTokens` | shorten only the final user-facing presentation while retaining required results, evidence, risks, blockers, and verification |
| economy (optional) | `concise: true`, positive `maxTokens` | add a provider output-ceiling request; use `500` when the user names economy without another value, or the user's supplied positive value |

For example, users can say `use normal output`, `use soft concise output`, `enable economy mode`, or `set economy mode to 1200 tokens`. Removing the persisted override restores soft concise. Existing pre-mode stores that combined `concise: false` with a ceiling remain readable for compatibility, but new named-mode changes cannot create that legacy combination. A changed mode is snapshotted for one agent turn and applies from the next user turn.

An economy `maxTokens` value applies to controller conversation-model requests and only tightens an existing lower host request value. It is not a locally enforceable hard billing boundary: a provider may count hidden reasoning inside it, exceed or ignore it, or stop before a usable final response. Strict compliance must be established from per-request usage rather than the outgoing request header. The canary runner reports `provider_output_ceiling` evidence and can fail a provider certification run with `--require-output-ceiling-compliance`. Odai enables economy only when the user requests it and never invents a non-default custom value. Child-agent role limits and DSH compaction remain independent; compaction keeps its own completeness instruction and budget, and a token-capped incomplete checkpoint fails closed instead of replacing session history.

## Compaction model

Compaction summaries inherit the conversation's current provider/model by default. A user may explicitly choose a separate target and optional reasoning effort in natural language, for example, `压缩模型用 provider-x/model-summary，推理档 high`; the controller calls `odai_compaction_config`, which persists those explicit values in `$DSH_HOME/odai/compaction.json`. The same tool shows the effective target or removes it to restore inheritance. Plugin and Agent share this store, and Odai never invents a provider, model, or reasoning effort.

A configured target affects only future compaction-summary requests. Controller and responsibility routes, normal conversation, the independent summary output budget, and cache retention remain unchanged. An explicitly configured `reasoningEffort` overrides reasoning only for those summaries. When omitted, same-route summaries may inherit the controller reasoning effort; a cross-model target removes only an effort matching the durable controller route, while a distinct preselected effort remains authoritative because the request envelope exposes no stronger provenance. Each configured target receives one provider-neutral integrity suffix that keeps current facts above superseded/rejected history, preserves continuation-critical opaque values exactly, and self-checks contradictions; duplicate Agent/Plugin runtime instances add it only once. An invalid store is reported by the tool while runtime requests inherit safely until `set` or `remove` repairs it. If the selected route is unavailable, the provider fails, or the summary is incomplete, DSH preserves the original history rather than landing a partial checkpoint.

## Routing modes

- `off`: disable task routing while retaining canonical governance, the child boundary, and user-requested responsibility configuration.
- `observe`: calculate and record the route without changing model or starting a child. The controller receives a local responsibility protocol requiring decisive evidence, unresolved assumptions, concrete evidence-gathering steps, and explicit decision criteria. A high-impact gap additionally makes the controller read-only for that turn.
- `auto` (default): ordinary work stays on the configured controller. A complete contextual high-impact decision gap upgrades that same controller turn when its planner mapping is configured, so there is one session and no child handoff. Explicit independent planning/review requests still use a child when that responsibility is configured because independence is the requested capability.
- `execute`: preserve the experimental delegation behavior for comparison or installations that explicitly require separation. Every planner/reviewer gap, including a contextual upgrade gap, calls the configured DSH subagent provider (`spawn` by default), verifies the child route, injects its result, and disposes the run.

The package ships no planner, executor, or reviewer model mapping. Each responsibility is optional and configured independently only by an explicit user choice. There is no startup warning for an unused responsibility. When a real gap needs an unconfigured responsibility, Odai states which one is missing, confirms that no such model was called, and asks the user to name the provider, model, and optional reasoning effort naturally. For example:

```text
把规划模型设为 provider-x/model-plan，推理档设为 high。
执行用 provider-x/model-y。
验收模型改成 provider-z/model-review，推理档 max。
```

The controller translates that request into the `odai_routing_config` tool call. Users do not edit YAML or JSON, run an installation command, or add routing words to later task prompts. The tool stores the explicit choices in `$DSH_HOME/odai/routing.json`, outside managed package files, and Plugin and Agent installations read the same store. A changed mapping applies from the next user turn. The same tool can show current mappings or remove one when the user asks naturally. If reasoning effort is omitted, the target provider/model uses its own default; Odai does not silently carry a source controller's effort across providers or models.

A user may also supply a positive child `maxTokens` limit; in-place controller upgrades retain the controller's normal output budget. For an in-place upgrade, the durable controller `request/header` is the actual route proof. For child delegation, the runtime verifies the child's durable header before injecting its output; a missing or mismatched provider, model, or reasoning effort makes the child result untrusted. A failed auto model request cannot fall back to the original controller model inside that turn. A failed high-impact child route makes the controller read-only instead of silently implementing without independent evidence; low-impact child failures may return to the controller without claiming delegated evidence.

Risk or task size alone never triggers another model. Role language inside quotes, inline/fenced code, or Markdown blockquotes is treated as material being discussed rather than an explicit routing request. A contextual upgrade requires an unverified causal claim used to justify a concrete high-impact change with a specific parameter, urgency, or irreversible action. Reviewer routes require an explicit independent acceptance gap. Explicit independent planning remains a planner child. Executor routing additionally requires a frozen route card and observable net benefit; the live text router does not infer that card from prose.

## Coexistence

The Plugin and Agent packages are independently installable and self-contained. Plugin is profile-wide; Agent is one dedicated preset. Installing both is normally redundant and is not the default recommendation. Use both only when the deliberate design is profile-wide Plugin behavior plus an Agent-scoped preset in the same profile. In that case, a process-shared per-agent/per-turn skill snapshot keeps the prompt and role contracts identical across both runtimes, shared session-evidence identities deduplicate each tool observation and turn/step route, DSH shadows the canonical prompt section by scope, and tool denials remain monotonic. Removing either package does not remove the compatibility-safe evidence store or make the DSH session log depend on that package.

## Development

`dsh/runtime/` is the only editable DSH runtime source. `npm pack` temporarily copies that runtime and the canonical skill into this package, then removes both generated directories:

```sh
npm --prefix dsh/plugin test
npm --prefix dsh/plugin run verify:dsh
npm --prefix dsh/plugin run pack:dry-run
```

The verification first reproduces rc.6's exact `SessionFormatUnsupportedError` for legacy Agent and Plugin logs, repairs them, and proves DSH's real JSONL/Zstandard backend plus `PersistenceCoordinator` accepts both while verified original backups remain available. The load probe then uses a temporary `DSH_HOME`, does not call a model, validates source-tool registration and persistence in DSH, checks persisted responsibility configuration, and verifies both the child boundary and protected-controller write denial through DSH's real tool runtime. An explicitly authorized live routing smoke can use isolated copies of the current DSH settings and credential references:

```sh
npm --prefix dsh/plugin run smoke:live -- --yes

# Use only a provider/model that the operator explicitly selects and can access.
npm --prefix dsh/plugin run smoke:live -- --yes --mode auto \
  --planner-provider provider-id --planner-model model-id
```

The default smoke inherits `agent-default-model`, omits the routing block, and uses a natural high-impact decision gap. It requires one controller, zero children, a missing-planner event, read-only fail-closed protection, no false upgrade/result event, and the original controller `request/header`. Explicit `auto` and `execute` require `--planner-provider` plus `--planner-model`; the script has no built-in model name. `auto` requires a same-turn upgrade, `execute` requires one verified child, and `observe`/`off` require zero children with their mode-appropriate events.

An explicitly authorized cache probe compares the current relay's compaction request with and without the same routed reasoning setting. It inherits the controller route from DSH settings, uses an isolated temporary home, and removes copied credentials and sessions on exit. A diagnostic run may vary only the compaction output budget to determine whether the relay partitions its prompt cache by that field:

```sh
npm --prefix dsh/plugin run smoke:compaction-cache -- --yes
npm --prefix dsh/plugin run smoke:compaction-cache -- --yes --runtime
npm --prefix dsh/plugin run smoke:compaction-cache -- --yes --runtime --compaction-max-tokens 8192
npm --prefix dsh/plugin run smoke:compaction-cache -- --yes --runtime --compaction-cache-retention long

# Compare two ordinary controller requests without an intervening compaction.
npm --prefix dsh/plugin run smoke:compaction-cache -- --yes --runtime --ordinary-only --cache-retention short
npm --prefix dsh/plugin run smoke:compaction-cache -- --yes --runtime --ordinary-only --cache-retention long
```

The probe reports both compaction and exactly matched cache reads. `--ordinary-only` instead reports a clean warm/matched pair so an intervening compaction cannot refresh or contaminate a normal-dialogue cache comparison. Because it runs before the fixture session has a durable first request header, candidate mode supplies the same synthetic routed header used by the unit contract and then exercises the real relay request; production compaction reads an existing durable header. Runtime retention defaults to `provider-default`. In one isolated OpenAI `gpt-5.6-sol/xhigh` standalone compaction per arm, each shadowing about 149K measured tokens, provider-default and forced `long` both reused about 99.4% of provider input and produced equivalent immediate post-summary cache coverage. This supports the least-intervention default for that observed route; it does not establish delayed or provider-neutral retention behavior. Deployment config `compaction.cacheRetention` or `ODAI_COMPACTION_CACHE_RETENTION` can explicitly select `short`, `long`, or `none`; `provider-default` means Odai adds no retention, any explicit incoming retention remains authoritative, and configured retention still applies when host routing has already supplied reasoning. This retention policy does not add cross-model reasoning or retention.

A provider cache is still best-effort: even identical calls can miss because of upstream writes, expiry, or routing. Changing compaction to a low controller ceiling is not a valid cache fix because it risks an incomplete checkpoint; the first controller request after a landed summary must also build the new summary prefix because it no longer matches the replaced history.

The package is pinned to `@deepseek-ai/dsh@0.1.0-rc.6` because DSH remains a developer preview and its plugin API may change.
