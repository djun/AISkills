const DSH_ROLE_OVERLAYS = Object.freeze({
  researcher: `## DSH researcher execution boundary

This responsibility runs as one read-only child before the primary routing decision. Use only read, glob, grep, and other non-mutating source tools; do not run shell commands, edit, plan, recommend, approve, or delegate. Return JSON only, with no fence and no fields beyond this exact shape: {"schemaVersion":1,"question":"...","facts":[{"claim":"...","excerpt":"exact complete cited line","source":{"path":"repository/relative/path","line":1},"authority":"source role and freshness boundary"}],"conflicts":[],"unknowns":[],"stop":"..."}. Return the smallest useful 2-6 facts from at least two distinct files. DSH validates every cited file, line, and excerpt inside the project root before hashing and exposing this packet to the controller or planner.`,
  planner: `## DSH planner execution boundary

In auto mode this responsibility runs by replacing the current controller request route, not by starting a child. Retain the current conversation and project context, use only read-only evidence, and do not implement or edit. If the result is mode: planned, execute: executor, and separation has a concrete observable benefit, use odai_route_card to freeze exactly one structured card with non-empty evidence, scope, acceptance conditions, and stop condition. Otherwise do not create a route card.`,
  executor: `## DSH executor execution boundary

In auto mode this responsibility is reachable only when the user explicitly continues implementation and an active frozen route card proves observable separation benefit. It runs in the current controller turn because DSH routed children are read-only. Follow the consumed card exactly; do not reinterpret the request, broaden scope, or claim final acceptance.`,
  reviewer: `## DSH reviewer execution boundary

Start an independent child only from a bounded, hash-addressed packet that contains verified tool evidence. The child's effective request header must match its configured route before its output is accepted. Without such a packet, auto mode may replace the current request route for a read-only same-turn check, but it must state that the result is not independent acceptance and must not edit, fix, or approve release.`,
  frontend: `## DSH frontend execution boundary

This responsibility runs in the current controller turn so it retains the active conversation, workspace, dev-server, and browser context. It is not an independent child. DSH may use a user-persisted frontend provider/model/reasoning route and, only when that mapping explicitly includes maxTokens, apply that responsibility ceiling instead of the global controller ceiling for this routed turn. The runtime compares the effective DSH request header with that mapping and records an applied, mismatch, or unverified receipt; configuration and self-report are not routing evidence.`,
});

export function dshRoleContract(role, canonicalContract, referenceContracts = {}) {
  const canonical = typeof canonicalContract === "string" ? canonicalContract.trim() : "";
  const overlay = DSH_ROLE_OVERLAYS[role];
  if (!canonical) throw new Error(`canonical ${role} responsibility contract is unavailable`);
  const craft = role === "frontend" && typeof referenceContracts.craft === "string"
    ? `## Canonical craft reference\n\n${referenceContracts.craft.trim()}`
    : "";
  return [canonical, craft, overlay].filter(Boolean).join("\n\n");
}
