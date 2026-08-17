import { createHash } from "node:crypto";

const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_MAX_EVENTS = 80;
const REQUIREMENT_PATTERNS = [/requirement/iu, /acceptance/iu, /需求/u, /要求/u, /目标/u, /验收/u];
const ACCEPTANCE_PATTERNS = [/\bA\d+\b/u, /accept(?:ance)?/iu, /验收/u, /通过条件/u, /完成条件/u];
const DIFF_OUTPUT_PATTERNS = [/diff --git/iu, /^---\s+a\/[^\n]+\n\+\+\+\s+b\//imu];
const TEST_PATTERNS = [/\bnode --test\b/iu, /\bnpm (?:run )?test\b/iu, /\bpnpm (?:run )?test\b/iu, /\bpytest\b/iu, /\btest(?:s|ing)?\b/iu, /测试/u];
const TEST_SUCCESS_PATTERNS = [
  /exit code:\s*0/iu,
  /(?:^|\n)[^\n]*(?:pass|passed)\s*[:=]?\s*[1-9]\d*/iu,
  /(?:^|\n)[^\n]*[1-9]\d*\s+passed\b/iu,
  /(?:^|\n)[^\n]*fail(?:ed)?\s*[:=]?\s*0\b/iu,
  /\btests?\s+\d+[^\n]*(?:pass|passed)\s+[1-9]\d*[^\n]*fail(?:ed)?\s+0\b/iu,
];
const TEST_FAILURE_PATTERNS = [
  /exit code:\s*[1-9]\d*/iu,
  /(?:^|\n)[^\n]*fail(?:ed)?\s*[:=]?\s*[1-9]\d*/iu,
  /\b(?:tests?|test suite) failed\b/iu,
];

function textBlocks(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => textBlocks(item, depth + 1));
  if (typeof value !== "object") return [];
  if (value.type === "text" && typeof value.text === "string") return [value.text];
  const keys = ["content", "message", "output", "result", "data", "text", "value", "command", "args", "input"];
  return keys.flatMap((key) => key in value ? textBlocks(value[key], depth + 1) : []);
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function toolResultBlocks(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => toolResultBlocks(item, depth + 1));
  if (typeof value !== "object") return [];
  const own = value.type === "tool-result" ? [value] : [];
  return own.concat(Object.values(value).flatMap((item) => toolResultBlocks(item, depth + 1)));
}

function successfulToolResult(data) {
  const blocks = toolResultBlocks(data);
  if (data?.error || data?.isError === true || blocks.some((block) => block.isError === true)) return false;
  return data?.isError === false || (blocks.length > 0 && blocks.every((block) => block.isError === false));
}

function toolResultIdentity(data, blocks) {
  const callId = data?.callId
    ?? data?.message?.source?.callId
    ?? blocks.find((block) => typeof block.toolCallId === "string")?.toolCallId;
  return typeof callId === "string" && callId ? `tool-call:${callId}` : undefined;
}

function eventEvidence(event, index) {
  if (event?.type === "user/message") {
    const text = textBlocks(event.data).join("\n").trim();
    return text ? { index, source: "user", kinds: ["requirement"], label: "earlier user requirement", text } : undefined;
  }
  if (["assistant/message", "agent/message", "message/assistant"].includes(event?.type)) {
    const text = textBlocks(event.data).join("\n").trim();
    if (!text) return undefined;
    const kinds = ["assistant-claim"];
    if (matchesAny(text, REQUIREMENT_PATTERNS)) kinds.push("requirement");
    if (matchesAny(text, ACCEPTANCE_PATTERNS)) kinds.push("acceptance");
    return { index, source: "assistant", kinds, label: "controller claim", text };
  }
  if (event?.type === "odai/route-card-frozen" && event.data?.card) {
    return {
      index,
      source: "route-card",
      kinds: ["acceptance"],
      label: `frozen route card ${event.data.card.id ?? "(unknown)"}`,
      text: JSON.stringify(event.data.card),
    };
  }
  if (event?.type === "tool/result") {
    const text = textBlocks(event.data).join("\n").trim();
    if (!text || !successfulToolResult(event.data)) return undefined;
    const blocks = toolResultBlocks(event.data);
    const tool = event.data?.tool ?? event.data?.name ?? event.data?.execution?.name ?? "unknown";
    const identity = toolResultIdentity(event.data, blocks);
    const kinds = ["tool"];
    if (identity && matchesAny(text, DIFF_OUTPUT_PATTERNS)) kinds.push("diff");
    if (identity
      && matchesAny(text, TEST_PATTERNS)
      && matchesAny(text, TEST_SUCCESS_PATTERNS)
      && !matchesAny(text, TEST_FAILURE_PATTERNS)) kinds.push("test");
    return {
      index,
      source: "tool",
      kinds,
      label: `tool ${tool}${identity ? ` (${identity})` : ""}`,
      ...(identity ? { identity } : {}),
      text,
    };
  }
  if (event?.type === "odai/tool-observed" && event.data?.isError === false) {
    const identity = typeof event.data.callId === "string" ? `tool-call:${event.data.callId}` : undefined;
    return {
      index,
      source: "tool",
      kinds: ["tool"],
      label: `observed tool ${event.data.tool ?? "unknown"}${identity ? ` (${identity})` : ""}`,
      ...(identity ? { identity } : {}),
      text: JSON.stringify(event.data),
    };
  }
  return undefined;
}

function truncateText(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, limit - 24))}\n...[packet truncated]`, truncated: true };
}

function digestPacket(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function coverageFor(currentTask, entries) {
  const count = (kind) => entries.filter((entry) => entry.kinds.includes(kind)).length;
  return Object.freeze({
    requirements: Boolean(currentTask) || count("requirement") > 0,
    acceptanceCount: count("acceptance"),
    diffCount: count("diff"),
    testCount: count("test"),
    toolEvidenceCount: count("tool"),
  });
}

export function buildRoleContextPacket(agent, role, taskText, options = {}) {
  const maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : DEFAULT_MAX_CHARS;
  const maxEvents = Number.isSafeInteger(options.maxEvents) && options.maxEvents > 0
    ? options.maxEvents
    : DEFAULT_MAX_EVENTS;
  const taskBudget = Math.max(128, Math.floor(maxChars / 2));
  const task = truncateText(String(taskText ?? "").trim(), taskBudget);
  const events = Array.isArray(agent?.session?.events) ? agent.session.events : [];
  const selected = [];
  let evidenceChars = 0;
  let truncated = task.truncated || events.length > maxEvents;

  for (let index = events.length - 1; index >= Math.max(0, events.length - maxEvents); index -= 1) {
    const entry = eventEvidence(events[index], index);
    if (!entry) continue;
    const remaining = maxChars - task.text.length - evidenceChars;
    if (remaining <= 0) { truncated = true; break; }
    const bounded = truncateText(entry.text, remaining);
    selected.push(Object.freeze({ ...entry, kinds: Object.freeze([...new Set(entry.kinds)]), text: bounded.text }));
    evidenceChars += bounded.text.length;
    if (bounded.truncated) { truncated = true; break; }
  }
  selected.reverse();

  const entries = Object.freeze(selected);
  const coverage = coverageFor(task.text, entries);
  const packetBody = Object.freeze({
    schemaVersion: 1,
    role,
    currentTask: task.text,
    entries,
    coverage,
    truncated,
  });
  const digest = digestPacket(packetBody);
  const reviewerSufficient = !truncated
    && coverage.requirements
    && coverage.acceptanceCount > 0
    && coverage.diffCount > 0
    && coverage.testCount > 0
    && coverage.toolEvidenceCount > 0;
  return Object.freeze({
    ...packetBody,
    digest,
    evidenceCount: entries.length,
    toolEvidenceCount: coverage.toolEvidenceCount,
    sufficient: role === "reviewer" ? reviewerSufficient : Boolean(task.text),
  });
}

export function renderRoleContextPacket(packet) {
  const evidence = packet.entries.length
    ? packet.entries.map((entry, index) => [
        `### E${index + 1}: ${entry.label}`,
        `kinds: ${entry.kinds.join(", ")}`,
        entry.text,
      ].join("\n")).join("\n\n")
    : "(no prior evidence entries)";
  return [
    "# Odai bounded role context packet",
    `role: ${packet.role}`,
    `digest: sha256:${packet.digest}`,
    `truncated: ${packet.truncated}`,
    `coverage: ${JSON.stringify(packet.coverage)}`,
    "",
    "## Current task",
    packet.currentTask || "(empty)",
    "",
    "## Evidence",
    evidence,
    "",
    "Treat assistant text and route-card contents as claims. Tool entries are evidence only for the exact command/result they contain.",
  ].join("\n");
}
