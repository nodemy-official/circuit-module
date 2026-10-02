import { describe, expect, it } from "vitest";

import { addPart, copyFragment, pasteFragment } from "../../circuit-edit.js";
import { createEmptyCircuit, type CircuitDocument, type CircuitPartKind } from "../../circuit-model.js";
import { parseCircuitDocument, serializeCircuitDocument } from "../../circuit-serialization.js";
import { analyzeCircuit, type CircuitAnalysis } from "../../circuit-solver.js";

function wire(id: string, fromPart: string, fromTerminal: "a" | "b", toPart: string, toTerminal: "a" | "b") {
  return {
    id,
    from: { partId: fromPart, terminal: fromTerminal },
    to: { partId: toPart, terminal: toTerminal },
  };
}

function loop(title: string, sourceKind: "battery" | "ac-source", switchClosed?: boolean): CircuitDocument {
  const sourceId = "source";
  const resistorId = "resistor";
  const switchId = "switch";
  const source = { id: sourceId, kind: sourceKind, x: 2, y: 5, label: "source" } as const;
  const resistor = { id: resistorId, kind: "resistor" as const, x: 12, y: 5, label: "load" };
  const switchPart = {
    id: switchId,
    kind: "switch" as const,
    x: 22,
    y: 5,
    label: "switch",
    ...(switchClosed === undefined ? {} : { initiallyClosed: switchClosed }),
  };
  return {
    title,
    parts: [source, resistor, switchPart],
    wires: [
      wire("wire-1", sourceId, "a", resistorId, "a"),
      wire("wire-2", resistorId, "b", switchId, "a"),
      wire("wire-3", switchId, "b", sourceId, "b"),
    ],
  } as CircuitDocument;
}

function addPartLoop(sourceKind: CircuitPartKind): CircuitDocument {
  let document = createEmptyCircuit("created loop");
  const added: { kind: CircuitPartKind; id: string }[] = [];
  for (const [index, kind] of [sourceKind, "resistor", "switch"].entries()) {
    const result = addPart(document, kind as CircuitPartKind, { x: 2 + index * 10, y: 5 });
    if (!result.ok) { throw new Error(result.reason); }
    document = result.document;
    added.push({ kind: kind as CircuitPartKind, id: result.id });
  }
  const source = added.find((part) => part.kind === sourceKind);
  const resistor = added.find((part) => part.kind === "resistor");
  const switchPart = added.find((part) => part.kind === "switch");
  if (!source || !resistor || !switchPart) { throw new Error("Missing loop component"); }
  return {
    ...document,
    wires: [
      wire("wire-1", source.id, "a", resistor.id, "a"),
      wire("wire-2", resistor.id, "b", switchPart.id, "a"),
      wire("wire-3", switchPart.id, "b", source.id, "b"),
    ],
  };
}

function snapshot(document: CircuitDocument, mode: "dc" | "ac") {
  const analysis = analyzeCircuit(document, {}, { mode });
  return snapshotAnalysis(document, analysis);
}

function snapshotAnalysis(document: CircuitDocument, analysis: CircuitAnalysis) {
  return {
    status: analysis.status,
    mode: analysis.mode,
    frequencyHz: analysis.frequencyHz,
    parts: document.parts.map((part) => {
      const reading = analysis.parts[part.id];
      return {
        kind: part.kind,
        voltageVolts: reading?.voltageVolts,
        currentAmps: reading?.currentAmps,
        voltagePhaseDegrees: reading?.voltagePhaseDegrees,
        currentPhaseDegrees: reading?.currentPhaseDegrees,
        switchClosed: reading?.switchClosed,
      };
    }).sort((first, second) => first.kind.localeCompare(second.kind)),
  };
}

function roundTrip(document: CircuitDocument) {
  const parsed = parseCircuitDocument(serializeCircuitDocument(document));
  if (!parsed.ok) { throw new Error(parsed.reason); }
  return parsed.document;
}

function pastedCopy(document: CircuitDocument) {
  const fragment = copyFragment(document, { parts: document.parts.map((part) => part.id), wires: [] });
  const pasted = pasteFragment(createEmptyCircuit("paste target"), fragment);
  if (!pasted.ok) { throw new Error(pasted.reason); }
  return pasted.document;
}

describe("document lifecycle preserves DC and AC analysis", () => {
  it("keeps omitted DC defaults consistent with created, serialized, and pasted parts", () => {
    const omitted = loop("omitted DC defaults", "battery");
    const created = addPartLoop("battery");
    const expected = snapshot(omitted, "dc");

    expect(expected.status).toBe("closed");
    expect(expected.mode).toBeUndefined();
    expect(expected.parts.find((part) => part.kind === "battery")?.voltageVolts).toBeCloseTo(9);
    expect(expected.parts.find((part) => part.kind === "resistor")?.voltageVolts).toBeCloseTo(9);
    expect(expected.parts.find((part) => part.kind === "resistor")?.currentAmps).toBeCloseTo(0.9);
    expect(expected.parts.find((part) => part.kind === "switch")?.switchClosed).toBe(true);

    expect(snapshot(created, "dc")).toEqual(expected);
    expect(snapshot(roundTrip(omitted), "dc")).toEqual(expected);
    expect(snapshot(pastedCopy(omitted), "dc")).toEqual(expected);
  });

  it("keeps omitted AC defaults and custom source phase/frequency across every document path", () => {
    const omitted = loop("omitted AC defaults", "ac-source");
    const created = addPartLoop("ac-source");
    const expectedDefaults = snapshot(omitted, "ac");

    expect(expectedDefaults).toMatchObject({ status: "closed", mode: "ac", frequencyHz: 1000 });
    expect(expectedDefaults.parts.find((part) => part.kind === "ac-source")?.voltageVolts).toBeCloseTo(5);
    expect(expectedDefaults.parts.find((part) => part.kind === "resistor")?.currentAmps).toBeCloseTo(0.5);
    expect(expectedDefaults.parts.find((part) => part.kind === "switch")?.switchClosed).toBe(true);
    expect(snapshot(created, "ac")).toEqual(expectedDefaults);
    expect(snapshot(roundTrip(omitted), "ac")).toEqual(expectedDefaults);
    expect(snapshot(pastedCopy(omitted), "ac")).toEqual(expectedDefaults);

    const custom = loop("custom AC source", "ac-source", false);
    const customSource = custom.parts.find((part) => part.kind === "ac-source");
    if (!customSource) { throw new Error("Missing AC source"); }
    customSource.voltageVolts = 8;
    customSource.frequencyHz = 60;
    customSource.phaseDegrees = 37;
    const expectedCustom = snapshot(custom, "ac");
    expect(expectedCustom).toMatchObject({ mode: "ac", frequencyHz: 60 });
    expect(expectedCustom.parts.find((part) => part.kind === "ac-source")?.voltagePhaseDegrees).toBeCloseTo(37);
    expect(expectedCustom.parts.find((part) => part.kind === "switch")?.switchClosed).toBe(false);
    expect(snapshot(roundTrip(custom), "ac")).toEqual(expectedCustom);
    expect(snapshot(pastedCopy(custom), "ac")).toEqual(expectedCustom);
  });
});
