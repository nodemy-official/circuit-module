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

  it("restores all 100 undo steps when canceling a drag at the history limit", () => {
    let state = history(document("doc-0"));
    for (let index = 1; index <= 102; index += 1) {
      state = editorHistoryReducer(state, { type: "edit", document: document(`doc-${index}`) });
    }
    const original = state;

    state = editorHistoryReducer(state, { type: "edit", document: document("drag-1"), group: "drag:part-1" });
    state = editorHistoryReducer(state, { type: "edit", document: document("drag-2"), group: "drag:part-1" });
    state = editorHistoryReducer(state, { type: "cancel-group", group: "drag:part-1" });

    expect(state.past).toEqual(original.past);
    expect(state.present).toBe(original.present);
    expect(state.future).toEqual(original.future);
    for (let index = 0; index < 100; index += 1) {
      state = editorHistoryReducer(state, { type: "undo" });
    }
    expect(state.present.title).toBe("doc-2");
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

  it.each(["end-group", "undo", "redo", "edit"] as const)("removes an unchanged group before %s and preserves the original history branch", (boundary) => {
    const older = document("older");
    const original = document("original");
    const redo = document("redo");
    const next = document("next");
    let state: EditorHistory = { past: [older], present: original, future: [redo] };
    state = editorHistoryReducer(state, { type: "edit", document: document("changed"), group: "title" });
    state = editorHistoryReducer(state, { type: "edit", document: document("original"), group: "title" });
    state = editorHistoryReducer(state, boundary === "edit" ? { type: "edit", document: next, group: "next" } : { type: boundary });

    if (boundary === "end-group") {
      expect(state).toEqual({ past: [older], present: original, future: [redo] });
      expect(state.present).toBe(original);
    } else if (boundary === "undo") {
      expect(state).toEqual({ past: [], present: older, future: [original, redo] });
    } else if (boundary === "redo") {
      expect(state).toEqual({ past: [older, original], present: redo, future: [] });
    } else {
      expect(state.past).toEqual([older, original]);
      expect(state.present).toBe(next);
      expect(state.future).toEqual([]);
    }
  });

  it("does not retain a first grouped edit whose contents never changed", () => {
    const original = document("same");
    let state = history(original);
    state = editorHistoryReducer(state, { type: "edit", document: document("same"), group: "title" });
    state = editorHistoryReducer(state, { type: "end-group" });

    expect(state).toEqual(history(original));
    expect(state.present).toBe(original);
  });

  it("restores the entire bounded history and redo branch after an unchanged group", () => {
    const past = Array.from({ length: 100 }, (_, index) => document(String(index)));
    const original: EditorHistory = { past, present: document("original"), future: [document("redo")] };
    let state = editorHistoryReducer(original, { type: "edit", document: document("changed"), group: "title" });
    state = editorHistoryReducer(state, { type: "edit", document: document("original"), group: "title" });
    state = editorHistoryReducer(state, { type: "end-group" });

    expect(state).toEqual(original);
    expect(state.present).toBe(original.present);
    expect(state.past).toBe(past);
  });

  it.each([
    { before: {}, after: { extra: undefined } },
    { before: { extra: Number.NaN }, after: { extra: Number.POSITIVE_INFINITY } },
    { before: { extra: -0 }, after: { extra: 0 } },
    { before: { extra: [undefined] }, after: { extra: new Array<unknown>(1) } },
    { before: { extra: new Date(0) }, after: { extra: new Date(0) } },
    { before: { extra: { nested: 1n } }, after: { extra: { nested: 2n } } },
  ])("preserves edits to fields that JSON would discard or conflate ($before, $after)", ({ before, after }) => {
    const original = { ...document("same"), ...before };
    const edited = { ...document("same"), ...after };
    let state = editorHistoryReducer(history(original), { type: "edit", document: edited, group: "metadata" });
    state = editorHistoryReducer(state, { type: "end-group" });

    expect(state.past).toEqual([original]);
    expect(state.present).toBe(edited);
  });

  it("compares unknown symbol fields and property descriptors without invoking getters", () => {
    const symbol = Symbol("metadata");
    let reads = 0;
    const getter = () => { reads += 1; throw new Error("must not read accessor"); };
    const original = Object.defineProperty({ ...document("same"), [symbol]: 1 }, "extra", { get: getter });
    const equivalent = Object.defineProperty({ ...document("same"), [symbol]: 1 }, "extra", { get: getter });
    const changed = Object.defineProperty({ ...document("same"), [symbol]: 2 }, "extra", { get: getter });

    const ended = editorHistoryReducer(editorHistoryReducer(history(original), { type: "edit", document: equivalent, group: "metadata" }), { type: "end-group" });
    expect(ended.present === original).toBe(true);
    expect(ended.past).toEqual([]);
    const kept = editorHistoryReducer(editorHistoryReducer(history(original), { type: "edit", document: changed, group: "metadata" }), { type: "end-group" });
    expect(kept.present === changed).toBe(true);
    expect(kept.past[0] === original).toBe(true);
    expect(reads).toBe(0);
  });

  it("handles cyclic metadata and equal NaN values without recursing indefinitely", () => {
    function cyclicDocument() {
      const metadata: { value: number; self?: unknown } = { value: Number.NaN };
      metadata.self = metadata;
      return { ...document("same"), metadata };
    }
    const original = cyclicDocument();
    let state = editorHistoryReducer(history(original), { type: "edit", document: cyclicDocument(), group: "metadata" });
    state = editorHistoryReducer(state, { type: "end-group" });

    expect(state.present).toBe(original);
    expect(state.past).toEqual([]);
  });

  it("does not discard changes to metadata sharing or property attributes", () => {
    const shared = { value: 1 };
    const original = { ...document("same"), metadata: [shared, shared] };
    const separate = { ...document("same"), metadata: [{ value: 1 }, { value: 1 }] };
    const changedSharing = editorHistoryReducer(editorHistoryReducer(history(original), { type: "edit", document: separate, group: "metadata" }), { type: "end-group" });
    expect(changedSharing.present).toBe(separate);
    expect(changedSharing.past).toEqual([original]);

    const hidden = Object.defineProperty(document("same"), "metadata", { value: 1, enumerable: false });
    const visible = Object.defineProperty(document("same"), "metadata", { value: 1, enumerable: true });
    const changedAttributes = editorHistoryReducer(editorHistoryReducer(history(hidden), { type: "edit", document: visible, group: "metadata" }), { type: "end-group" });
    expect(changedAttributes.present).toBe(visible);
    expect(changedAttributes.past[0]).toBe(hidden);
  });

  it.each((["plain", "date", "function"] as const).flatMap((representation) => [false, true].map((reversed) => ({ representation, reversed }))))
  ("retains alias changes underneath unchanged $representation metadata (reversed=$reversed)", ({ representation, reversed }) => {
    const shared = { value: 1 };
    const parent = representation === "plain" ? {} : representation === "date" ? new Date(0) : () => {};
    const unchanged = Object.assign(parent, { nested: shared });
    const metadata = reversed ? [shared, unchanged] : [unchanged, shared];
    const changedMetadata = reversed ? [{ value: 1 }, unchanged] : [unchanged, { value: 1 }];
    const original = { ...document("same"), metadata };
    const edited = { ...document("same"), metadata: changedMetadata };
    const state = editorHistoryReducer(history(original), { type: "edit", document: edited, group: "metadata" });

    const ended = editorHistoryReducer(state, { type: "end-group" });

    expect(ended.present).toBe(edited);
    expect(ended.past).toEqual([original]);
    expect(editorHistoryReducer(ended, { type: "undo" }).present).toBe(original);
  });

  it("retains malformed documents when their properties cannot be inspected safely", () => {
    const original = new Proxy(document("same"), { ownKeys() { throw new Error("unreadable input"); } });
    const edited = document("same");
    const state = editorHistoryReducer(history(original), { type: "edit", document: edited, group: "title" });

    const ended = editorHistoryReducer(state, { type: "end-group" });
    expect(ended.present).toBe(edited);
    expect(ended.past[0]).toBe(original);
  });

  it.each(["count", "keys"] as const)("keeps edits when an unchanged Proxy reports inconsistent own field %s", (difference) => {
    const shared = { value: 1 };
    let reads = 0;
    const parent = new Proxy({ nested: shared, other: 0 }, {
      ownKeys() {
        reads += 1;
        if (difference === "count") { return reads % 2 ? ["nested"] : []; }
        return reads % 2 ? ["other"] : ["nested"];
      },
    });
    const original = { ...document("same"), metadata: [parent, shared] };
    const edited = { ...document("same"), metadata: [parent, { value: 1 }] };
    const changed = editorHistoryReducer(history(original), { type: "edit", document: edited, group: "metadata" });

    const ended = editorHistoryReducer(changed, { type: "end-group" });

    expect(ended.present).toBe(edited);
    expect(ended.past).toEqual([original]);
  });
});
