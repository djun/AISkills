const DSH_ROLE_OVERLAYS: Readonly<Record<string, string>> = Object.freeze({
  researcher: `## DSH researcher execution boundary

This responsibility runs as one read-only child before the primary routing decision. Use only read, glob, grep, and other non-mutating source tools; do not run shell commands, edit, plan, recommend, approve, or delegate. Return JSON only, with no fence and no fields beyond this exact shape: {"schemaVersion":1,"question":"...","facts":[{"claim":"...","excerpt":"exact complete cited line","source":{"path":"repository/relative/path","line":1},"authority":"source role and freshness boundary"}],"conflicts":[],"unknowns":[],"stop":"..."}. Return the smallest useful 2-6 facts from at least two distinct files. DSH validates every cited file, line, and excerpt inside the project root before hashing and exposing this packet to the controller or planner.`,
  planner: `## DSH planner execution boundary

In auto mode this responsibility runs by replacing the controller route only inside one explicit responsibility scope, not by starting a child. The scope may continue through read-only tool calls, but ends on a terminal response, new direct-human input, failure, cancellation, route mismatch, or turn boundary. When the user-persisted planner mapping explicitly includes maxTokens, that responsibility ceiling overrides the controller ceiling only inside this scope. Retain the current conversation and project context, use only read-only evidence, and do not implement or edit. If the result is mode: planned, execute: executor, and separation has a concrete observable benefit, use odai_route_card to freeze exactly one structured card with non-empty evidence, scope, acceptance conditions, and stop condition. When the original current task already authorizes implementation, immediately submit one executor gap through odai_responsibility_gap so the same task continues without another user prompt. For plan-only work, a new task, expanded scope, or missing user-owned authorization, stop for the minimal user decision instead. Otherwise do not create a route card.`,
  executor: `## DSH executor execution boundary

In auto mode this responsibility is reachable when an active frozen route card proves observable separation benefit and either the original current task already authorizes implementation or the user explicitly continues it. It runs in one bounded controller responsibility scope because DSH routed children are read-only. The scope may continue only through its own tool chain and ends on a terminal response, new direct-human input, failure, cancellation, route mismatch, card release, or turn boundary. When the user-persisted executor mapping explicitly includes maxTokens, that responsibility ceiling overrides the controller ceiling only inside this scope. Follow the claimed card exactly; do not reinterpret the request, broaden scope, or claim final acceptance. The card is consumed after the effective executor request route is verified; that route receipt admits one executor attempt but does not keep the responsibility scope alive by itself.`,
  reviewer: `## DSH reviewer execution boundary

Start an independent child only from a bounded, hash-addressed packet that contains verified tool evidence. The child's effective request header must match its configured route before its output is accepted. Without such a packet, auto mode keeps the current controller route while the recorded reviewer gap remains pending for one controlled reassessment after new acceptance, write, diff, test, failure, or host-evidence diagnostics. A controller-local read-only check may guide evidence gathering, but it is not independent acceptance, must not claim reviewer approval, and must not stop the authorized task solely to ask the user for artifacts the project can produce.`,
  frontend: `## DSH frontend execution boundary

This responsibility runs in one bounded controller responsibility scope so it retains the active conversation, workspace, dev-server, and browser context. It is not an independent child. The scope may continue only through its own tool chain and ends on a terminal response, new direct-human input, failure, cancellation, route mismatch, or turn boundary. DSH may use a user-persisted frontend provider/model/reasoning route and, only when that mapping explicitly includes maxTokens, apply that responsibility ceiling inside this scope. The runtime compares the effective DSH request header with that mapping and records an applied, mismatch, or unverified receipt; configuration and self-report are not routing evidence.`,
});

export interface RoleReferenceContracts {
  craft?: unknown;
}

export function dshRoleContract(
  role: string,
  canonicalContract: unknown,
  referenceContracts: RoleReferenceContracts = {},
): string {
  const canonical = typeof canonicalContract === "string" ? canonicalContract.trim() : "";
  const overlay = DSH_ROLE_OVERLAYS[role];
  if (!canonical) throw new Error(`canonical ${role} responsibility contract is unavailable`);
  const craft = role === "frontend" && typeof referenceContracts.craft === "string"
    ? `## Canonical craft reference\n\n${referenceContracts.craft.trim()}`
    : "";
  return [canonical, craft, overlay].filter(Boolean).join("\n\n");
}
