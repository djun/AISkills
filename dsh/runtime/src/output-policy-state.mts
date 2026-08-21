import type { DshAgent } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

const SHARED_OUTPUT_POLICY_STATE = Symbol.for("odai.dsh.output-policy-state.v1");

type SelectionGeneration = number | "unknown";

interface SelectionState<T> {
  generation: SelectionGeneration;
  promise: Promise<T>;
  selection?: T;
}

interface SharedOutputPolicyStore {
  selections: WeakMap<object, SelectionState<unknown>>;
}

interface SymbolIndexedGlobal {
  [key: symbol]: unknown;
}

function isSharedStore(value: unknown): value is SharedOutputPolicyStore {
  return isUnknownRecord(value) && value.selections instanceof WeakMap;
}

function sharedStore(): SharedOutputPolicyStore {
  const root = globalThis as typeof globalThis & SymbolIndexedGlobal;
  const existing = root[SHARED_OUTPUT_POLICY_STATE];
  if (isSharedStore(existing)) return existing;
  const created = Object.freeze({
    selections: new WeakMap<object, SelectionState<unknown>>(),
  });
  Object.defineProperty(root, SHARED_OUTPUT_POLICY_STATE, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: created,
  });
  return created;
}

function generationFor(turn: number | undefined): SelectionGeneration {
  return Number.isSafeInteger(turn) && (turn ?? -1) >= 0 ? turn as number : "unknown";
}

export async function selectSharedOutputPolicyForTurn<T>(
  agent: DshAgent,
  turn: number | undefined,
  select: () => T | Promise<T>,
): Promise<T> {
  if (!agent || typeof agent !== "object") throw new TypeError("an agent is required for Odai output policy selection");
  if (typeof select !== "function") throw new TypeError("an Odai output policy selector is required");
  const generation = generationFor(turn);
  const store = sharedStore();
  const existing = store.selections.get(agent) as SelectionState<T> | undefined;
  if (existing?.generation === generation) return existing.promise;

  const state: SelectionState<T> = {
    generation,
    promise: Promise.resolve().then(select).then((selection) => {
      state.selection = selection;
      return selection;
    }).catch((error: unknown) => {
      if (store.selections.get(agent) === state) store.selections.delete(agent);
      throw error;
    }),
  };
  store.selections.set(agent, state);
  return state.promise;
}
