export const HUMAN_CARE_REFERENCE_PATH = "references/care.md";

export function createHumanCareTool(options = {}) {
  if (typeof options.contractFor !== "function") throw new TypeError("createHumanCareTool requires contractFor");
  return {
    name: "odai_human_care",
    description: "Load Odai's non-crisis care and user-controlled interaction-style contract when the current message shows fatigue, anxiety, self-doubt, rumination, shame, fear of mistakes, negativity, or reduced agency. This does not diagnose, score, persist state, or change model routing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["scope", "userChannelOwner", "contract"],
        properties: {
          scope: { type: "string", enum: ["non-crisis-care"] },
          userChannelOwner: { type: "string", enum: ["current-controller", "controller"] },
          contract: { type: "string" },
        },
      },
      render(_args, value) {
        return [{
          type: "text",
          text: `Non-crisis care contract loaded; the ${value.userChannelOwner} owns the response.\n\n${value.contract}`,
        }];
      },
    },
    execute(args, execution) {
      if (args === null || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length > 0) {
        throw new TypeError("odai_human_care accepts no arguments");
      }
      if (!execution.agent) throw new Error("odai_human_care requires an owning agent session");
      const contract = options.contractFor(execution.agent);
      if (typeof contract !== "string" || contract.trim() === "") throw new Error("Odai human-care contract is unavailable");
      return Promise.resolve({
        scope: "non-crisis-care",
        userChannelOwner: options.isChild?.(execution.agent) ? "controller" : "current-controller",
        contract: contract.trim(),
      });
    },
  };
}
