import { useMemo, useReducer, useState } from "react";
import { editorHistoryReducer, type EditorHistory } from "./editor-history.js";
import {
  addPart,
  connect,
  connectToPoint,
  findFreeSpot,
  moveParts,
  removeSelection,
  rotateParts,
  type CircuitSelection,
} from "../circuit-edit.js";
import type { Point } from "../circuit-geometry.js";
import { analyzeCircuit } from "../circuit-solver.js";
import {
  createExampleCircuit,
  sameEndpoint,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitPartKind,
} from "../circuit-model.js";

const noSelection = (): CircuitSelection => ({ parts: [], wires: [] });

/** State and commands for the optional editor UI. The circuit functions remain usable on their own. */
export function useCircuitEditor(initialDocument?: CircuitDocument) {
  const [history, dispatch] = useReducer(editorHistoryReducer, initialDocument, (initial): EditorHistory => ({
    past: [], present: initial ?? createExampleCircuit(), future: [],
  }));
  const document = history.present;
  const [selection, setSelection] = useState<CircuitSelection>(noSelection);
  const [pendingEndpoint, setPendingEndpoint] = useState<CircuitEndpoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const analysis = useMemo(() => analyzeCircuit(document), [document]);

  function setDocument(next: CircuitDocument, group?: string) {
    dispatch({ type: "edit", document: next, group });
  }

  function endEdit() {
    dispatch({ type: "end-group" });
  }

  function add(kind: CircuitPartKind, near: Point = { x: 25, y: 10 }) {
    const spot = findFreeSpot(document, kind, near);
    const result = addPart(document, kind, spot);
    if (!result.ok) return setError(result.reason);
    setDocument(result.document);
    setSelection({ parts: [result.id], wires: [] });
    setPendingEndpoint(null);
    setError(null);
  }

  function selectPart(id: string) {
    endEdit();
    setSelection({ parts: [id], wires: [] });
    setError(null);
  }

  function selectWire(id: string) {
    endEdit();
    setSelection({ parts: [], wires: [id] });
    setError(null);
  }

  function chooseTerminal(endpoint: CircuitEndpoint) {
    if (!pendingEndpoint) {
      setPendingEndpoint(endpoint);
      setError(null);
      return;
    }
    if (sameEndpoint(pendingEndpoint, endpoint)) {
      setPendingEndpoint(null);
      return;
    }
    const result = connect(document, pendingEndpoint, endpoint);
    if (result.ok) {
      setDocument(result.document);
      setSelection({ parts: [], wires: [result.id] });
      setError(null);
    } else {
      setError(result.reason);
    }
    setPendingEndpoint(null);
  }

  function choosePoint(point: Point) {
    if (!pendingEndpoint) {
      setSelection(noSelection());
      return;
    }
    const result = connectToPoint(document, pendingEndpoint, point);
    if (result.ok) {
      setDocument(result.document);
      setSelection({ parts: [], wires: [result.id] });
      setError(null);
    } else setError(result.reason);
    setPendingEndpoint(null);
  }

  function movePart(id: string, dx: number, dy: number) {
    if (!dx && !dy) return;
    const result = moveParts(document, [id], dx, dy);
    if (result.ok) {
      setDocument(result.document, `move:${id}`);
      setError(null);
    } else setError(result.reason);
  }

  function rotateSelected() {
    if (selection.parts.length === 0) return;
    const result = rotateParts(document, selection.parts);
    if (result.ok) {
      setDocument(result.document);
      setError(null);
    } else setError(result.reason);
  }

  function removeSelected() {
    if (selection.parts.length === 0 && selection.wires.length === 0) return;
    setDocument(removeSelection(document, selection));
    setSelection(noSelection());
    setPendingEndpoint(null);
    setError(null);
  }

  function updatePart(id: string, patch: Partial<CircuitPart>) {
    const part = document.parts.find((item) => item.id === id);
    if (!part || Object.entries(patch).every(([key, value]) => part[key as keyof CircuitPart] === value)) return;
    setDocument({
      ...document,
      parts: document.parts.map((part) => part.id === id ? { ...part, ...patch } : part),
    }, "initiallyClosed" in patch ? undefined : `property:${id}:${Object.keys(patch).sort().join(",")}`);
    setError(null);
  }

  function setTitle(title: string) {
    if (title !== document.title) setDocument({ ...document, title }, "title");
  }

  function reset() {
    setDocument(createExampleCircuit());
    setSelection(noSelection());
    setPendingEndpoint(null);
    setError(null);
  }

  function travel(type: "undo" | "redo") {
    if (type === "undo" ? history.past.length === 0 : history.future.length === 0) return;
    dispatch({ type });
    setSelection(noSelection());
    setPendingEndpoint(null);
    setError(null);
  }

  return {
    document,
    selection,
    pendingEndpoint,
    analysis,
    error,
    add,
    selectPart,
    selectWire,
    chooseTerminal,
    choosePoint,
    movePart,
    rotateSelected,
    removeSelected,
    updatePart,
    setTitle,
    reset,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undo: () => travel("undo"),
    redo: () => travel("redo"),
    endEdit,
    cancelMove: (id: string) => dispatch({ type: "cancel-group", group: `move:${id}` }),
    clearSelection: () => setSelection(noSelection()),
    cancelConnection: () => setPendingEndpoint(null),
  };
}

export type CircuitEditorController = ReturnType<typeof useCircuitEditor>;
