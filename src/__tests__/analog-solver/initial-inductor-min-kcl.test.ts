import { describe, expect, it } from "vitest";

import { solveAnalogStep } from "../../analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../../circuit-model.js";
import { analyzeAnalogCircuit } from "../../analog-solver.js";

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (
  id: string,
  fromPart: string,
  fromTerminal: CircuitTerminal,
  toPart: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: fromPart, terminal: fromTerminal },
  to: { partId: toPart, terminal: toTerminal },
});

describe("exact KCL validation for initial inductor currents", () => {
  it("rejects an isolated inductor carrying Number.MIN_VALUE", () => {
    const document: CircuitDocument = {
      title: "Isolated subnormal inductor current",
      parts: [part("coil", "inductor", { inductanceHenries: 1, initialCurrentAmps: Number.MIN_VALUE })],
      wires: [],
    };

    const result = solveAnalogStep(document, { mode: "dc", initialInductorCurrents: true });

    expect(result.status, result.message).toBe("invalid");
  });

  it("rejects a subnormal current source that conflicts with a zero-current inductor", () => {
    const document: CircuitDocument = {
      title: "Subnormal current source against zero inductor current",
      parts: [
        part("source", "current-source", { currentAmps: Number.MIN_VALUE }),
        part("coil", "inductor", { inductanceHenries: 1, initialCurrentAmps: 0 }),
      ],
      wires: [
        wire("parallel-a", "source", "a", "coil", "a"),
        wire("parallel-b", "source", "b", "coil", "b"),
      ],
    };

    const result = solveAnalogStep(document, { mode: "dc", initialInductorCurrents: true });

    expect(result.status, result.message).toBe("invalid");
  });

  it("accepts the same subnormal source when a resistor provides an exact return", () => {
    const document: CircuitDocument = {
      title: "Subnormal current through a resistor",
      parts: [
        part("source", "current-source", { currentAmps: Number.MIN_VALUE }),
        part("coil", "inductor", { inductanceHenries: 1, initialCurrentAmps: 0 }),
        part("return", "resistor", { resistanceOhms: 1 }),
      ],
      wires: [
        wire("parallel-a", "source", "a", "coil", "a"),
        wire("parallel-b", "source", "b", "coil", "b"),
        wire("return-a", "return", "a", "source", "a"),
        wire("return-b", "return", "b", "source", "b"),
      ],
    };

    const result = solveAnalogStep(document, { mode: "dc", initialInductorCurrents: true });

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.return!.current.real).toBe(-Number.MIN_VALUE);
  });

  it("reports a forward BJT base-slope group when the transport slope underflows", () => {
    const document: CircuitDocument = {
      title: "Subnormal BJT transport slope with finite base slope",
      parts: [
        part("ground", "ground"),
        part("base-bias", "ac-source", {
          voltageVolts: 1,
          offsetVolts: -1,
          frequencyHz: 1000,
        }),
        part("collector-bias", "battery", { voltageVolts: 1 }),
        part("bjt", "npn-transistor", {
          saturationCurrentAmps: Number.MIN_VALUE,
          currentGain: Number.MIN_VALUE,
        }),
      ],
      wires: [
        wire("base-drive", "base-bias", "a", "bjt", "b"),
        wire("base-reference", "base-bias", "b", "ground", "a"),
        wire("collector-drive", "collector-bias", "a", "bjt", "a"),
        wire("collector-reference", "collector-bias", "b", "ground", "a"),
        wire("emitter-reference", "bjt", "c", "ground", "a"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });

    expect(result.status, result.message).toBe("valid");
    const reading = result.parts.bjt!;
    expect(reading.acReferenceTerminalGroups).toEqual([["b", "c"]]);
    expect(reading.terminalCurrents.a!.real).toBe(0);
    expect(reading.terminalCurrents.b!.real).not.toBe(0);
  });
});
