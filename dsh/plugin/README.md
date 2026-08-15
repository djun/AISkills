# odai dsh plugin

`odai-dsh-plugin` is the profile-wide Odai bundle for DeepSeek Harness (`dsh`). Install it when every agent preset in one DSH profile should receive Odai governance and routing. It does not install or select the separate Odai Agent preset, and it leaves the provider-neutral `odai-cli` runtime unchanged.

The bundle contributes:

- canonical `skills/odai/SKILL.md` governance as a system-prompt section;
- deterministic routing that keeps ordinary work on the current controller, upgrades configured contextual decision gaps in place, and delegates only genuine independent gaps;
- monotonic write boundaries for child agents and unresolved high-impact controller turns;
- durable route decisions, upgrades, child outcomes, protections, policy denials, and compact tool outcomes stored outside DSH's core session-event vocabulary;
- actual controller/child provider-model evidence, fail-closed high-impact failures, and direct fallback only where it is safe.

## Install

Install the package into only the profile that should receive Odai. DSH's plugin manager requires `pnpm` on `PATH`:

```sh
dsh plugin --profile web add odai-dsh-plugin
```

The package declares `dsh.bundle`, so DSH adds it to that profile's bundle stack. It already contains the canonical Odai skill and runtime; do not install the skill or Agent package separately for Plugin use. Start a new DSH process after installation. Agent-only users should install `odai-dsh-agent` instead; that package is self-contained and does not activate this bundle.

Odai audit evidence is stored under `$DSH_HOME/odai/session-evidence/`, not as private event types in DSH's core session log. This keeps every session written by the current Plugin readable when the Plugin is removed or upgraded.

Older releases wrote `odai/*` audit records into DSH's core log without its official `ignorable: true` envelope marker. Stop every DSH process before updating or removing an older Plugin, then run the explicit compatibility repair:

```sh
npx odai-dsh-plugin repair-sessions --yes
```

The repair adds only that marker to the eight audit event types written by historical Odai releases; it does not remove messages or audit payloads. An unknown unmarked `odai/*` type is refused rather than guessed to be ignorable. `DSH_HOME` is honored; use `--dsh-home /path/to/dsh-home` for another home and `--json` for a machine-readable report. It handles both `session.jsonl` and DSH's concatenated-frame `session.jsonl.zstd` format, verifies every rewritten artifact, replaces it atomically, and retains a content-addressed backup beside each changed log. `--yes` is not the only guard: the command also inspects local process command lines and refuses when that check fails or any DSH process is active. If an artifact changes during preparation or contains malformed committed data, that artifact is not rewritten and the command reports a failure. Do not restart DSH until the whole migration exits because historical runtimes do not participate in a migration lock.

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

The Plugin and Agent packages are independently installable and self-contained. Plugin is profile-wide; Agent is one dedicated preset. Installing both is normally redundant and is not the default recommendation. Use both only when the deliberate design is profile-wide Plugin behavior plus an Agent-scoped preset in the same profile. In that case, shared session-evidence identities deduplicate each tool observation and turn/step route, DSH shadows the canonical prompt section by scope, and tool denials remain monotonic. Removing either package does not remove the compatibility-safe evidence store or make the DSH session log depend on that package.

## Development

`dsh/runtime/` is the only editable DSH runtime source. `npm pack` temporarily copies that runtime and the canonical skill into this package, then removes both generated directories:

```sh
npm --prefix dsh/plugin test
npm --prefix dsh/plugin run verify:dsh
npm --prefix dsh/plugin run pack:dry-run
```

The verification first reproduces rc.6's exact `SessionFormatUnsupportedError` for legacy Agent and Plugin logs, repairs them, and proves DSH's real JSONL/Zstandard backend plus `PersistenceCoordinator` accepts both while verified original backups remain available. The load probe then uses a temporary `DSH_HOME`, does not call a model, validates tool registration in DSH, checks persisted responsibility configuration, and verifies both the child boundary and protected-controller write denial through DSH's real tool runtime. An explicitly authorized live routing smoke can use isolated copies of the current DSH settings and credential references:

```sh
npm --prefix dsh/plugin run smoke:live -- --yes
```

The default smoke omits the routing block and uses a natural high-impact decision gap. It requires one controller, zero children, a missing-planner event, read-only fail-closed protection, no false upgrade/result event, and the original controller `request/header`. Explicit `--mode auto` injects a test-only planner mapping and requires a same-turn upgrade; `execute` requires one verified child; `observe` and `off` require zero children with their mode-appropriate events.

The package is pinned to `@deepseek-ai/dsh@0.1.0-rc.6` because DSH remains a developer preview and its plugin API may change.
