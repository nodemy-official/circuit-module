import { expect, it } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { editorHistoryReducer, type EditorHistory } from "../editor-history.js";

it.each([0, 1, 100])("discards an unchanged group after unavailable redo when its original reference was restored (%s earlier edits)", (count) => {
  const original: CircuitDocument = { title: "original", parts: [], wires: [] };
  const past = Array.from({ length: count }, (_, index): CircuitDocument => ({ title: `earlier-${index}`, parts: [], wires: [] }));
  const initial: EditorHistory = { past, present: original, future: [] };
  let state = editorHistoryReducer(initial, { type: "edit", document: { ...original, title: "changed" }, group: "title" });
  state = editorHistoryReducer(state, { type: "edit", document: original, group: "title" });
  state = editorHistoryReducer(state, { type: "redo" });

  expect(state).toEqual(initial);
  expect(state.present).toBe(original);
  expect(state.past).toBe(past);
  const undone = editorHistoryReducer(state, { type: "undo" });
  if (count === 0) { expect(undone).toBe(state); }
  else { expect(undone.present).toBe(past.at(-1)); }
});
