import { expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { circuitNodes, circuitPotential } from "../../circuit-visualization.js";

it.each([1, 26, 45])("preserves local RMS midpoint differences on a nonzero common mode at %s degrees", (phaseDegrees) => {
  for (const units of [3, 7]) {
    for (const basePhase of [0, 26]) {
      const document: CircuitDocument = {
        title: "Local RMS common-mode cancellation",
        parts: [
          { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
          { id: "base", kind: "ac-source", label: "Base", x: 0, y: 0, voltageVolts: 1, frequencyHz: 50, phaseDegrees: basePhase },
          { id: "load", kind: "resistor", label: "Load", x: 0, y: 0, resistanceOhms: 1 },
          { id: "v", kind: "ac-source", label: "V", x: 0, y: 0, voltageVolts: units * Number.MIN_VALUE, frequencyHz: 50, phaseDegrees },
          ...["r1", "r2"].map((id) => ({ id, kind: "resistor" as const, label: id, x: 0, y: 0, resistanceOhms: 1 })),
          { id: "sw", kind: "switch", label: "Open", x: 0, y: 0, initiallyClosed: false },
          { id: "vm", kind: "voltmeter", label: "VM", x: 0, y: 0 },
          ...["nmos", "pmos"].map((kind) => ({ id: kind, kind: kind as "nmos" | "pmos", label: kind, x: 0, y: 0, thresholdVolts: 2 })),
        ], wires: [
          { id: "bg", from: { partId: "base", terminal: "b" }, to: { partId: "g", terminal: "a" } },
          { id: "bl", from: { partId: "base", terminal: "a" }, to: { partId: "load", terminal: "a" } },
          { id: "lg", from: { partId: "load", terminal: "b" }, to: { partId: "g", terminal: "a" } },
          { id: "vb", from: { partId: "v", terminal: "b" }, to: { partId: "base", terminal: "a" } },
          { id: "v1", from: { partId: "v", terminal: "a" }, to: { partId: "r1", terminal: "a" } },
          { id: "12", from: { partId: "r1", terminal: "b" }, to: { partId: "r2", terminal: "a" } },
          { id: "2v", from: { partId: "r2", terminal: "b" }, to: { partId: "v", terminal: "b" } },
          ...["sw", "vm"].flatMap((id) => [
            { id: `${id}a`, from: { partId: id, terminal: "a" as const }, to: { partId: "r1", terminal: "a" as const } },
            { id: `${id}b`, from: { partId: id, terminal: "b" as const }, to: { partId: "r1", terminal: "b" as const } },
          ]),
          ...["nmos", "pmos"].flatMap((id) => [
            { id: `${id}a`, from: { partId: id, terminal: "a" as const }, to: { partId: "r1", terminal: "a" as const } },
            ...["b", "c"].map((terminal) => ({ id: `${id}${terminal}`, from: { partId: id, terminal: terminal as "b" | "c" }, to: { partId: "r1", terminal: "b" as const } })),
          ]),
        ],
      };
      for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
        const original = analyzeCircuit(variant, {}, { mode: "ac" });
        expect(original.status, original.message).toBe("closed");
        // Independent equal division, with nearest-even ties 3/2 -> 2 and 7/2 -> 4.
        const expected = (units === 3 ? 2 : 4) * Number.MIN_VALUE;
        for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
          for (const id of ["r1", "r2", "sw", "vm", "nmos", "pmos"]) {
            expect(result.parts[id]!.voltageVolts, id).toBe(expected);
          }
          for (const id of ["nmos", "pmos"]) {
            expect(result.parts[id]!.channelConducting).toBe(false);
            for (const difference of result.parts[id]!.terminalVoltageDifferences!) {
              expect(difference.voltageVolts).toBe(difference.fromTerminal === "b" ? 0 : expected);
            }
          }
          const nodes = circuitNodes(variant, result);
          expect(nodes.every((node) => node.currentResidualAmps === 0)).toBe(true);
          const endpointNode = (terminal: "a" | "b") => nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "sw" && endpoint.terminal === terminal));
          const context = { document: variant, analysis: result, nodes };
          expect(circuitPotential(endpointNode("a"), endpointNode("b"), true, context)!.volts).toBe(expected);
          expect(circuitPotential(endpointNode("a"), endpointNode("b"), true, context)!.volts).toBe(expected);
        }
      }
    }
  }
});

it.each([1, 3])("propagates the RMS correction through an op-amp's controlled %s-unit output", (units) => {
  const document: CircuitDocument = {
    title: "Controlled response midpoint",
    parts: [
      { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
      { id: "v", kind: "ac-source", label: "V", x: 0, y: 0, voltageVolts: units * Number.MIN_VALUE, frequencyHz: 50, phaseDegrees: 26 },
      { id: "amp", kind: "op-amp", label: "Amp", x: 0, y: 0, openLoopGain: 20 },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 20 },
    ], wires: [
      { id: "vg", from: { partId: "v", terminal: "b" }, to: { partId: "g", terminal: "a" } },
      { id: "va", from: { partId: "v", terminal: "a" }, to: { partId: "amp", terminal: "a" } },
      { id: "ag", from: { partId: "amp", terminal: "b" }, to: { partId: "g", terminal: "a" } },
      { id: "ar", from: { partId: "amp", terminal: "c" }, to: { partId: "r", terminal: "a" } },
      { id: "rg", from: { partId: "r", terminal: "b" }, to: { partId: "g", terminal: "a" } },
    ],
  };
  const original = analyzeCircuit(document, {}, { mode: "ac" });
  expect(original.status, original.message).toBe("closed");
  for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
    // Independent ideal gain and 20-ohm output stage: Vout=20V/2;
    // Iout=V/2. The 1/2 and 3/2 subnormal ties round to 0 and 2.
    expect(result.parts.r!.voltageVolts).toBe(10 * units * Number.MIN_VALUE);
    expect(result.parts.r!.currentAmps).toBe((units === 1 ? 0 : 2) * Number.MIN_VALUE);
  }
});

it.each(["nmos", "pmos"] as const)("propagates the RMS correction through a %s gate response", (kind) => {
  const polarity = kind === "nmos" ? 1 : -1;
  const document: CircuitDocument = {
    title: "MOS controlled midpoint",
    parts: [
      { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
      { id: "v", kind: "ac-source", label: "V", x: 0, y: 0, voltageVolts: Number.MIN_VALUE, offsetVolts: 2 * polarity, frequencyHz: 50, phaseDegrees: 26 },
      { id: "supply", kind: "battery", label: "Supply", x: 0, y: 0, voltageVolts: 10 },
      { id: "mos", kind, label: "MOS", x: 0, y: 0, thresholdVolts: 1, transconductanceAmpsPerVoltSquared: 0.5, channelLengthModulation: 0 },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1 },
    ], wires: [
      { id: "vg", from: { partId: "v", terminal: "b" }, to: { partId: "g", terminal: "a" } },
      { id: "vb", from: { partId: "v", terminal: "a" }, to: { partId: "mos", terminal: "b" } },
      { id: "sg", from: { partId: "supply", terminal: polarity === 1 ? "b" : "a" }, to: { partId: "g", terminal: "a" } },
      { id: "sr", from: { partId: "supply", terminal: polarity === 1 ? "a" : "b" }, to: { partId: "r", terminal: "a" } },
      { id: "ra", from: { partId: "r", terminal: "b" }, to: { partId: "mos", terminal: "a" } },
      { id: "mg", from: { partId: "mos", terminal: "c" }, to: { partId: "g", terminal: "a" } },
    ],
  };
  const original = analyzeCircuit(document, {}, { mode: "ac" });
  expect(original.status, original.message).toBe("closed");
  for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
    // Independent saturated square-law gm=beta*overdrive=1/2, gds=0.
    // The resulting MIN/2-A load current rounds to zero by nearest-even.
    expect(result.parts.r!.currentAmps).toBe(0);
    expect(result.parts.r!.voltageVolts).toBe(0);
  }
});

it("corrects the voltage of an open switch spanning a response group", () => {
  const document: CircuitDocument = {
    title: "Open-switch RMS midpoint",
    parts: [
      { id: "v", kind: "ac-source", label: "V", x: 0, y: 0, voltageVolts: Number.MIN_VALUE, frequencyHz: 50, phaseDegrees: 26 },
      ...["r1", "r2"].map((id) => ({ id, kind: "resistor" as const, label: id, x: 0, y: 0, resistanceOhms: 1 })),
      { id: "s", kind: "switch", label: "S", x: 0, y: 0, initiallyClosed: false },
    ], wires: [
      { id: "a", from: { partId: "v", terminal: "a" }, to: { partId: "r1", terminal: "a" } },
      { id: "b", from: { partId: "r1", terminal: "b" }, to: { partId: "r2", terminal: "a" } },
      { id: "c", from: { partId: "r2", terminal: "b" }, to: { partId: "v", terminal: "b" } },
      { id: "sa", from: { partId: "s", terminal: "a" }, to: { partId: "r1", terminal: "a" } },
      { id: "sb", from: { partId: "s", terminal: "b" }, to: { partId: "r1", terminal: "b" } },
    ],
  };
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const original = analyzeCircuit(variant, {}, { mode: "ac" });
    expect(original.status, original.message).toBe("closed");
    for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      // Independent equal divider: MIN/2 volts rounds to zero for both
      // the resistor and the open switch that measures the same terminals.
      expect(result.parts.r1!.voltageVolts).toBe(0);
      expect(result.parts.s!.voltageVolts).toBe(0);
      const nodes = circuitNodes(variant, result);
      const node = (terminal: "a" | "b") => nodes.find((candidate) => candidate.endpoints.some((endpoint) => endpoint.partId === "s" && endpoint.terminal === terminal));
      expect(circuitPotential(node("a"), node("b"), true, { document: variant, analysis: result, nodes })!.volts).toBe(0);
    }
  }
});

it.each(["nmos", "pmos"] as const)("corrects an off %s primary voltage from its corrected terminal potentials", (kind) => {
  const document: CircuitDocument = {
    title: "Off MOS RMS midpoint",
    parts: [
      { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
      { id: "v", kind: "ac-source", label: "V", x: 0, y: 0, voltageVolts: Number.MIN_VALUE, frequencyHz: 50, phaseDegrees: 26 },
      ...["r1", "r2"].map((id) => ({ id, kind: "resistor" as const, label: id, x: 0, y: 0, resistanceOhms: 1 })),
      { id: "mos", kind, label: "MOS", x: 0, y: 0, thresholdVolts: 2 },
    ], wires: [
      { id: "a", from: { partId: "v", terminal: "a" }, to: { partId: "r1", terminal: "a" } },
      { id: "b", from: { partId: "r1", terminal: "b" }, to: { partId: "r2", terminal: "a" } },
      { id: "c", from: { partId: "r2", terminal: "b" }, to: { partId: "v", terminal: "b" } },
      { id: "vg", from: { partId: "v", terminal: "b" }, to: { partId: "g", terminal: "a" } },
      { id: "ma", from: { partId: "mos", terminal: "a" }, to: { partId: "r2", terminal: "a" } },
      { id: "mb", from: { partId: "mos", terminal: "b" }, to: { partId: "g", terminal: "a" } },
      { id: "mc", from: { partId: "mos", terminal: "c" }, to: { partId: "g", terminal: "a" } },
    ],
  };
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const original = analyzeCircuit(variant, {}, { mode: "ac" });
    expect(original.status, original.message).toBe("closed");
    for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      // Independent equal divider: an off channel adds no load, so its
      // D-S voltage is MIN/2 and rounds to zero, like the parallel resistor.
      expect(result.parts.mos!.channelConducting).toBe(false);
      expect(result.parts.mos!.voltageVolts).toBe(0);
      expect(result.parts.r2!.voltageVolts).toBe(0);
      expect(result.parts.mos!.terminalVoltageDifferences!.find((difference) => difference.fromTerminal === "a" && difference.toTerminal === "c")!.voltageVolts).toBe(0);
    }
  }
});

it.each([[2 ** -537, 2, 0], [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]] as const)(
  "normalizes %s-V resistive power before its only display rounding", (voltageVolts, resistanceOhms, expectedPower) => {
    const document: CircuitDocument = {
      title: "Exact power normalization",
      parts: [
        { id: "v", kind: "ac-source", label: "V", x: 0, y: 0, voltageVolts, frequencyHz: 50, phaseDegrees: 26 },
        { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms },
      ], wires: [
        { id: "a", from: { partId: "v", terminal: "a" }, to: { partId: "r", terminal: "a" } },
        { id: "b", from: { partId: "v", terminal: "b" }, to: { partId: "r", terminal: "b" } },
      ],
    };
    const original = analyzeCircuit(document, {}, { mode: "ac" });
    expect(original.status, original.message).toBe("closed");
    // Independent P=V^2/R: 2^-1075 is the tie that rounds to zero;
    // MAX^2/MAX is exactly MAX, rather than an intermediate overflow.
    for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      expect(result.parts.r!.powerWatts).toBe(expectedPower);
      expect(Math.abs(result.parts.v!.powerWatts)).toBe(expectedPower);
      expect(result.parts.r!.currentAmps).toBe(voltageVolts / resistanceOhms);
    }
  });

it.each([Number.MIN_VALUE, Number.MAX_VALUE])("keeps the %s-V response independent of another source's direction normalization", (voltageVolts) => {
  for (const sharedReturn of [false, true]) {
    const maximum = voltageVolts === Number.MAX_VALUE;
    const document: CircuitDocument = {
      title: "Independent AC source responses",
      parts: [
        { id: "v", kind: "ac-source", label: "V", x: 0, y: 0, voltageVolts, frequencyHz: 50, phaseDegrees: 26 },
        { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: maximum ? Number.MAX_VALUE : 2 },
        ...(maximum ? [{ id: "r2", kind: "resistor" as const, label: "R2", x: 0, y: 0, resistanceOhms: Number.MAX_VALUE }] : []),
        { id: "other", kind: "ac-source", label: "Other", x: 0, y: 0, voltageVolts: 1, frequencyHz: 50, phaseDegrees: 0 },
        { id: "load", kind: "resistor", label: "Load", x: 0, y: 0, resistanceOhms: 1 },
      ], wires: [
        { id: "a", from: { partId: "v", terminal: "a" }, to: { partId: "r", terminal: "a" } },
        ...(maximum ? [
          { id: "12", from: { partId: "r", terminal: "b" as const }, to: { partId: "r2", terminal: "a" as const } },
          { id: "2v", from: { partId: "r2", terminal: "b" as const }, to: { partId: "v", terminal: "b" as const } },
        ] : [{ id: "b", from: { partId: "r", terminal: "b" as const }, to: { partId: "v", terminal: "b" as const } }]),
        { id: "oa", from: { partId: "other", terminal: "a" }, to: { partId: "load", terminal: "a" } },
        { id: "ob", from: { partId: "other", terminal: "b" }, to: { partId: "load", terminal: "b" } },
        ...(sharedReturn ? [{ id: "shared", from: { partId: "v", terminal: "b" as const }, to: { partId: "other", terminal: "b" as const } }] : []),
      ],
    };
    for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
      const original = analyzeCircuit(variant, {}, { mode: "ac" });
      expect(original.status, original.message).toBe("closed");
      for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
        // Independent Ohm's law for the two loops; a shared return carries
        // no coupling between their voltage differences or source currents.
        expect(result.parts.r!.currentAmps).toBe(maximum ? 0.5 : 0);
        expect(result.parts.r!.voltageVolts).toBe(maximum ? Number.MAX_VALUE / 2 : Number.MIN_VALUE);
        expect(result.parts.r!.powerWatts).toBe(maximum ? Number.MAX_VALUE / 4 : 0);
        expect(result.parts.load!.currentAmps).toBe(1);
        expect(result.parts.load!.voltageVolts).toBe(1);
        expect(result.parts.load!.powerWatts).toBe(1);
        expect(circuitNodes(variant, result).every((node) => node.currentResidualAmps === 0)).toBe(true);
      }
    }
  }
});

it("keeps a finite maximum-voltage response when different source directions interact", () => {
  const document: CircuitDocument = {
    title: "Mixed directions at the finite RMS boundary",
    parts: [
      { id: "v", kind: "ac-source", label: "V", x: 0, y: 0, voltageVolts: Number.MAX_VALUE, frequencyHz: 50, phaseDegrees: 26 },
      { id: "other", kind: "ac-source", label: "Other", x: 0, y: 0, voltageVolts: 1, frequencyHz: 50, phaseDegrees: 0 },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: Number.MAX_VALUE },
    ], wires: [
      { id: "a", from: { partId: "v", terminal: "a" }, to: { partId: "r", terminal: "a" } },
      { id: "b", from: { partId: "r", terminal: "b" }, to: { partId: "other", terminal: "a" } },
      { id: "c", from: { partId: "other", terminal: "b" }, to: { partId: "v", terminal: "b" } },
    ],
  };
  const original = analyzeCircuit(document, {}, { mode: "ac" });
  expect(original.status, original.message).toBe("closed");
  // Subtracting a 1-V source changes MAX by less than half an ULP.
  // Independent P=|Vtotal|^2/MAX and I=|Vtotal|/MAX round to MAX and 1.
  for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
    expect(result.parts.v!.voltageVolts).toBe(Number.MAX_VALUE);
    expect(result.parts.other!.voltageVolts).toBe(1);
    expect(result.parts.r!.currentAmps).toBe(1);
    expect(result.parts.r!.voltageVolts).toBe(Number.MAX_VALUE);
    expect(result.parts.r!.powerWatts).toBe(Number.MAX_VALUE);
  }
});

it.each([[1, 26, 0], [3, 45, 2], [7, 45, 4], [1, Number.MIN_VALUE, 0]] as const)(
  "normalizes the RMS direction before rounding a %s-unit source at %s degrees through 2 ohms", (units, phaseDegrees, expectedUnits) => {
    const document: CircuitDocument = {
      title: "AC RMS rounding midpoint",
      parts: [
        { id: "v", kind: "ac-source", label: "V", x: 0, y: 0, voltageVolts: units * Number.MIN_VALUE, frequencyHz: 50, phaseDegrees },
        { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 2 },
      ],
      wires: [
        { id: "vr", from: { partId: "v", terminal: "a" }, to: { partId: "r", terminal: "a" } },
        { id: "rv", from: { partId: "r", terminal: "b" }, to: { partId: "v", terminal: "b" } },
      ],
    };
    const original = analyzeCircuit(document, {}, { mode: "ac" });
    expect(original.status, original.message).toBe("closed");
    // Independent I=(units/2)*2^-1074 with nearest-even midpoint rounding.
    for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      expect(result.parts.r!.currentAmps).toBe(expectedUnits * Number.MIN_VALUE);
      expect(result.parts.r!.voltageVolts).toBe(units * Number.MIN_VALUE);
      expect(result.parts.r!.currentPhaseDegrees).toBeCloseTo(phaseDegrees, 12);
    }
  });

it("normalizes maximum finite RMS without rejecting finite load voltage, current or power", () => {
  const maximum = Number.MAX_VALUE;
  const document: CircuitDocument = {
    title: "Finite upper RMS boundary",
    parts: [
      { id: "v", kind: "ac-source", label: "V", x: 0, y: 0, voltageVolts: maximum, frequencyHz: 50, phaseDegrees: 26 },
      ...["r1", "r2"].map((id) => ({ id, kind: "resistor" as const, label: id, x: 0, y: 0, resistanceOhms: maximum })),
    ],
    wires: [
      { id: "v1", from: { partId: "v", terminal: "a" }, to: { partId: "r1", terminal: "a" } },
      { id: "12", from: { partId: "r1", terminal: "b" }, to: { partId: "r2", terminal: "a" } },
      { id: "2v", from: { partId: "r2", terminal: "b" }, to: { partId: "v", terminal: "b" } },
    ],
  };
  const original = analyzeCircuit(document, {}, { mode: "ac" });
  expect(original.status, original.message).toBe("closed");
  for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
    // Independent series divider and P=I^2*R: I=1/2, each V=MAX/2, P=MAX/4.
    expect(result.parts.v!.voltageVolts).toBe(maximum);
    for (const id of ["r1", "r2"]) {
      expect(result.parts[id]!.currentAmps).toBe(0.5);
      expect(result.parts[id]!.voltageVolts).toBe(maximum / 2);
      expect(result.parts[id]!.powerWatts).toBe(maximum / 4);
    }
    const nodes = circuitNodes(document, result);
    const node = (terminal: "a" | "b") => nodes.find((candidate) => candidate.endpoints.some((endpoint) => endpoint.partId === "r1" && endpoint.terminal === terminal));
    expect(circuitPotential(node("a"), node("b"), true, { document, analysis: result, nodes })!.volts).toBe(maximum / 2);
  }
});

it("preserves the uncertainty of consistent tiny AC source loops without accepting an inconsistent loop", () => {
  const voltageVolts = 1e-310;
  for (const grounded of [false, true]) {
    for (const inconsistent of [false, true]) {
      const document: CircuitDocument = {
        title: "Tiny AC triangle",
        parts: [
          ...[["v1", 60], ["v2", -60], ["v3", 0]].map(([id, phaseDegrees]) => ({
            id: String(id), kind: "ac-source" as const, label: String(id), x: 0, y: 0, frequencyHz: 50, phaseDegrees: Number(phaseDegrees),
            voltageVolts: id === "v3" && inconsistent ? voltageVolts * (1 + 1e-8) : voltageVolts,
          })),
          { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1e-300 },
          ...(grounded ? [{ id: "g", kind: "ground" as const, label: "GND", x: 0, y: 0 }] : []),
        ],
        wires: [
          { id: "v12", from: { partId: "v1", terminal: "b" }, to: { partId: "v2", terminal: "a" } },
          { id: "v13", from: { partId: "v1", terminal: "a" }, to: { partId: "v3", terminal: "a" } },
          { id: "v23", from: { partId: "v2", terminal: "b" }, to: { partId: "v3", terminal: "b" } },
          { id: "vr", from: { partId: "v3", terminal: "a" }, to: { partId: "r", terminal: "a" } },
          { id: "rv", from: { partId: "v3", terminal: "b" }, to: { partId: "r", terminal: "b" } },
          ...(grounded ? [{ id: "g", from: { partId: "g", terminal: "a" as const }, to: { partId: "v3", terminal: "b" as const } }] : []),
        ],
      };
      for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
        const result = analyzeCircuit(variant, {}, { mode: "ac" });
        expect(result.status, result.message).toBe(inconsistent ? "invalid" : "closed");
        if (!inconsistent) {
          // Independent identity: cos(60)=1/2 and opposite imaginary
          // components cancel, so the total voltage equals V3.
          expect(result.parts.r!.currentAmps / (voltageVolts / 1e-300)).toBeCloseTo(1, 14);
          expect(result.parts.r!.currentPhaseDegrees).toBe(0);
        }
      }
    }
  }
});

it.each([[Number.MIN_VALUE, 30], [2 * Number.MIN_VALUE, 45], [2 * Number.MIN_VALUE, 135], [2 * Number.MIN_VALUE, -45]] as const)(
  "retains %s-V RMS at %s degrees before a small resistance amplifies the current", (voltageVolts, phaseDegrees) => {
    for (const grounded of [false, true]) {
      const resistanceOhms = 1e-300;
      const document: CircuitDocument = {
        title: "Subnormal source driving a representable current",
        parts: [
          { id: "v", kind: "ac-source", label: "V", x: 0, y: 0, voltageVolts, frequencyHz: 50, phaseDegrees, internalResistanceOhms: 0 },
          { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms },
          ...(grounded ? [{ id: "g", kind: "ground" as const, label: "GND", x: 0, y: 0 }] : []),
        ],
        wires: [
          { id: "vr", from: { partId: "v", terminal: "a" }, to: { partId: "r", terminal: "a" } },
          { id: "rv", from: { partId: "r", terminal: "b" }, to: { partId: "v", terminal: "b" } },
          ...(grounded ? [{ id: "g", from: { partId: "g", terminal: "a" as const }, to: { partId: "v", terminal: "b" as const } }] : []),
        ],
      };
      // Independent Ohm's law; current magnitude is well within binary64.
      const expected = voltageVolts / resistanceOhms;
      const analog = analyzeAnalogCircuit(document, { mode: "ac" });
      expect(analog.status).toBe("valid");
      const current = analog.parts.r!.current;
      expect(Math.hypot(current.real, current.imaginary) / expected).toBeCloseTo(1, 14);
      expect((Math.atan2(current.imaginary, current.real) * 180) / Math.PI).toBeCloseTo(phaseDegrees, 12);
      const result = analyzeCircuit(document, {}, { mode: "ac" });
      expect(result.status, result.message).toBe("closed");
      expect(result.parts.r!.voltageVolts).toBe(voltageVolts);
      expect(result.parts.r!.currentAmps / expected).toBeCloseTo(1, 14);
      expect(result.parts.r!.voltagePhaseDegrees).toBeCloseTo(phaseDegrees, 12);
      expect(result.parts.r!.currentPhaseDegrees).toBeCloseTo(phaseDegrees, 12);
    }
  });
