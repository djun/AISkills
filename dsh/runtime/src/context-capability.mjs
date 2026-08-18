export const ODAI_CONTEXT_CAPABILITIES = Object.freeze([
  "routing-config",
  "human-care",
  "human-safety",
  "skill-source",
  "skill-evolution",
  "output-config",
  "compaction-config",
  "memory",
  "safety-continuity",
]);

const CAPABILITY_FIELDS = Object.freeze({
  "routing-config": "routingConfig",
  "human-care": "care",
  "human-safety": "safety",
  "skill-source": "skillSource",
  "skill-evolution": "skillEvolution",
  "output-config": "outputConfig",
  "compaction-config": "compactionConfig",
  memory: "memory",
  "safety-continuity": "continuity",
});

export function requestedContextCapabilities(events, turn) {
  if (!Number.isSafeInteger(turn)) return Object.freeze([]);
  const capabilities = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "odai/context-capability-requested"
      && event.data?.turn === turn
      && ODAI_CONTEXT_CAPABILITIES.includes(event.data.capability)) {
      capabilities.add(event.data.capability);
    }
  }
  return Object.freeze([...capabilities]);
}

export function activateRequestedCapabilities(activation, capabilities) {
  const merged = { ...activation };
  for (const capability of capabilities) {
    const field = CAPABILITY_FIELDS[capability];
    if (field) merged[field] = true;
  }
  if (merged.safety) merged.care = false;
  return Object.freeze(merged);
}

export function createContextCapabilityTool(options = {}) {
  const isChild = typeof options.isChild === "function" ? options.isChild : () => false;
  const onRequested = typeof options.onRequested === "function" ? options.onRequested : () => {};
  return {
    name: "odai_context_capability",
    description: "Request one Odai capability when its specialized tool is not currently visible. Use this only as a discovery fallback for routing configuration, non-crisis care, crisis safety, skill source/evolution, output, compaction, memory, or safety continuity. The real tool and its complete constraints appear on the next step; this request performs no configuration, persistence, diagnosis, or model switch.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["capability"],
      properties: {
        capability: { type: "string", enum: ODAI_CONTEXT_CAPABILITIES },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["capability", "status"],
        properties: {
          capability: { type: "string", enum: ODAI_CONTEXT_CAPABILITIES },
          status: { type: "string", enum: ["available-next-step"] },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: `Odai ${value.capability} capability is available on the next step.` }];
      },
    },
    execute(args, execution) {
      if (!execution.agent) throw new Error("odai_context_capability requires an owning agent session");
      if (isChild(execution.agent)) throw new Error("child agents may not request Odai controller capabilities");
      if (!args || typeof args !== "object" || Array.isArray(args) || !ODAI_CONTEXT_CAPABILITIES.includes(args.capability)) {
        throw new TypeError(`capability must be ${ODAI_CONTEXT_CAPABILITIES.join(", ")}`);
      }
      onRequested(execution.agent, args.capability, execution);
      return Promise.resolve({ capability: args.capability, status: "available-next-step" });
    },
  };
}
