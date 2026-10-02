import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";

const part = (id: string, kind: CircuitPartKind, extra: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...extra,
});

const wire = (
  id: string,
  from: string,
  fromTerminal: CircuitTerminal,
  to: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

const normalizeDegrees = (degrees: number) => ((degrees + 180) % 360 + 360) % 360 - 180;

describe("AC adapter subnormal readings", () => {
  it.each([
    { sourcePhase: 45, currentPhase: 45 },
    { sourcePhase: 135, currentPhase: 135 },
    { sourcePhase: 225, currentPhase: -135 },
    { sourcePhase: 315, currentPhase: -45 },
  ])("preserves magnitude and phase for $sourcePhase° AC through a 2 Ω load", ({ sourcePhase, currentPhase }) => {
    const document: CircuitDocument = {
      title: "Subnormal AC reading",
      parts: [
        part("source", "ac-source", {
          voltageVolts: Number.MIN_VALUE,
          frequencyHz: 50,
          phaseDegrees: sourcePhase,
        }),
        part("load", "resistor", { resistanceOhms: 2 }),
      ],
      wires: [
        wire("source-to-load", "source", "a", "load", "a"),
        wire("load-to-source", "load", "b", "source", "b"),
      ],
    };

    const result = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 50 });

    expect(result.status, result.message).toBe("closed");
    expect(result.parts.source.voltageVolts).toBe(Number.MIN_VALUE);
    expect(result.parts.source.voltagePhaseDegrees).toBe(currentPhase);
    expect(result.parts.load.voltageVolts).toBe(Number.MIN_VALUE);
    expect(result.parts.load.voltagePhaseDegrees).toBe(currentPhase);
    // Independent Ohm's law: MIN_VALUE / 2 is exactly the midpoint
    // between 0 and MIN_VALUE, which rounds to even (0).
    expect(result.parts.load.currentAmps).toBe(0);
    expect(result.parts.load.currentPhaseDegrees).toBe(currentPhase);

    expect(result.parts.load.terminalVoltages).toEqual({ a: 0, b: Number.MIN_VALUE });
    expect(result.parts.load.terminalVoltagePhasesDegrees).toEqual({
      a: 0,
      b: normalizeDegrees(currentPhase - 180),
    });
    expect(result.parts.load.terminalCurrents).toEqual({
      a: 0,
      b: 0,
    });
    expect(result.parts.load.terminalCurrentPhasesDegrees).toEqual({
      a: currentPhase,
      b: normalizeDegrees(currentPhase - 180),
    });
  });
});
