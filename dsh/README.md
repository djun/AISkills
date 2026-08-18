# odai on DeepSeek Harness

The DSH integration has two independently published user surfaces and one internal source owner:

| Directory | Package | Scope | Installs |
|---|---|---|---|
| `runtime/` | none | canonical DSH implementation source | nothing |
| `plugin/` | `odai-dsh-plugin` | every agent in one DSH profile | profile bundle |
| `agent/` | `odai-dsh-agent` | sessions selecting the Odai preset | user agent preset |

The provider-neutral `cli/` remains a separate product and is not part of this subtree.

Both published DSH surfaces default routing to `auto` while keeping the governance skill source pinned to `bundled`; neither ships a researcher, planner, executor, reviewer, or frontend model mapping. Ordinary requests stay on the selected controller. Role words are only candidate signals: a responsibility runs only from an evidence-grounded task-state gap, and an unchanged gap is consumed once. Context-sensitive planner, executor, and frontend work can open one explicit in-place responsibility scope; bounded multi-source repository research and independently reviewable acceptance use children. An incomplete reviewer packet stays on the current controller route for local evidence gathering and cannot terminate the task as a reviewer response. An in-place scope may continue through its own tool-call chain, but it ends at a terminal assistant response, direct user input, failure, cancellation, route mismatch, route-card release, or turn boundary. The runtime durably records scope start, route claim, stop reason, and base-route restoration independently from route receipts. A planner route identical to the current controller remains inline and does not add another model call. When the original task already authorizes implementation, a frozen planner card automatically continues to executor; plan-only requests, new work, expanded scope, and missing user-owned authorization stop for the minimum user decision. Reviewer children require a current hash-addressed packet whose diff and latest successful test are newer than the last write. Route mappings are formally resolved before provider I/O: deterministic invalid persisted mappings are backed up and removed by exact-match CAS, while credential, quota, rate-limit, server, timeout, and transport failures preserve configuration and fall back only for that call. Frontend preflight failure produces an explicit local-controller fallback that cannot be reported as a routed receipt. A missing or failed high-impact route makes the controller read-only instead of silently proceeding.

## Install and use

Choose one surface for the scope you need. The Plugin manager requires `pnpm` on `PATH`; the Agent installer currently supports exactly `dsh@0.1.0-rc.6` and `dsh@0.1.0-rc.7`.

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

Odai persists only the mapping the user explicitly names. A change applies from the next user turn. The runtime resolves a merged effective mapping snapshot whenever routing needs it; only an explicit mapping-management request places that snapshot in the model prompt. `odai_routing_config show` distinguishes persisted and deployment sources and includes the latest actual route receipt. Configuration is not proof of use, and a route receipt proves only the effective model request, not continuing responsibility ownership or completion. In-place responsibility requests are checked against DSH's effective request header; a mismatch closes the scope, restores the preserved controller route, and makes the controller read-only. Responsibility children cannot complete without matching route evidence. Generic subagents remain generic unless explicitly labeled `odai-<responsibility> ...`. The Plugin already includes the canonical skill and runtime; the Agent also includes both and does not require the Plugin. Installing both is normally redundant.

An independently installed complete Odai skill bundle can update faster than either package without changing existing defaults. The user must explicitly ask to set the source to `auto` or `user`; `odai_skill_source_config` persists that choice in `$DSH_HOME/odai/source.json`. Project `.dsh/skills/odai` and `.agents/skills/odai` bundles participate only in `auto` and remain scoped to the current session cwd. The package READMEs define the complete precedence, manifest, compatibility, and fallback contract.

Controlled user evolution is a separate overlay under `$DSH_HOME/odai/skill-evolution`, shared by Plugin and Agent and never managed by either package installer. It allows only exact replacements in existing governance Markdown and stores immutable base/result generations plus lineage outside the package. Every write requires an exact phrase in the current open turn's latest direct-human message; the proposal phrase is bound to all proposed input, and activation/rebase/pointer phrases are bound to the exact generation or source/target pair. Audit evidence comes from the authenticated session event, never a model argument. Any `SKILL.md` or `references/dao.md` change and any destructive replacement requires a distinct `ACTIVATE BREAKING` confirmation. Package updates preserve the active generation, mark an old base as requiring rebase, retain three-way conflict evidence, and never silently activate a merge. Ordinary turns omit the evolution tool and its prompt; direct intent activates it immediately, while the compact capability gateway recovers uncommon wording on the next step without performing a write. Explicit deployment skill paths bypass the overlay; `ODAI_DISABLE_EVOLUTION=1` provides an emergency startup bypass without deleting it. See each package README for the full validation and recovery contract.

Both surfaces also share local long-term semantic memory at `$DSH_HOME/odai/memory/store.json`. Default `auto` mode performs no hidden provider, model, embedding, subagent, or compaction call: at controller step 1 it mechanically considers only the direct-human message authenticated by the current open-turn session event and automatically activates high-confidence standing preferences, settled decisions, and constraints. Questions, code/quotes, reported speech, hypotheses, temporary requests, recognized credentials/contact identifiers, and sensitive personal categories are rejected. The current human message and current project authority always override recalled history.

Less explicit semantic candidates can be submitted by the current controller through `odai_memory consider` with an exact excerpt from that same open turn. They remain `pending` and inert until repeated independent evidence or explicit confirmation. Global and canonical-path-hashed project scopes are isolated; only active, relevant, bounded records are injected as low-priority plugin context. An unresolved conflict suppresses the stale active record instead of silently choosing either side. Correction or confirmation records supersession. Forget and authorized clear physically remove matching content; bulk clear requires an exact preflight phrase, children cannot inspect the store, and an invalid/symlinked store fails closed. Agent install/update/uninstall and Plugin updates never manage or delete this store. Deployment may set `memory.mode: off` as a hard disable that persisted user settings cannot override; otherwise a persisted natural-language mode change takes effect on the next turn. Automatic capture and bounded recall remain runtime behavior; the larger `odai_memory` management schema is exposed only for matching direct intent or a capability-gateway request.

Non-crisis care and crisis safety are separate contracts. `references/care.md` owns fatigue, anxiety, self-doubt, rumination or internal friction, persistent negativity, shame, fear of mistakes, reduced agency, and the transparent user-controlled 阿岱/欧黛 styles; none is an automatic crisis label or model-routing trigger. `references/human-safety.md` owns sustained or worsening low mood, hopelessness, burden, self-harm, suicide, and immediate danger. Crisis handling suppresses style performance, stays with the same controller, and becomes direct. Odai never writes current mood, crisis language, diagnosis, or a risk score automatically.

Human-safety continuity remains deliberately separate at `$DSH_HOME/odai/human-safety-continuity.json`. `odai_human_safety_continuity` accepts only an authenticated current direct-user request to save, correct, remove, view, export, or physically clear four bounded categories: care preferences, signals the user explicitly wants noticed, support the user says helps, and user-authored safety-plan steps. Added or replacement text must occur byte-for-byte in that message; credentials and contact details are rejected. Entries persist until the user removes or physically clears them. A controller receives the minimal quoted record only when the current conversation independently makes care, crisis support, or record management relevant; it remains historical preference rather than current-risk evidence and is never exposed to children. Current credible self-harm or suicide inclination triggers timely care and a direct safety check even without a plan; plan, means, and action determine escalation urgency, not whether Odai intervenes.

## Adaptive context budget

Odai keeps the full canonical governance and compact core tools on ordinary turns, while low-frequency routing, output, compaction, memory, skill-source, evolution, care, crisis, and continuity schemas appear only for matching current direct-user intent. A small `odai_context_capability` gateway recovers uncommon wording on the next model step without performing the requested action itself; the specialized tool still enforces the complete authorization and data boundary. Child agents receive none of these controller tools. If the DSH host lacks scoped tool restriction, runtime behavior falls back to the complete catalog instead of dropping a capability.

Using the same fixed-density estimator as DSH's context meter, the measured Odai-only ordinary-turn baseline before adaptive exposure was approximately `3332` system plus `2862` tool tokens (`6194` total). The capability-parity ordinary sample is `1280` system plus `392` tools (`1672` total, `73.0%` lower), guarded by test ceilings of `1600`, `600`, and `1900`; contextual turns intentionally add only the relevant contract and schemas. These figures measure Odai's contribution, not DSH's other system instructions, built-in tools, conversation messages, or provider-exact tokenization.

Both packages default to **soft concise** output: final user-facing responses keep required results, decisive evidence, risks, blockers, verification, and necessary next actions while omitting routine narration and repeated context. Users can change the shared mode naturally; `odai_output_config` persists an override in `$DSH_HOME/odai/output.json`, effective from the next user turn:

| Mode | Persisted policy | Behavior |
|---|---|---|
| normal | `concise: false`, no `maxTokens` | use the host's normal presentation and controller budget |
| soft concise (default) | `concise: true`, no `maxTokens` | shorten final presentation without a token ceiling |
| economy (optional) | `concise: true`, positive `maxTokens` | add a provider output-ceiling request; defaults to `500` when the user names economy without another value, and accepts a user-supplied replacement |

Removing an override restores soft concise. Existing pre-mode stores that combined `concise: false` with a ceiling remain readable for compatibility, but new named-mode changes cannot create that legacy combination. No mode alters child-agent, compaction, checkpoint, or other internal context budgets. The runtime forwards an economy ceiling through DSH but cannot make a provider honor it: usage may include hidden reasoning, exceed the requested value, or end before useful final text. Strict compliance therefore requires observed provider usage; Odai enables economy only on explicit request and never invents a non-default custom value.

Users may choose a separate compaction-summary target naturally, for example, `压缩模型用 provider-x/model-summary` or `压缩模型用 provider-x/model-summary，推理档 high`. `odai_compaction_config` persists only the explicitly supplied provider/model pair and optional reasoning effort in `$DSH_HOME/odai/compaction.json`, shared by Plugin and Agent. The default and remove behavior are `inherit`: DSH uses the conversation's current route. A configured target affects only future compaction-summary requests; it does not change ordinary conversation or responsibility routes, summary output budget, or cache retention. Odai never invents a provider, model, or reasoning effort. Configured targets receive one provider-neutral integrity suffix that keeps current facts above superseded/rejected history, preserves continuation-critical opaque values exactly, and self-checks contradictions; duplicate Agent/Plugin runtime instances add it only once. If the persisted store is invalid, the tool reports it while runtime requests inherit safely until `set` or `remove` repairs the state. DSH buffers the configured summary stream until a valid terminal result: partial failed output is discarded, the untouched original request is retried once on the inherited route, and original history remains unchanged until one complete summary lands. A deterministic invalid persisted target is backed up and exact-match removed; transient and environment failures preserve it.

An explicitly configured compaction `reasoningEffort` overrides reasoning only for those summary requests. When it is omitted, same-provider/model compaction inherits the controller's reasoning effort without lowering its independent summary budget; a separately configured cross-model target removes an effort only when it matches the durable conversation route's effort, while a distinct effort already present on the summary request remains authoritative because the request envelope exposes no stronger provenance. Odai leaves prompt-cache retention unset by default; runtime `compaction.cacheRetention` or `ODAI_COMPACTION_CACHE_RETENTION` can explicitly select `short`, `long`, or `none`. `provider-default` means Odai adds no retention, while any explicit incoming retention remains authoritative. Configured retention still applies when another host layer has already supplied reasoning. The first controller request after a landed summary must build the changed summary prefix.

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

Both packages currently accept only `@deepseek-ai/dsh@0.1.0-rc.6` or `0.1.0-rc.7`. The Agent package keeps rc.7 Standard as its source composition and renders the two rc.6 optional-provider fields back to that release's exact contract during installation. A DSH version update must refresh this versioned composition and rerun Plugin, Agent, and coexistence probes against every supported release.
