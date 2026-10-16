import { useMemo, useRef } from "react";
import type { CircuitSelection } from "../circuit-edit.js";
import { routeDocumentWires } from "../circuit-geometry.js";
import { circuitPartNumericFields, type CircuitDocument } from "../circuit-model.js";
import type { CircuitAnalysis } from "../circuit-solver.js";

/** Retain immutable comparison evidence even when a host mutates its arrays. */
function useContentSnapshot<T>(values: readonly T[]): readonly T[] {
  const previous = useRef<readonly T[]>([]);
  if (values.length !== previous.current.length || values.some((value, index) => !Object.is(value, previous.current[index]))) {
    previous.current = [...values];
  }
  return previous.current;
}

function readingValues(document: CircuitDocument, analysis?: CircuitAnalysis) {
  return [
    analysis?.status,
    ...document.parts.flatMap((part) => {
      const reading = analysis?.parts[part.id];
      return [reading?.brightness, reading?.switchClosed, reading?.meterStatus,
        reading?.voltageVolts, reading?.currentAmps, reading?.voltagePhaseDegrees, reading?.currentPhaseDegrees];
    }),
    ...document.wires.map((wire) => analysis?.wireCurrents[wire.id]),
  ];
}

/** Cheap content comparisons keep routing and SVG caches valid across host edits and camera frames. */
export function useCircuitBoardInputs(document: CircuitDocument, selection: CircuitSelection | undefined, readOnly: boolean, analysis?: CircuitAnalysis) {
  const partIds = useContentSnapshot(readOnly ? [] : selection?.parts ?? []);
  const wireIds = useContentSnapshot(readOnly ? [] : selection?.wires ?? []);
  const parts = useContentSnapshot(document.parts.flatMap((part) => [
    part, part.id, part.kind, part.label, part.x, part.y, part.rotation, part.initiallyClosed,
    ...circuitPartNumericFields(part.kind).map(({ key }) => part[key]),
  ]));
  const geometry = useContentSnapshot(document.parts.flatMap((part) => [part.id, part.kind, part.x, part.y, part.rotation]));
  const connections = useContentSnapshot(document.wires.flatMap((wire) => [
    wire.id, wire.from.partId, wire.from.terminal, wire.to.partId, wire.to.terminal,
  ]));
  const waypoints = useContentSnapshot(document.wires.flatMap((wire) => [
    wire.waypoints?.length ?? 0, ...wire.waypoints?.flatMap((point) => [point.x, point.y]) ?? [],
  ]));
  const visualReadings = useContentSnapshot(readingValues(document, analysis));
  const selectedParts = useMemo(() => new Set(partIds), [partIds]);
  const selectedWires = useMemo(() => new Set(wireIds), [wireIds]);
  const connectedTerminals = useMemo(() => new Set(document.wires.flatMap((wire) => [
    `${wire.from.partId}:${wire.from.terminal}`, `${wire.to.partId}:${wire.to.terminal}`,
  ])), [connections]);
  const partsById = useMemo(() => new Map(document.parts.map((part) => [part.id, part])), [parts]);
  const wireRoutes = useMemo(() => routeDocumentWires(document), [geometry, connections, waypoints]);
  return { selectedParts, selectedWires, connectedTerminals, partsById, wireRoutes, visualReadings };
}
