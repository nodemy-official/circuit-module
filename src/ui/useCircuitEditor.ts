import { useCallback, useMemo, useRef, useState, type SetStateAction } from "react";
import { editorHistoryReducer, type EditorHistory, type HistoryAction } from "./editor-history.js";
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
import { snapshotSimulationArray, snapshotSimulationRecord, validatedSimulationDocument } from "../simulation-input.js";
import {
  createEmptyCircuit,
  createExampleCircuit,
  sameEndpoint,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitWire,
} from "../circuit-model.js";

const noSelection = (): CircuitSelection => ({ parts: [], wires: [] });

/** Interactive imports are bounded separately from the headless storage format. */
export const MAX_CIRCUIT_EDITOR_PARTS = 256;
export const MAX_CIRCUIT_EDITOR_WIRES = 1024;

function toggleId(ids: string[], id: string) {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

function editableWire(wire: CircuitWire): CircuitWire {
  if (wire.waypoints === undefined) { return wire; }
  const values = snapshotSimulationArray(wire.waypoints);
  if (!values) { return wire; }
  const waypoints: Point[] = [];
  for (const value of values) {
    const point = snapshotSimulationRecord(value, ["x", "y"]);
    if (!point || typeof point.x !== "number" || typeof point.y !== "number") { return wire; }
    waypoints.push({ ...point, x: point.x, y: point.y });
  }
  return { ...wire, waypoints };
}

function editableDocument(document: CircuitDocument) {
  // Preserve every own data field before edits use ordinary object spreads.
  // Keep malformed input intact so analysis can still report it as invalid.
  const copied = validatedSimulationDocument(document);
  if (typeof copied === "string") { return document; }
  // Simulation snapshots do not copy layout-only waypoints. Editor history
  // must retain its own route even when the caller later changes that input.
  return {
    ...copied,
    wires: copied.wires.map(editableWire),
  };
}

/** Commands can compose synchronously while React batches their rendered state. */
function useCommandState<T>(initial: T | (() => T)) {
  const [state, commit] = useState(initial);
  const current = useRef(state);
  const setState = useCallback((action: SetStateAction<T>) => {
    const next = typeof action === "function" ? (action as (previous: T) => T)(current.current) : action;
    current.current = next;
    commit(next);
  }, []);
  return [state, setState, current] as const;
}

function canCutSelection(document: CircuitDocument, selection: CircuitSelection) {
  const selectedPartIds = new Set(selection.parts);
  return selection.parts.length > 0 && document.wires.every((wire) =>
    !selection.wires.includes(wire.id) || (selectedPartIds.has(wire.from.partId) && selectedPartIds.has(wire.to.partId)),
  );
}

/** State and commands for the optional editor UI. The circuit functions remain usable on their own. */
export function useCircuitEditor(initialDocument?: CircuitDocument) {
  const [renderedHistory, setHistory, historyRef] = useCommandState<EditorHistory>(() => ({
    past: [], present: editableDocument(initialDocument ?? createExampleCircuit()), future: [],
  }));
  const renderedDocument = renderedHistory.present;
  const [documentVersion, setDocumentVersion, documentVersionRef] = useCommandState(0);
  const globalDocumentVersionRef = useRef(0);
  const cancelledGroupVersionsRef = useRef(new Map<string, number>());
  const [renderedSelection, setSelection, selectionRef] = useCommandState<CircuitSelection>(noSelection);
  const [renderedPendingEndpoint, setPendingEndpoint, pendingEndpointRef] = useCommandState<CircuitEndpoint | null>(null);
  const [renderedPendingWire, setPendingWire, pendingWireRef] = useCommandState<{ wireId: string; end: CircuitWireEnd } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clipboard, setClipboard, clipboardRef] = useCommandState<CircuitFragment | null>(null);
  const [analysisOptions, setAnalysisOptions] = useState<CircuitAnalysisOptions>({ mode: "auto" });
  const analysis = useMemo(() => analyzeCircuit(renderedDocument, {}, analysisOptions), [renderedDocument, analysisOptions]);
  const diagnostics = useMemo(() => inspectCircuit(renderedDocument), [renderedDocument]);
  const canCut = canCutSelection(renderedDocument, renderedSelection);

  function invalidateDocument() {
    globalDocumentVersionRef.current += 1;
    setDocumentVersion((version) => version + 1);
  }

  function invalidateGestureGroup(group: string, documentChanged = false) {
    const versions = cancelledGroupVersionsRef.current;
    versions.set(group, (versions.get(group) ?? 0) + 1);
    if (documentChanged) { globalDocumentVersionRef.current += 1; }
    // Number-based hosts observe every cancellation after rendering; group-aware
    // getters also detect their own cancellation before that render commits.
    setDocumentVersion((version) => version + 1);
  }

  function dispatch(action: HistoryAction) {
    const previousDocument = historyRef.current.present;
    setHistory((current) => editorHistoryReducer(current, action));
    // A pressed pointer may not have produced its first accepted edit yet.
    // Cancel its pending events even when there is no history group to restore.
    if (action.type === "cancel-group") {
      invalidateGestureGroup(action.group, historyRef.current.present !== previousDocument);
    }
  }

  function setDocument(next: CircuitDocument, group?: string) {
    if (next !== historyRef.current.present && !group?.startsWith("move:") && !group?.startsWith("wire-route:")) {
      invalidateDocument();
    }
    dispatch({ type: "edit", document: next, group });
  }

  function applyEditResult(result: EditResult, group?: string) {
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setDocument(result.document, group);
    setError(null);
  }

  function endEdit() {
    // A pointer may be pressed before its first edit creates an undo group.
    // End that gesture too, including queued moves before React commits.
    invalidateDocument();
    dispatch({ type: "end-group" });
  }

  function clearSelection() {
    endEdit();
    setSelection(noSelection());
  }

  function cancelConnection() {
    invalidateGestureGroup("connection");
    setPendingEndpoint(null);
    setPendingWire(null);
    setError(null);
  }

  function add(kind: CircuitPartKind, near: Point = { x: 25, y: 10 }) {
    const document = historyRef.current.present;
    const spot = findFreeSpot(document, kind, near);
    const result = addPart(document, kind, spot);
    if (!result.ok) { return setError(result.reason); }
    setDocument(result.document);
    setSelection({ parts: [result.id], wires: [] });
    cancelConnection();
  }

  function selectPart(id: string, additive = false) {
    const document = historyRef.current.present;
    if (!document.parts.some((part) => part.id === id)) { return; }
    endEdit();
    setSelection((current) => additive ? { ...current, parts: toggleId(current.parts, id) } : { parts: [id], wires: [] });
    setError(null);
  }

  function selectWire(id: string, additive = false) {
    const document = historyRef.current.present;
    if (!document.wires.some((wire) => wire.id === id)) { return; }
    endEdit();
    setSelection((current) => additive ? { ...current, wires: toggleId(current.wires, id) } : { parts: [], wires: [id] });
    setError(null);
  }

  function selectRange(next: CircuitSelection, additive = false) {
    const document = historyRef.current.present;
    endEdit();
    setSelection((current) => ({
      parts: [...new Set([...(additive ? current.parts : []), ...next.parts])]
        .filter((id) => document.parts.some((part) => part.id === id)),
      wires: [...new Set([...(additive ? current.wires : []), ...next.wires])]
        .filter((id) => document.wires.some((wire) => wire.id === id)),
    }));
    cancelConnection();
  }

  function selectAll() {
    const document = historyRef.current.present;
    selectRange({ parts: document.parts.map((part) => part.id), wires: document.wires.map((wire) => wire.id) });
  }

  function copySelected() {
    const document = historyRef.current.present;
    const selection = selectionRef.current;
    const fragment = copyFragment(document, selection);
    if (fragment.parts.length === 0) { return false; }
    endEdit();
    setClipboard(fragment);
    setError(null);
    return true;
  }

  function cutSelected() {
    const selection = selectionRef.current;
    if (!canCutSelection(historyRef.current.present, selection)) {
      if (selection.wires.length > 0) { setError("導線を切り取るには、両端の部品も選択してください。"); }
      return;
    }
    if (copySelected()) { removeSelected(); }
  }

  function insertFragment(fragment: CircuitFragment | null) {
    if (!fragment) { return; }
    const document = historyRef.current.present;
    const result = pasteFragment(document, fragment);
    if (!result.ok) { setError(result.reason); return; }
    setDocument(result.document);
    setSelection(result.selection);
    cancelConnection();
  }

  function startConnection(endpoint: CircuitEndpoint) {
    const document = historyRef.current.present;
    const pendingEndpoint = { partId: endpoint.partId, terminal: endpoint.terminal };
    endEdit();
    setPendingWire(null);
    // A junction's terminal covers its body, so also select it for editing or deletion.
    const part = document.parts.find((item) => item.id === pendingEndpoint.partId);
    if (part?.kind === "junction") { selectPart(part.id); }
    else { setSelection(noSelection()); }
    setPendingEndpoint(pendingEndpoint);
    setError(null);
  }

  function startReconnect(wireId: string, end: CircuitWireEnd) {
    const document = historyRef.current.present;
    const wire = document.wires.find((item) => item.id === wireId);
    if (!wire) { return; }
    selectWire(wireId);
    setPendingWire({ wireId, end });
    const endpoint = end === "from" ? wire.to : wire.from;
    setPendingEndpoint({ partId: endpoint.partId, terminal: endpoint.terminal });
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
    const document = historyRef.current.present;
    const pendingEndpoint = pendingEndpointRef.current;
    const pendingWire = pendingWireRef.current;
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
    const document = historyRef.current.present;
    const pendingEndpoint = pendingEndpointRef.current;
    const pendingWire = pendingWireRef.current;
    if (!pendingEndpoint) {
      clearSelection();
      return;
    }
    finishConnection(pendingWire
      ? reconnectWireToPoint(document, pendingWire.wireId, pendingWire.end, point)
      : connectToPoint(document, pendingEndpoint, point));
  }

  function movePart(id: string, dx: number, dy: number) {
    if (!dx && !dy) { return; }
    const document = historyRef.current.present;
    const selection = selectionRef.current;
    const moving = selection.parts.includes(id) ? selection.parts : [id];
    const result = moveParts(document, moving, dx, dy);
    applyEditResult(result, `move:${id}`);
  }

  function updateWireRoute(id: string, waypoints?: readonly Point[]) {
    const document = historyRef.current.present;
    const result = setWireWaypoints(document, id, waypoints);
    applyEditResult(result, `wire-route:${id}`);
  }

  function cancelWireRoute(id: string) {
    dispatch({ type: "cancel-group", group: `wire-route:${id}` });
    setError(null);
  }

  function cancelMove(id: string) {
    dispatch({ type: "cancel-group", group: `move:${id}` });
    setError(null);
  }

  function resetWireRoute(id: string) {
    const document = historyRef.current.present;
    const wire = document.wires.find((item) => item.id === id);
    if (!wire || wire.waypoints === undefined) { return; }
    endEdit();
    const result = setWireWaypoints(document, id, undefined);
    applyEditResult(result);
  }

  function rotateSelected() {
    const document = historyRef.current.present;
    const selection = selectionRef.current;
    if (selection.parts.length === 0) { return; }
    const result = rotateParts(document, selection.parts);
    applyEditResult(result);
  }

  function removeSelected() {
    const document = historyRef.current.present;
    const selection = selectionRef.current;
    if (selection.parts.length === 0 && selection.wires.length === 0) { return; }
    setDocument(removeSelection(document, selection));
    setSelection(noSelection());
    cancelConnection();
  }

  function updatePart(id: string, patch: Partial<Omit<CircuitPart, "id" | "kind">>) {
    const document = historyRef.current.present;
    const part = document.parts.find((item) => item.id === id);
    if (!part) { return; }
    const nextPart = { ...part, ...patch };
    // JavaScript callers and full-object patches can still include these fields. Changing
    // either would invalidate existing wire endpoints and the editor's active references.
    if (nextPart.id !== part.id || nextPart.kind !== part.kind) {
      setError("部品の ID と種類は変更できません。");
      return;
    }
    if (Object.entries(patch).every(([key, value]) => part[key as keyof CircuitPart] === value)) { return; }
    setDocument({
      ...document,
      parts: document.parts.map((existingPart) => existingPart.id === id ? nextPart : existingPart),
    }, "initiallyClosed" in patch ? undefined : `property:${id}:${Object.keys(patch).sort().join(",")}`);
    setError(null);
  }

  function setTitle(title: string) {
    const document = historyRef.current.present;
    if (title !== document.title) { setDocument({ ...document, title }, "title"); }
  }

  function reset() {
    replaceDocument(createExampleCircuit());
  }

  function replaceDocument(next: CircuitDocument) {
    setDocument(editableDocument(next));
    setSelection(noSelection());
    cancelConnection();
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
    const history = historyRef.current;
    const next = editorHistoryReducer(history, { type });
    if (next === history) { return; }
    cancelConnection();
    invalidateDocument();
    setHistory(next);
    setSelection(noSelection());
  }

  return {
    document: renderedDocument,
    documentVersion,
    getDocumentVersion: (group?: string) => group === undefined
      ? documentVersionRef.current
      : globalDocumentVersionRef.current + (cancelledGroupVersionsRef.current.get(group) ?? 0),
    selection: renderedSelection,
    pendingEndpoint: renderedPendingEndpoint,
    pendingWire: renderedPendingWire,
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
    canCopy: renderedSelection.parts.length > 0,
    canCut,
    canPaste: clipboard !== null && clipboard.parts.length > 0,
    copySelected,
    cutSelected,
    paste: () => insertFragment(clipboardRef.current),
    duplicateSelected: () => insertFragment(copyFragment(historyRef.current.present, selectionRef.current)),
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
    exportDocument: () => serializeCircuitDocument(historyRef.current.present),
    canUndo: renderedHistory.past.length > 0,
    canRedo: renderedHistory.future.length > 0,
    undo: () => travel("undo"),
    redo: () => travel("redo"),
    endEdit,
    cancelMove,
    clearSelection,
    cancelConnection,
  };
}

export type CircuitEditorController = ReturnType<typeof useCircuitEditor>;
