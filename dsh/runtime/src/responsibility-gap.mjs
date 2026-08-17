import { createHash } from "node:crypto";

import { CONFIGURABLE_ROLES } from "./routing-config.mjs";

export const RESPONSIBILITY_GAP_PROMPT = [
  "## Odai automatic responsibility and user-alignment gaps",
  "Users describe goals, constraints, materials, and acceptance; they never need to request internal roles, routing modes, or handoffs.",
  "Keep work direct when the current controller can close it reliably. Keywords such as plan, review, research, frontend, or independent are only clues and never sufficient routing authority.",
  "When project evidence reveals a real capability gap that can change the result, call odai_responsibility_gap with the smallest grounded proposal before the next affected action. The runtime chooses inline, same-turn, or child execution from the configured mapping, context need, evidence, and net benefit.",
  "Use responsibility=user only when a missing user-owned choice, priority, or unacceptable outcome changes the route. Ask one concise question after the tool accepts that gap. Do not ask users for repository facts, technical investigation, implementation details the project already determines, or internal routing choices.",
  "Do not submit a gap merely because a task is complex, risky, multi-step, uses a role word, has a configured model, or could use a cheaper model. Do not resubmit an unchanged gap or state.",
].join("\n");

const RESPONSIBILITIES = Object.freeze([...CONFIGURABLE_ROLES, "user"]);

function nonEmpty(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function stateDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function resolveResponsibilityGap(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("responsibility gap must be an object");
  const unknown = Object.keys(value).filter((field) => !["responsibility", "gap", "evidenceRefs", "expectedChange", "question"].includes(field));
  if (unknown.length > 0) throw new TypeError(`responsibility gap has unknown fields: ${unknown.join(", ")}`);
  if (!RESPONSIBILITIES.includes(value.responsibility)) throw new TypeError(`responsibility must be ${RESPONSIBILITIES.join(", ")}`);
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

export function createResponsibilityGapTool(options = {}) {
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
        gap: { type: "string", description: "The unresolved capability or user-owned decision gap." },
        evidenceRefs: { type: "array", items: { type: "string" }, description: "Small stable references to current task evidence." },
        expectedChange: { type: "string", description: "The concrete decision, artifact, or acceptance result this responsibility can change." },
        question: { type: "string", description: "One concise question, required only for responsibility=user." },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["accepted", "responsibility", "stateDigest", "next"],
        properties: {
          accepted: { type: "boolean" },
          responsibility: { type: "string", enum: [...RESPONSIBILITIES] },
          stateDigest: { type: "string" },
          next: { type: "string" },
        },
      },
      render(_args, value) {
        return [{
          type: "text",
          text: `Accepted ${value.responsibility} gap (${value.stateDigest}). ${value.next}`,
        }];
      },
    },
    execute(args, execution) {
      if (!execution.agent) throw new Error("odai_responsibility_gap requires an owning agent session");
      if (isChild(execution.agent)) throw new Error("child agents may not own Odai responsibility or user-decision gaps");
      const proposal = resolveResponsibilityGap(args);
      onProposed(execution.agent, proposal, execution);
      return Promise.resolve({
        accepted: true,
        responsibility: proposal.responsibility,
        stateDigest: proposal.stateDigest,
        next: proposal.responsibility === "user"
          ? "Ask exactly the accepted concise question and wait for the user's decision."
          : "The runtime will reassess this responsibility before the next affected model step.",
      });
    },
  };
}
