import type { CircuitDocument } from "../circuit-model.js";

export interface EditorHistory {
  past: CircuitDocument[];
  present: CircuitDocument;
  future: CircuitDocument[];
  group?: string;
  groupPast?: CircuitDocument[];
  groupFuture?: CircuitDocument[];
}

export type HistoryAction =
  | { type: "edit"; document: CircuitDocument; group?: string }
  | { type: "cancel-group"; group: string }
  | { type: "undo" | "redo" | "end-group" };

type ValuePair = readonly [unknown, unknown];

function isReference(value: unknown): value is object {
  return typeof value === "object" && value !== null || typeof value === "function";
}

function queueOwnValues(left: object, right: object, pending: ValuePair[]) {
  if (Array.isArray(left) !== Array.isArray(right)) { return false; }
  const prototype = Reflect.getPrototypeOf(left);
  if (prototype !== Reflect.getPrototypeOf(right) ||
      (left !== right && prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype)) { return false; }
  const keys = Reflect.ownKeys(left);
  const rightKeys = new Set(Reflect.ownKeys(right));
  if (keys.length !== rightKeys.size) { return false; }
  for (const key of keys) {
    if (!rightKeys.has(key)) { return false; }
    const before = Reflect.getOwnPropertyDescriptor(left, key);
    const after = Reflect.getOwnPropertyDescriptor(right, key);
    if (!before || !after || before.enumerable !== after.enumerable || before.configurable !== after.configurable ||
        ("value" in before) !== ("value" in after)) { return false; }
    if ("value" in before) {
      if (before.writable !== after.writable) { return false; }
      pending.push([before.value, after.value]);
    } else if (before.get !== after.get || before.set !== after.set) { return false; }
  }
  return true;
}

/** Compare own data without losing undefined, non-finite values, or unknown fields. */
function sameHistoryDocument(left: CircuitDocument, right: CircuitDocument) {
  const pending: ValuePair[] = [[left, right]];
  const leftReferences = new WeakMap<object, object>();
  const rightReferences = new WeakMap<object, object>();
  try {
    while (pending.length > 0) {
      const [before, after] = pending.pop()!;
      if (!isReference(before) || !isReference(after)) {
        if (!Object.is(before, after)) { return false; }
        continue;
      }
      if (leftReferences.has(before) || rightReferences.has(after)) {
        if (leftReferences.get(before) !== after || rightReferences.get(after) !== before) { return false; }
        continue;
      }
      leftReferences.set(before, after);
      rightReferences.set(after, before);
      // Shared containers still need visiting: one of their children may also
      // appear elsewhere, where an edit could have changed that alias.
      if (!queueOwnValues(before, after, pending)) { return false; }
    }
    return true;
  } catch {
    // Invalid host documents may include proxies whose reflection traps throw.
    // Keep their edit instead of erasing a change we cannot compare safely.
    return false;
  }
}

function editHistory(state: EditorHistory, action: Extract<HistoryAction, { type: "edit" }>): EditorHistory {
  if (action.document === state.present) { return state; }
  const current = action.group && action.group === state.group ? state : endHistoryGroup(state);
  return {
    past: action.group && action.group === current.group
      ? current.past
      : [...current.past, current.present].slice(-100),
    present: action.document,
    future: [],
    group: action.group,
    groupPast: action.group ? (action.group === current.group ? current.groupPast : current.past) : undefined,
    groupFuture: action.group ? (action.group === current.group ? current.groupFuture : current.future) : undefined,
  };
}

function cancelHistoryGroup(state: EditorHistory, group: string): EditorHistory {
  const original = state.past.at(-1);
  if (!original || state.group !== group) { return state; }
  return { past: state.groupPast ?? state.past.slice(0, -1), present: original, future: state.groupFuture ?? [] };
}

function endHistoryGroup(state: EditorHistory): EditorHistory {
  if (!state.group) { return state; }
  const original = state.past.at(-1);
  if (original && sameHistoryDocument(original, state.present)) { return cancelHistoryGroup(state, state.group); }
  return { ...state, group: undefined, groupPast: undefined, groupFuture: undefined };
}

function undoHistory(state: EditorHistory): EditorHistory {
  const current = endHistoryGroup(state);
  const previous = current.past.at(-1);
  if (!previous) { return current; }
  return { past: current.past.slice(0, -1), present: previous, future: [current.present, ...current.future] };
}

function redoHistory(state: EditorHistory): EditorHistory {
  const current = endHistoryGroup(state);
  const next = current.future[0];
  if (!next) { return current.present === state.present ? state : current; }
  return { past: [...current.past, current.present], present: next, future: current.future.slice(1) };
}

/** Keep a drag or a field edit together so one undo restores the entire action. */
export function editorHistoryReducer(state: EditorHistory, action: HistoryAction): EditorHistory {
  switch (action.type) {
    case "edit":
      return editHistory(state, action);
    case "cancel-group":
      return cancelHistoryGroup(state, action.group);
    case "undo":
      return undoHistory(state);
    case "redo":
      return redoHistory(state);
    case "end-group":
      return endHistoryGroup(state);
  }
}
