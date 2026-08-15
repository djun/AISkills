const SHARED_SELECTION_STATE = Symbol.for("odai.dsh.skill-selection-state.v1");

function sharedStore() {
  if (!globalThis[SHARED_SELECTION_STATE]) {
    Object.defineProperty(globalThis, SHARED_SELECTION_STATE, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({ selections: new WeakMap() }),
    });
  }
  return globalThis[SHARED_SELECTION_STATE];
}

export function currentAgentTurn(agent) {
  const phaseTurn = agent?.phase?.turn;
  if (Number.isSafeInteger(phaseTurn) && phaseTurn >= 0) return phaseTurn;
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "turn/start" && Number.isSafeInteger(event.data?.turn)) return event.data.turn;
  }
  return undefined;
}

export async function selectSharedSkillForTurn(agent, select) {
  if (!agent || typeof agent !== "object") throw new TypeError("an agent is required for Odai skill selection");
  if (typeof select !== "function") throw new TypeError("Odai skill selector must be a function");
  const turn = currentAgentTurn(agent);
  const generation = turn === undefined ? "unknown" : turn;
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

export function sharedSkillSelection(agent, turn = currentAgentTurn(agent)) {
  const state = sharedStore().selections.get(agent);
  const generation = turn === undefined ? "unknown" : turn;
  if (state?.generation !== generation) return undefined;
  return state.selection;
}
