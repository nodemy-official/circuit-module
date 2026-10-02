import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../../circuit-model.js";
import { analyzeAnalogCircuit } from "../../analog-solver.js";

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

describe("ideal-source cycle component tolerance audit", () => {
  it.each([
    { phaseDegrees: 0, voltage: { real: 2, imaginary: 0 } },
    { phaseDegrees: 450, voltage: { real: 0, imaginary: 2 } },
    { phaseDegrees: -90, voltage: { real: 0, imaginary: -2 } },
    { phaseDegrees: 180, voltage: { real: -2, imaginary: 0 } },
    { phaseDegrees: -270, voltage: { real: 0, imaginary: 2 } },
  ])("keeps exact axis phasors after phase wrapping ($phaseDegrees°)", ({ phaseDegrees, voltage }) => {
    const document: CircuitDocument = {
      title: "交流電源の軸位相",
      parts: [
        part("source", "ac-source", { voltageVolts: 2, phaseDegrees, frequencyHz: 50 }),
        part("load", "resistor", { resistanceOhms: 10 }),
      ],
      wires: [
        wire("out", "source", "a", "load", "a"),
        wire("return", "load", "b", "source", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 50 });

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.source.voltage).toEqual(voltage);
  });

  it("preserves a negative phase too small to add to 360 degrees", () => {
    const document: CircuitDocument = {
      title: "微小な負の位相",
      parts: [
        part("source", "ac-source", { voltageVolts: 1e20, phaseDegrees: -1e-20, frequencyHz: 50 }),
        part("load", "resistor", { resistanceOhms: 1e20 }),
      ],
      wires: [
        wire("out", "source", "a", "load", "a"),
        wire("return", "load", "b", "source", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 50 });

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.source.voltage.real).toBe(1e20);
    expect(result.parts.source.voltage.imaginary).toBeCloseTo(-Math.PI / 180, 13);
  });

  it.each([
    { zeroBranch: "ammeter" as const, sourceFirst: true },
    { zeroBranch: "switch" as const, sourceFirst: true },
    { zeroBranch: "ammeter" as const, sourceFirst: false },
  ])("rejects an orthogonal millivolt mismatch through a zero-voltage $zeroBranch (sourceFirst=$sourceFirst)", ({ zeroBranch, sourceFirst }) => {
    const bridge = part("bridge", zeroBranch, zeroBranch === "switch" ? { initiallyClosed: true } : {});
    const largeSource = part("large", "ac-source", { voltageVolts: 1e16, frequencyHz: 50 });
    const phaseOffsetDegrees = (1e-3 / 1e16) * (180 / Math.PI);
    const offsetSource = part("offset", "ac-source", {
      voltageVolts: 1e16,
      phaseDegrees: phaseOffsetDegrees,
      frequencyHz: 50,
    });
    const document: CircuitDocument = {
      title: "巨大な実部と微小な直交虚部を持つ不整合ループ",
      parts: sourceFirst
        ? [largeSource, bridge, offsetSource]
        : [offsetSource, bridge, largeSource],
      wires: [
        wire("large-to-bridge", "large", "b", "bridge", "a"),
        wire("bridge-to-offset", "bridge", "b", "offset", "b"),
        wire("shared-positive", "large", "a", "offset", "a"),
      ],
    };

    const result = analyzeAnalogCircuit(document, {
      mode: "ac",
      frequencyHz: 50,
      switchStates: zeroBranch === "switch" ? { bridge: true } : {},
    });

    expect(result.status).toBe("invalid");
    expect(result.issues.some((issue) => issue.severity === "error")).toBe(true);
  });
});
