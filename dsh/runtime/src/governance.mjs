export const DEFAULT_CHILD_DENIED_TOOLS = Object.freeze([
  "write",
  "edit",
  "str_replace_editor",
  "bash",
  "pwsh",
  "ask_user_question",
  "subagent",
  "subagent_fork",
  "subagent_codex",
  "subagent_claude_code",
  "send_message",
  "interrupt_agent",
  "list_agents",
  "workflow",
  "ralph",
  "job_output",
  "job_list",
  "job_kill",
]);

export const DEFAULT_PROTECTED_CONTROLLER_ALLOWED_TOOLS = Object.freeze([
  "read",
  "read_image",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "ask_user_question",
  "get_goal",
  "list_agents",
  "job_output",
  "job_list",
  "skill",
  "odai_route_card",
]);

export function isSubagent(agent) {
  const header = agent?.session?.header;
  return header?.origin === "subagent"
    || (Number.isSafeInteger(header?.delegationDepth) && header.delegationDepth > 0);
}

export function createChildToolGuard(options = {}) {
  const denied = new Set([
    ...DEFAULT_CHILD_DENIED_TOOLS,
    ...(Array.isArray(options.additionalDeniedTools) ? options.additionalDeniedTools : []),
  ]);
  const onDenied = typeof options.onDenied === "function" ? options.onDenied : () => {};

  return (execution) => {
    if (!isSubagent(execution?.agent)) return undefined;
    if (!denied.has(execution?.name)) return undefined;

    const reason = `ODAI_SUBAGENT_BOUNDARY: child agents may not execute ${execution.name}; return evidence to the controller instead.`;
    onDenied(execution, reason);
    return reason;
  };
}

export function activeRouteProtection(agent, recordedEvents = agent?.session?.events) {
  if (isSubagent(agent)) return undefined;
  const events = recordedEvents;
  if (!Array.isArray(events)) return undefined;

  let currentTurn;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "odai/route-decided") continue;
    if (!Number.isSafeInteger(event.data?.turn)) return undefined;
    currentTurn = event.data.turn;
    break;
  }
  if (currentTurn === undefined) return undefined;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "odai/route-protection") continue;
    if (event.data?.turn === currentTurn && event.data?.mode === "read-only") return event.data;
  }
  return undefined;
}

export function createRouteProtectionGuard(options = {}) {
  const allowed = new Set(DEFAULT_PROTECTED_CONTROLLER_ALLOWED_TOOLS);
  for (const name of Array.isArray(options.additionalDeniedTools) ? options.additionalDeniedTools : []) {
    allowed.delete(name);
  }
  const onDenied = typeof options.onDenied === "function" ? options.onDenied : () => {};
  const protectionFor = typeof options.protectionFor === "function"
    ? options.protectionFor
    : activeRouteProtection;

  return (execution) => {
    if (isSubagent(execution?.agent)) return undefined;
    if (allowed.has(execution?.name)) return undefined;
    const protection = protectionFor(execution?.agent);
    if (!protection) return undefined;

    const reasonCode = protection.reasonCode ?? "unresolved-high-impact-route";
    const reason = `ODAI_HIGH_IMPACT_ROUTE_BLOCKED: controller may not execute ${execution.name} while ${reasonCode} remains unresolved; use read-only evidence and provide an actionable decision path.`;
    onDenied(execution, reason);
    return reason;
  };
}

export function summarizeToolResult(execution, result) {
  const summary = {
    callId: String(execution.callId),
    rootCallId: String(execution.rootCallId),
    tool: execution.name,
    child: isSubagent(execution.agent),
    isError: result.isError === true,
  };

  if (result.isError === true && result.error?.code) {
    summary.errorCode = String(result.error.code);
  }

  return summary;
}
