import type { ResponsibilityScope } from "./responsibility-scope.mjs";
import type { RouteCard } from "./route-card.mjs";
import type { DshAgent, RuntimeTool, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

export type ResponsibilityReturnTarget = "controller" | "executor";

export interface ResponsibilityReturnResult extends UnknownRecord {
  returned: true;
  scopeId: string;
  responsibility: string;
  target: ResponsibilityReturnTarget;
  summary: string;
  evidenceRefs: readonly string[];
  routeCardId?: string;
}

interface ResponsibilityReturnOptions {
  activeScopeFor(agent: DshAgent): ResponsibilityScope | undefined;
  activeCardFor(agent: DshAgent): RouteCard | undefined;
  onReturned(agent: DshAgent, result: ResponsibilityReturnResult): void;
}

const RETURNABLE_RESPONSIBILITIES = new Set(["researcher", "planner", "reviewer"]);

function nonEmpty(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function evidenceReferences(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    throw new TypeError("evidenceRefs must contain 1 to 12 references");
  }
  return Object.freeze(value.map((entry, index) => nonEmpty(entry, `evidenceRefs[${index}]`, 500)));
}

export function createResponsibilityReturnTool(
  options: ResponsibilityReturnOptions,
): RuntimeTool<unknown, ResponsibilityReturnResult> {
  return {
    name: "odai_responsibility_return",
    description: "Return a completed same-turn read-only researcher, planner, or reviewer responsibility to the preserved controller route, or from planner to an authorized frozen executor route. This mechanically ends the responsibility scope; a terminal response does not.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["target", "summary", "evidenceRefs"],
      properties: {
        target: { type: "string", enum: ["controller", "executor"] },
        summary: { type: "string", description: "Bounded result for the controller or executor; at most 12000 characters." },
        evidenceRefs: { type: "array", items: { type: "string" }, description: "One to twelve decisive evidence references." },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["returned", "scopeId", "responsibility", "target", "summary", "evidenceRefs"],
        properties: {
          returned: { type: "boolean", const: true },
          scopeId: { type: "string" },
          responsibility: { type: "string", enum: ["researcher", "planner", "reviewer"] },
          target: { type: "string", enum: ["controller", "executor"] },
          summary: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
          routeCardId: { type: "string" },
        },
      },
      render(_arguments, value) {
        return [{
          type: "text",
          text: [
            `Returned ${value.responsibility} responsibility to ${value.target}.`,
            `scopeId=${value.scopeId}`,
            ...(value.routeCardId ? [`routeCardId=${value.routeCardId}`] : []),
            "",
            value.summary,
            "",
            `Evidence: ${value.evidenceRefs.join("; ")}`,
          ].join("\n"),
        }];
      },
    },
    execute(arguments_, execution) {
      if (!execution.agent) throw new Error("odai_responsibility_return requires an owning agent session");
      if (!isUnknownRecord(arguments_)) throw new TypeError("arguments must be an object");
      const scope = options.activeScopeFor(execution.agent);
      if (!scope || scope.continuationPolicy !== "read-only-tool-chain" || !RETURNABLE_RESPONSIBILITIES.has(scope.role)) {
        throw new Error("odai_responsibility_return requires an active same-turn read-only researcher, planner, or reviewer scope");
      }
      const target = arguments_.target;
      if (target !== "controller" && target !== "executor") throw new TypeError("target must be controller or executor");
      const summary = nonEmpty(arguments_.summary, "summary", 12_000);
      const evidenceRefs = evidenceReferences(arguments_.evidenceRefs);
      let routeCard: RouteCard | undefined;
      if (target === "executor") {
        if (scope.role !== "planner") throw new Error("only planner may return directly to executor");
        routeCard = options.activeCardFor(execution.agent);
        if (!routeCard || routeCard.authorization.status !== "authorized") {
          throw new Error("planner handback to executor requires an active authorized frozen route card");
        }
      }
      const result = Object.freeze({
        returned: true as const,
        scopeId: scope.id,
        responsibility: scope.role,
        target,
        summary,
        evidenceRefs,
        ...(routeCard ? { routeCardId: routeCard.id } : {}),
      });
      options.onReturned(execution.agent, result);
      return Promise.resolve(result);
    },
  };
}
