import { describe, expect, it } from "vitest";

import type { CircuitDocument } from "../../circuit-model.js";
import { editorHistoryReducer, type EditorHistory } from "../editor-history.js";

const document = (title: string): CircuitDocument => ({ title, parts: [], wires: [] });
const history = (present: CircuitDocument): EditorHistory => ({ past: [], present, future: [] });

describe("editorHistoryReducer", () => {
  it("undoes grouped moves to their starting point and redoes to the last position", () => {
    const start = document("start");
    const firstMove = document("first move");
    const lastMove = document("last move");

    let state = history(start);
    state = editorHistoryReducer(state, { type: "edit", document: firstMove, group: "drag:part-1" });
    state = editorHistoryReducer(state, { type: "edit", document: lastMove, group: "drag:part-1" });

    expect(state.past).toEqual([start]);
    expect(state.present).toBe(lastMove);
    state = editorHistoryReducer(state, { type: "undo" });
    expect(state.present).toBe(start);
    state = editorHistoryReducer(state, { type: "redo" });
    expect(state.present).toBe(lastMove);
  });

  it("restores past, present, and redo future when canceling a drag after undo", () => {
    const older = document("older");
    const beforeDrag = document("before drag");
    const redoBranch = document("redo branch");
    const firstMove = document("first move");
    const lastMove = document("last move");

    let state = history(older);
    state = editorHistoryReducer(state, { type: "edit", document: beforeDrag });
    state = editorHistoryReducer(state, { type: "edit", document: redoBranch });
    state = editorHistoryReducer(state, { type: "undo" });
    const beforeGroup = state;

    state = editorHistoryReducer(state, { type: "edit", document: firstMove, group: "drag:part-1" });
    state = editorHistoryReducer(state, { type: "edit", document: lastMove, group: "drag:part-1" });
    state = editorHistoryReducer(state, { type: "cancel-group", group: "drag:part-1" });

    expect(state.past).toEqual(beforeGroup.past);
    expect(state.present).toBe(beforeGroup.present);
    expect(state.future).toEqual(beforeGroup.future);
    expect(editorHistoryReducer(state, { type: "redo" }).present).toBe(redoBranch);
  });

  it("leaves the state unchanged when canceling a different group", () => {
    let state = history(document("start"));
    state = editorHistoryReducer(state, { type: "edit", document: document("moving"), group: "drag:part-1" });

    expect(editorHistoryReducer(state, { type: "cancel-group", group: "drag:part-2" })).toBe(state);
  });

  it("keeps a completed drag as one undo step", () => {
    const start = document("start");
    const firstMove = document("first move");
    const lastMove = document("last move");

    let state = history(start);
    state = editorHistoryReducer(state, { type: "edit", document: firstMove, group: "drag:part-1" });
    state = editorHistoryReducer(state, { type: "edit", document: lastMove, group: "drag:part-1" });
    state = editorHistoryReducer(state, { type: "end-group" });
    state = editorHistoryReducer(state, { type: "undo" });

    expect(state.present).toBe(start);
    expect(state.future).toEqual([lastMove]);
  });

  it("starts a new undo step after ending a move group", () => {
    const start = document("start");
    const firstMove = document("first move");
    const lastMove = document("last move");
    const nextDrag = document("next drag");

    let state = history(start);
    state = editorHistoryReducer(state, { type: "edit", document: firstMove, group: "drag:part-1" });
    state = editorHistoryReducer(state, { type: "edit", document: lastMove, group: "drag:part-1" });
    state = editorHistoryReducer(state, { type: "end-group" });
    state = editorHistoryReducer(state, { type: "edit", document: nextDrag, group: "drag:part-1" });

    state = editorHistoryReducer(state, { type: "undo" });
    expect(state.present).toBe(lastMove);
    state = editorHistoryReducer(state, { type: "undo" });
    expect(state.present).toBe(start);
  });

  it("clears the redo future when editing after undo", () => {
    const start = document("start");
    const oldEdit = document("old edit");
    const newEdit = document("new edit");

    let state = history(start);
    state = editorHistoryReducer(state, { type: "edit", document: oldEdit });
    state = editorHistoryReducer(state, { type: "undo" });
    expect(state.future).toEqual([oldEdit]);

    state = editorHistoryReducer(state, { type: "edit", document: newEdit });
    expect(state.future).toEqual([]);
    expect(editorHistoryReducer(state, { type: "redo" })).toBe(state);
  });

  it("keeps at most 100 undo steps", () => {
    let state = history(document("doc-0"));
    for (let index = 1; index <= 105; index += 1) {
      state = editorHistoryReducer(state, { type: "edit", document: document(`doc-${index}`) });
    }

    expect(state.past).toHaveLength(100);
    expect(state.present.title).toBe("doc-105");
    for (let index = 0; index < 100; index += 1) {
      state = editorHistoryReducer(state, { type: "undo" });
    }
    expect(state.present.title).toBe("doc-5");
    expect(editorHistoryReducer(state, { type: "undo" })).toBe(state);
  });

  it("leaves the state unchanged when undo or redo has nothing to restore", () => {
    const state = history(document("only state"));

    expect(editorHistoryReducer(state, { type: "undo" })).toBe(state);
    expect(editorHistoryReducer(state, { type: "redo" })).toBe(state);
  });
});
