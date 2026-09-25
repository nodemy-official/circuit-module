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

/** Keep a drag or a field edit together so one undo restores the entire action. */
export function editorHistoryReducer(state: EditorHistory, action: HistoryAction): EditorHistory {
  switch (action.type) {
    case "edit":
      if (action.document === state.present) return state;
      return {
        past: action.group && action.group === state.group
          ? state.past
          : [...state.past, state.present].slice(-100),
        present: action.document,
        future: [],
        group: action.group,
        groupFuture: action.group ? (action.group === state.group ? state.groupFuture : state.future) : undefined,
      };
    case "cancel-group": {
      const original = state.past.at(-1);
      if (!original || state.group !== action.group) return state;
      return { past: state.past.slice(0, -1), present: original, future: state.groupFuture ?? [] };
    }
    case "undo": {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future] };
    }
    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return { past: [...state.past, state.present], present: next, future: state.future.slice(1) };
    }
    case "end-group":
      return state.group ? { ...state, group: undefined, groupFuture: undefined } : state;
  }
}
