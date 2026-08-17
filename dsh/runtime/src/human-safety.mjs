export const HUMAN_SAFETY_REFERENCE_PATH = "references/human-safety.md";

export function createHumanSafetyTool(options = {}) {
  if (typeof options.contractFor !== "function") throw new TypeError("createHumanSafetyTool requires contractFor");
  return {
    name: "odai_human_safety",
    description: "Load Odai's highest-priority human-safety contract when the current conversation contains an explicit signal or accumulating evidence of fatigue, persistent low mood, hopelessness, self-harm, suicide, or immediate danger. Invoke proactively without waiting for the user to request help. This tool takes no health details and must not be used to diagnose, profile, score, or persist the user's state. Immediate danger already yields task priority to compassionate safety confirmation and real-world support.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "principles", "userChannelOwner", "contract"],
        properties: {
          priority: { type: "string", enum: ["highest"] },
          principles: {
            type: "array",
            items: { type: "string", enum: ["early-warning", "timely-intervention", "active-guidance", "no-secondary-harm"] },
          },
          userChannelOwner: { type: "string", enum: ["current-controller", "controller"] },
          contract: { type: "string" },
        },
      },
      render(_args, value) {
        return [{
          type: "text",
          text: `Human-safety contract loaded; the ${value.userChannelOwner} owns the user-facing response.\n\n${value.contract}`,
        }];
      },
    },
    execute(args, execution) {
      if (args === null || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length > 0) {
        throw new TypeError("odai_human_safety accepts no arguments");
      }
      if (!execution.agent) throw new Error("odai_human_safety requires an owning agent session");
      const contract = options.contractFor(execution.agent);
      if (typeof contract !== "string" || contract.trim() === "") throw new Error("Odai human-safety contract is unavailable");
      return Promise.resolve({
        priority: "highest",
        principles: ["early-warning", "timely-intervention", "active-guidance", "no-secondary-harm"],
        userChannelOwner: options.isChild?.(execution.agent) ? "controller" : "current-controller",
        contract: contract.trim(),
      });
    },
  };
}
