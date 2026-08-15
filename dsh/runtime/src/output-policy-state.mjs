const SHARED_OUTPUT_POLICY_STATE = Symbol.for("odai.dsh.output-policy-state.v1");

function sharedStore() {
  if (!globalThis[SHARED_OUTPUT_POLICY_STATE]) {
    Object.defineProperty(globalThis, SHARED_OUTPUT_POLICY_STATE, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({ selections: new WeakMap() }),
    });
  }
  return globalThis[SHARED_OUTPUT_POLICY_STATE];
}

function generationFor(turn) {
  return Number.isSafeInteger(turn) && turn >= 0 ? turn : "unknown";
}

export async function selectSharedOutputPolicyForTurn(agent, turn, select) {
  if (!agent || typeof agent !== "object") throw new TypeError("an agent is required for Odai output policy selection");
  if (typeof select !== "function") throw new TypeError("an Odai output policy selector is required");
  const generation = generationFor(turn);
  const store = sharedStore();
  const existing = store.selections.get(agent);
  if (existing?.generation === generation) return existing.promise;

  const state = { generation };
  state.promise = Promise.resolve().then(select).then((selection) => {
    state.selection = selection;
    return selection;
  }).catch((error) => {
    if (store.selections.get(agent) === state) store.selections.delete(agent);
    throw error;
  });
  store.selections.set(agent, state);
  return state.promise;
}
