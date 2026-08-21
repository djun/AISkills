import { createHash } from "node:crypto";

import { CONFIGURABLE_ROLES } from "./routing-config.mjs";
import type { DshAgent, RuntimeTool, ToolExecution } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

export const RESPONSIBILITY_GAP_PROMPT = [
  "## Odai responsibility gaps",
  "Users provide goals, constraints, materials, and acceptance; they never need to request internal roles or handoffs.",
  "Keep work direct when the controller can close it reliably. Call odai_responsibility_gap only when current evidence shows an independent capability or user-decision gap that can change a concrete result; keywords, complexity, risk, configured models, and price are insufficient. The runtime decides direct, inline, same-turn, child, or user-question handling.",
  "Independently deployed contracts, authentication or state-machine changes, rollout-order compatibility, and rollback boundaries are concrete planner gaps when a separate plan can change implementation or acceptance; do not reduce them to task complexity.",
  "evidenceRefs identify the proposal state for audit and deduplication; they never replace native acceptance, write, diff, or test evidence required by a routed reviewer.",
  "Use responsibility=user only for a missing user-owned choice, priority, or unacceptable outcome, then ask exactly the accepted concise question. Do not ask users for repository facts or implementation details the project can determine. Do not resubmit unchanged state.",
].join("\n");

const RESPONSIBILITIES = Object.freeze([...CONFIGURABLE_ROLES, "user"]);
export type Responsibility = (typeof RESPONSIBILITIES)[number];

export interface ResponsibilityGapProposal {
  readonly responsibility: Responsibility;
  readonly gap: string;
  readonly evidenceRefs: readonly string[];
  readonly expectedChange: string;
  readonly question?: string;
  readonly stateDigest: string;
}

export interface ResponsibilityGapResult {
  recorded: true;
  responsibility: Responsibility;
  stateDigest: string;
  next: string;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function stateDigest(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isResponsibility(value: unknown): value is Responsibility {
  return typeof value === "string" && (RESPONSIBILITIES as readonly string[]).includes(value);
}

export function resolveResponsibilityGap(value: unknown): Readonly<ResponsibilityGapProposal> {
  if (!isUnknownRecord(value)) throw new TypeError("responsibility gap must be an object");
  const unknownFields = Object.keys(value).filter((field) => !["responsibility", "gap", "evidenceRefs", "expectedChange", "question"].includes(field));
  if (unknownFields.length > 0) throw new TypeError(`responsibility gap has unknown fields: ${unknownFields.join(", ")}`);
  if (!isResponsibility(value.responsibility)) throw new TypeError(`responsibility must be ${RESPONSIBILITIES.join(", ")}`);
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0 || value.evidenceRefs.length > 12) {
    throw new TypeError("evidenceRefs must contain 1 to 12 evidence references");
  }
  const evidenceRefs = value.evidenceRefs.map((entry, index) => nonEmpty(entry, `evidenceRefs[${index}]`));
  const gap = nonEmpty(value.gap, "gap");
  const expectedChange = nonEmpty(value.expectedChange, "expectedChange");
  const question = value.question === undefined ? undefined : nonEmpty(value.question, "question");
  if (value.responsibility === "user" && question === undefined) throw new TypeError("question is required for a user decision gap");
  if (value.responsibility !== "user" && question !== undefined) throw new TypeError("question is only valid for a user decision gap");
  const proposal = {
    responsibility: value.responsibility,
    gap,
    evidenceRefs: Object.freeze(evidenceRefs),
    expectedChange,
    ...(question === undefined ? {} : { question }),
  };
  return Object.freeze({ ...proposal, stateDigest: stateDigest(proposal) });
}

export interface ResponsibilityGapToolOptions {
  isChild?(agent: DshAgent): boolean;
  onProposed?(agent: DshAgent, proposal: Readonly<ResponsibilityGapProposal>, execution: ToolExecution): void;
}

export function createResponsibilityGapTool(
  options: ResponsibilityGapToolOptions = {},
): RuntimeTool<unknown, ResponsibilityGapResult> {
  const isChild = typeof options.isChild === "function" ? options.isChild : () => false;
  const onProposed = typeof options.onProposed === "function" ? options.onProposed : () => {};
  return {
    name: "odai_responsibility_gap",
    description: "Submit one evidence-grounded responsibility or user-decision gap discovered from the current task state. Users never call this tool or name internal roles. Use it only when the gap can change the result; keywords, complexity, risk, configured models, and lower price are insufficient. The runtime decides direct, inline, same-turn, child, or user-question handling.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["responsibility", "gap", "evidenceRefs", "expectedChange"],
      properties: {
        responsibility: { type: "string", enum: [...RESPONSIBILITIES] },
        gap: { type: "string" },
        evidenceRefs: { type: "array", items: { type: "string" } },
        expectedChange: { type: "string" },
        question: { type: "string" },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["recorded", "responsibility", "stateDigest", "next"],
        properties: {
          recorded: { type: "boolean" },
          responsibility: { type: "string", enum: [...RESPONSIBILITIES] },
          stateDigest: { type: "string" },
          next: { type: "string" },
        },
      },
      render(_arguments, value) {
        return [{
          type: "text",
          text: `Recorded ${value.responsibility} gap (${value.stateDigest}); this responsibility has not been routed or started. ${value.next}`,
        }];
      },
    },
    execute(arguments_, execution) {
      if (!execution.agent) throw new Error("odai_responsibility_gap requires an owning agent session");
      if (isChild(execution.agent)) throw new Error("child agents may not own Odai responsibility or user-decision gaps");
      const proposal = resolveResponsibilityGap(arguments_);
      onProposed(execution.agent, proposal, execution);
      return Promise.resolve({
        recorded: true,
        responsibility: proposal.responsibility,
        stateDigest: proposal.stateDigest,
        next: proposal.responsibility === "user"
          ? "Ask exactly the accepted concise question and wait for the user's decision."
          : "The runtime will reassess the recorded proposal before the next affected model step and will report separately whether it routed or started.",
      });
    },
  };
}
