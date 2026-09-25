import { useMemo, useReducer, useState } from "react";
import { editorHistoryReducer, type EditorHistory } from "./editor-history.js";
import {
  addPart,
  connect,
  connectToPoint,
  copyFragment,
  findFreeSpot,
  moveParts,
  pasteFragment,
  removeSelection,
  reconnectWire,
  reconnectWireToPoint,
  rotateParts,
  setWireWaypoints,
  type CircuitFragment,
  type CircuitSelection,
  type CircuitWireEnd,
  type EditResult,
} from "../circuit-edit.js";
import type { Point } from "../circuit-geometry.js";
import { createCircuitExample, type CircuitExampleKind } from "../circuit-examples.js";
import { analyzeCircuit, type CircuitAnalysisOptions } from "../circuit-solver.js";
import { inspectCircuit } from "../circuit-diagnostics.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../circuit-serialization.js";
import {
  createEmptyCircuit,
  createExampleCircuit,
  sameEndpoint,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitPartKind,
} from "../circuit-model.js";

const noSelection = (): CircuitSelection => ({ parts: [], wires: [] });

/** Interactive imports are bounded separately from the headless storage format. */
export const MAX_CIRCUIT_EDITOR_PARTS = 256;
export const MAX_CIRCUIT_EDITOR_WIRES = 1024;

function toggleId(ids: string[], id: string) {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

/** State and commands for the optional editor UI. The circuit functions remain usable on their own. */
export function useCircuitEditor(initialDocument?: CircuitDocument) {
  const [history, dispatch] = useReducer(editorHistoryReducer, initialDocument, (initial): EditorHistory => ({
    past: [], present: initial ?? createExampleCircuit(), future: [],
  }));
  const document = history.present;
  const [selection, setSelection] = useState<CircuitSelection>(noSelection);
  const [pendingEndpoint, setPendingEndpoint] = useState<CircuitEndpoint | null>(null);
  const [pendingWire, setPendingWire] = useState<{ wireId: string; end: CircuitWireEnd } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<CircuitFragment | null>(null);
  const [analysisOptions, setAnalysisOptions] = useState<CircuitAnalysisOptions>({ mode: "auto" });
  const analysis = useMemo(() => analyzeCircuit(document, {}, analysisOptions), [document, analysisOptions]);
  const diagnostics = useMemo(() => inspectCircuit(document), [document]);
  const selectedPartIds = new Set(selection.parts);
  const canCut = selection.parts.length > 0 && document.wires.every((wire) =>
    !selection.wires.includes(wire.id) || (selectedPartIds.has(wire.from.partId) && selectedPartIds.has(wire.to.partId)),
  );

  function setDocument(next: CircuitDocument, group?: string) {
    dispatch({ type: "edit", document: next, group });
  }

  function endEdit() {
    dispatch({ type: "end-group" });
  }

  function cancelConnection() {
    setPendingEndpoint(null);
    setPendingWire(null);
    setError(null);
  }

  function add(kind: CircuitPartKind, near: Point = { x: 25, y: 10 }) {
    const spot = findFreeSpot(document, kind, near);
    const result = addPart(document, kind, spot);
    if (!result.ok) { return setError(result.reason); }
    setDocument(result.document);
    setSelection({ parts: [result.id], wires: [] });
    cancelConnection();
    setError(null);
  }

  function selectPart(id: string, additive = false) {
    if (!document.parts.some((part) => part.id === id)) { return; }
    endEdit();
    setSelection((current) => additive ? { ...current, parts: toggleId(current.parts, id) } : { parts: [id], wires: [] });
    setError(null);
  }

  function selectWire(id: string, additive = false) {
    if (!document.wires.some((wire) => wire.id === id)) { return; }
    endEdit();
    setSelection((current) => additive ? { ...current, wires: toggleId(current.wires, id) } : { parts: [], wires: [id] });
    setError(null);
  }

  function selectRange(next: CircuitSelection, additive = false) {
    endEdit();
    setSelection((current) => ({
      parts: [...new Set([...(additive ? current.parts : []), ...next.parts])]
        .filter((id) => document.parts.some((part) => part.id === id)),
      wires: [...new Set([...(additive ? current.wires : []), ...next.wires])]
        .filter((id) => document.wires.some((wire) => wire.id === id)),
    }));
    cancelConnection();
    setError(null);
  }

  function selectAll() {
    selectRange({ parts: document.parts.map((part) => part.id), wires: document.wires.map((wire) => wire.id) });
  }

  function copySelected() {
    const fragment = copyFragment(document, selection);
    if (fragment.parts.length === 0) { return false; }
    endEdit();
    setClipboard(fragment);
    setError(null);
    return true;
  }

  function cutSelected() {
    if (!canCut) {
      if (selection.wires.length > 0) { setError("導線を切り取るには、両端の部品も選択してください。"); }
      return;
    }
    if (copySelected()) { removeSelected(); }
  }

  function insertFragment(fragment: CircuitFragment | null) {
    if (!fragment) { return; }
    const result = pasteFragment(document, fragment);
    if (!result.ok) { setError(result.reason); return; }
    setDocument(result.document);
    setSelection(result.selection);
    cancelConnection();
    setError(null);
  }

  function startConnection(endpoint: CircuitEndpoint) {
    endEdit();
    setPendingWire(null);
    // A junction's terminal covers its body, so also select it for editing or deletion.
    const part = document.parts.find((item) => item.id === endpoint.partId);
    if (part?.kind === "junction") { selectPart(part.id); }
    else { setSelection(noSelection()); }
    setPendingEndpoint(endpoint);
    setError(null);
  }

  function startReconnect(wireId: string, end: CircuitWireEnd) {
    const wire = document.wires.find((item) => item.id === wireId);
    if (!wire) { return; }
    selectWire(wireId);
    setPendingWire({ wireId, end });
    setPendingEndpoint(end === "from" ? wire.to : wire.from);
  }

  function finishConnection(result: EditResult<{ id: string }>) {
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setDocument(result.document);
    setSelection({ parts: [], wires: [result.id] });
    cancelConnection();
  }

  function chooseTerminal(endpoint: CircuitEndpoint) {
    if (!pendingEndpoint) {
      startConnection(endpoint);
      return;
    }
    if (pendingWire) {
      finishConnection(reconnectWire(document, pendingWire.wireId, pendingWire.end, endpoint));
      return;
    }
    if (sameEndpoint(pendingEndpoint, endpoint)) {
      cancelConnection();
      return;
    }
    finishConnection(connect(document, pendingEndpoint, endpoint));
  }

  function choosePoint(point: Point) {
    if (!pendingEndpoint) {
      setSelection(noSelection());
      return;
    }
    finishConnection(pendingWire
      ? reconnectWireToPoint(document, pendingWire.wireId, pendingWire.end, point)
      : connectToPoint(document, pendingEndpoint, point));
  }

  function movePart(id: string, dx: number, dy: number) {
    if (!dx && !dy) { return; }
    const moving = selection.parts.includes(id) ? selection.parts : [id];
    const result = moveParts(document, moving, dx, dy);
    if (result.ok) {
      setDocument(result.document, `move:${id}`);
      setError(null);
    } else { setError(result.reason); }
  }

  function updateWireRoute(id: string, waypoints?: readonly Point[]) {
    const result = setWireWaypoints(document, id, waypoints);
    if (!result.ok) { setError(result.reason); return; }
    setDocument(result.document, `wire-route:${id}`);
    setError(null);
  }

  function cancelWireRoute(id: string) {
    dispatch({ type: "cancel-group", group: `wire-route:${id}` });
    setError(null);
  }

  function resetWireRoute(id: string) {
    const wire = document.wires.find((item) => item.id === id);
    if (!wire || wire.waypoints === undefined) { return; }
    endEdit();
    const result = setWireWaypoints(document, id, undefined);
    if (!result.ok) { setError(result.reason); return; }
    setDocument(result.document);
    setError(null);
  }

  function rotateSelected() {
    if (selection.parts.length === 0) { return; }
    const result = rotateParts(document, selection.parts);
    if (result.ok) {
      setDocument(result.document);
      setError(null);
    } else { setError(result.reason); }
  }

  function removeSelected() {
    if (selection.parts.length === 0 && selection.wires.length === 0) { return; }
    setDocument(removeSelection(document, selection));
    setSelection(noSelection());
    cancelConnection();
    setError(null);
  }

  function updatePart(id: string, patch: Partial<CircuitPart>) {
    const part = document.parts.find((item) => item.id === id);
    if (!part || Object.entries(patch).every(([key, value]) => part[key as keyof CircuitPart] === value)) { return; }
    setDocument({
      ...document,
      parts: document.parts.map((existingPart) => existingPart.id === id ? { ...existingPart, ...patch } : existingPart),
    }, "initiallyClosed" in patch ? undefined : `property:${id}:${Object.keys(patch).sort().join(",")}`);
    setError(null);
  }

  function setTitle(title: string) {
    if (title !== document.title) { setDocument({ ...document, title }, "title"); }
  }

  function reset() {
    replaceDocument(createExampleCircuit());
  }

  function replaceDocument(next: CircuitDocument) {
    setDocument(next);
    setSelection(noSelection());
    cancelConnection();
    setError(null);
  }

  function importDocument(json: string) {
    const result = parseCircuitDocument(json);
    if (!result.ok) { setError(result.reason); return false; }
    if (result.document.parts.length > MAX_CIRCUIT_EDITOR_PARTS || result.document.wires.length > MAX_CIRCUIT_EDITOR_WIRES) {
      setError(`エディターで読み込める回路は部品${MAX_CIRCUIT_EDITOR_PARTS}個・導線${MAX_CIRCUIT_EDITOR_WIRES}本までです。`);
      return false;
    }
    replaceDocument(result.document);
    return true;
  }

  function travel(type: "undo" | "redo") {
    cancelConnection();
    if (type === "undo" ? history.past.length === 0 : history.future.length === 0) { return; }
    dispatch({ type });
    setSelection(noSelection());
  }

  return {
    document,
    selection,
    pendingEndpoint,
    pendingWire,
    analysis,
    analysisOptions,
    setAnalysisOptions,
    diagnostics,
    error,
    add,
    selectPart,
    selectWire,
    selectRange,
    selectAll,
    canCopy: selection.parts.length > 0,
    canCut,
    canPaste: clipboard !== null && clipboard.parts.length > 0,
    copySelected,
    cutSelected,
    paste: () => insertFragment(clipboard),
    duplicateSelected: () => insertFragment(copyFragment(document, selection)),
    startConnection,
    startReconnect,
    chooseTerminal,
    choosePoint,
    movePart,
    updateWireRoute,
    cancelWireRoute,
    resetWireRoute,
    rotateSelected,
    removeSelected,
    updatePart,
    setTitle,
    reset,
    openExample: (kind: CircuitExampleKind) => {
      replaceDocument(createCircuitExample(kind));
      setAnalysisOptions({ mode: "auto" });
    },
    newDocument: () => replaceDocument(createEmptyCircuit()),
    importDocument,
    exportDocument: () => serializeCircuitDocument(document),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undo: () => travel("undo"),
    redo: () => travel("redo"),
    endEdit,
    cancelMove: (id: string) => dispatch({ type: "cancel-group", group: `move:${id}` }),
    clearSelection: () => setSelection(noSelection()),
    cancelConnection,
  };
}

export type CircuitEditorController = ReturnType<typeof useCircuitEditor>;
