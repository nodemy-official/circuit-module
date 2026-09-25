import type { CircuitDocument } from "../circuit-model.js";

export interface EditorHistory {
  past: CircuitDocument[];
  present: CircuitDocument;
  future: CircuitDocument[];
  group?: string;
  groupFuture?: CircuitDocument[];
}

export type HistoryAction =
  | { type: "edit"; document: CircuitDocument; group?: string }
  | { type: "cancel-group"; group: string }
  | { type: "undo" | "redo" | "end-group" };

function editHistory(state: EditorHistory, action: Extract<HistoryAction, { type: "edit" }>): EditorHistory {
  if (action.document === state.present) { return state; }
  return {
    past: action.group && action.group === state.group
      ? state.past
      : [...state.past, state.present].slice(-100),
    present: action.document,
    future: [],
    group: action.group,
    groupFuture: action.group ? (action.group === state.group ? state.groupFuture : state.future) : undefined,
  };
}

function cancelHistoryGroup(state: EditorHistory, group: string): EditorHistory {
  const original = state.past.at(-1);
  if (!original || state.group !== group) { return state; }
  return { past: state.past.slice(0, -1), present: original, future: state.groupFuture ?? [] };
}

function undoHistory(state: EditorHistory): EditorHistory {
  const previous = state.past.at(-1);
  if (!previous) { return state; }
  return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future] };
}

function redoHistory(state: EditorHistory): EditorHistory {
  const next = state.future[0];
  if (!next) { return state; }
  return { past: [...state.past, state.present], present: next, future: state.future.slice(1) };
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
      return state.group ? { ...state, group: undefined, groupFuture: undefined } : state;
  }
}
