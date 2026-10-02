import { describe, expect, it } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis } from "../../circuit-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

function circuitOrders(document: CircuitDocument) {
  return [document.parts, document.parts.toReversed()].flatMap((parts) =>
    [document.wires, document.wires.toReversed()].flatMap((orderedWires) =>
      [orderedWires, orderedWires.map((wire) => ({ ...wire, from: wire.to, to: wire.from }))]
        .map((wires) => ({ ...document, parts, wires }))));
}

function openCircuitChecks(analysis: CircuitAnalysis) {
  const readings = Object.values(analysis.parts);
  return {
    status: analysis.status,
    finiteVoltages: readings.every((reading) =>
      [reading.voltageVolts, ...Object.values(reading.terminalVoltages!)].every(Number.isFinite)),
    zeroCurrents: readings.every((reading) => reading.currentAmps === 0) &&
      Object.values(analysis.wireCurrents).every((current) => current === 0),
    zeroPower: readings.every((reading) => reading.powerWatts === 0),
  };
}

const finiteOpen = { status: "open", finiteVoltages: true, zeroCurrents: true, zeroPower: true };

describe("legacy voltage reference near the binary64 range limit", () => {
  it("keeps a floating voltmeter finite when only one source component overflows its reference", () => {
    const document = createCircuitFromSpecs([
      ["B1", "battery", ["p", "m"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B2", "battery", ["m", "n"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B3", "battery", ["u", "v"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["meter", "voltmeter", ["n", "u"]],
    ], "Floating voltage readings must use compatible finite references");
    const analysis = analyzeCircuit(document);
    expect(analysis.status, analysis.message).toBe("open");
    expect(analysis.parts.B1!.terminalVoltages).toEqual({ a: 1e308, b: 0 });
    expect(analysis.parts.B2!.terminalVoltages).toEqual({ a: 0, b: -1e308 });
    expect(analysis.parts.B3!.terminalVoltages).toEqual({ a: 5e307, b: -5e307 });
    expect(analysis.parts.meter!.meterStatus).toBe("floating");
    expect(analysis.parts.meter!.voltageVolts).toBe(-1.5e308);
    for (const reading of Object.values(analysis.parts)) {
      expect(reading.currentAmps).toBe(0);
      expect(reading.powerWatts).toBe(0);
      expect(Object.values(reading.terminalVoltages!).every(Number.isFinite)).toBe(true);
    }
    expect(Object.values(analysis.wireCurrents).every((current) => current === 0)).toBe(true);
  });

  it.each(["voltmeter", "switch"] as const)("keeps separate source components finite across an open %s in either order", (kind) => {
    const document = createCircuitFromSpecs([
      ["B1", "battery", ["p", "m"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B2", "battery", ["m", "n"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B3", "battery", ["u", "v"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["bridge", kind, ["n", "u"], { initiallyClosed: true }],
    ], "An open part does not fix the relative voltage reference");
    for (const ordered of circuitOrders(document)) {
      const analysis = analyzeCircuit(ordered, kind === "switch" ? { bridge: false } : {});
      expect(openCircuitChecks(analysis), analysis.message).toEqual(finiteOpen);
      if (kind === "voltmeter") { expect(analysis.parts.bridge!.meterStatus).toBe("floating"); }
      else { expect(analysis.parts.bridge!.switchClosed).toBe(false); }
      expect(analysis.parts.bridge!.voltageVolts).not.toBe(0);
      for (const id of ["B1", "B2", "B3"]) { expect(analysis.parts[id]!.voltageVolts).toBe(1e308); }
    }
  });

  it("also corrects a floating difference when all individual terminal voltages are finite", () => {
    const specs: CircuitSpec[] = [
      ["B1", "battery", ["p", "n"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B2", "battery", ["u", "v"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["dangling", "resistor", ["p", "unused"], { resistanceOhms: 10 }],
    ];
    const baseline = analyzeCircuit(createCircuitFromSpecs(specs, "Finite individual terminal voltages"));
    expect(openCircuitChecks(baseline), baseline.message).toEqual(finiteOpen);
    expect(baseline.parts.B1!.terminalVoltages).toEqual({ a: 0, b: -1e308 });
    expect(baseline.parts.B2!.terminalVoltages).toEqual({ a: 1e308, b: 0 });
    const analysis = analyzeCircuit(createCircuitFromSpecs([
      ...specs, ["meter", "voltmeter", ["n", "u"]],
    ], "Only the floating difference overflows"));
    expect(openCircuitChecks(analysis), analysis.message).toEqual(finiteOpen);
    expect(analysis.parts.meter!.meterStatus).toBe("floating");
    expect(analysis.parts.meter!.voltageVolts).toBe(-1e308);
  });

  it("coordinates multiple floating voltmeters, an open switch and an unconnected lead", () => {
    const document = createCircuitFromSpecs([
      ["B1", "battery", ["p", "m"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B2", "battery", ["m", "n"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B3", "battery", ["u", "v"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B4", "battery", ["w", "x"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["first", "voltmeter", ["n", "u"]],
      ["second", "voltmeter", ["v", "w"]],
      ["third", "voltmeter", ["p", "v"]],
      ["open", "switch", ["p", "x"], { initiallyClosed: false }],
      ["unconnected", "voltmeter", ["p", "free"]],
    ], "Every exposed voltage shares a compatible set of arbitrary references");
    for (const ordered of circuitOrders(document)) {
      const analysis = analyzeCircuit(ordered);
      expect(openCircuitChecks(analysis), analysis.message).toEqual(finiteOpen);
      for (const id of ["first", "second", "third"]) { expect(analysis.parts[id]!.meterStatus).toBe("floating"); }
      expect(analysis.parts.unconnected!.meterStatus).toBe("unconnected");
      expect(analysis.parts.first!.voltageVolts).toBe(-1.5e308);
      expect(analysis.parts.second!.voltageVolts).toBe(-1e308);
      expect(analysis.parts.third!.voltageVolts).toBe(1.5e308);
      expect(analysis.parts.open!.voltageVolts).toBe(1.5e308);
      expect(analysis.parts.unconnected!.voltageVolts).toBe(1e308);
    }
  });

  it("keeps ordinary voltage references, including islands beside a corrected network", () => {
    const ordinary: CircuitSpec[] = [
      ["small", "battery", ["small-p", "small-n"], { voltageVolts: 6, internalResistanceOhms: 1 }],
      ["other", "battery", ["other-p", "other-n"], { voltageVolts: 2, internalResistanceOhms: 1 }],
      ["meter", "voltmeter", ["small-p", "other-p"]],
    ];
    const baseline = analyzeCircuit(createCircuitFromSpecs(ordinary, "Ordinary floating readings"));
    expect(openCircuitChecks(baseline), baseline.message).toEqual(finiteOpen);
    expect(baseline.parts.small!.terminalVoltages).toEqual({ a: 6, b: 0 });
    expect(baseline.parts.other!.terminalVoltages).toEqual({ a: 2, b: 0 });
    expect(baseline.parts.meter!.voltageVolts).toBe(4);
    const document = createCircuitFromSpecs([
      ...ordinary,
      ["B1", "battery", ["p", "m"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B2", "battery", ["m", "n"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
    ], "Independent ordinary references remain unchanged");
    for (const ordered of circuitOrders(document)) {
      const analysis = analyzeCircuit(ordered);
      expect(openCircuitChecks(analysis), analysis.message).toEqual(finiteOpen);
      for (const id of ["small", "other", "meter"]) { expect(analysis.parts[id]).toEqual(baseline.parts[id]); }
    }
  });

  it.each([false, true])("handles floating constraints that exceed centered differences (conflicting=%s)", (conflicting) => {
    const document = createCircuitFromSpecs([
      ["B1", "battery", ["p", "m"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B2", "battery", ["m", "n"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B3", "battery", ["u", "v"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B4", "battery", ["v", "w"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["first", "voltmeter", ["n", "u"]],
      ...(conflicting ? [["second", "voltmeter", ["p", "w"]] as const] : []),
    ], "Centering alone need not make every floating difference finite");
    for (const ordered of circuitOrders(document)) {
      const analysis = analyzeCircuit(ordered);
      if (conflicting) {
        expect(analysis.status).toBe("invalid");
        continue;
      }
      expect(openCircuitChecks(analysis), analysis.message).toEqual(finiteOpen);
      expect(analysis.parts.first!.meterStatus).toBe("floating");
      expect(analysis.parts.first!.voltageVolts).not.toBe(0);
      for (const id of ["B1", "B2", "B3", "B4"]) { expect(analysis.parts[id]!.voltageVolts).toBe(1e308); }
    }
  });

  it.each([969, 971])("respects the finite rounding boundary while fitting floating references (gap=2^%s)", (exponent) => {
    const document = createCircuitFromSpecs([
      ["B1", "battery", ["p", "q"], { voltageVolts: Number.MAX_VALUE, internalResistanceOhms: 1 }],
      ["gap", "battery", ["q", "r"], { voltageVolts: 2 ** exponent, internalResistanceOhms: 1 }],
      ["B2", "battery", ["r", "n"], { voltageVolts: Number.MAX_VALUE, internalResistanceOhms: 1 }],
      ["B3", "battery", ["u", "v"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["meter", "voltmeter", ["n", "u"]],
    ], "Reference bounds use the same finite rounding boundary as the outputs");
    for (const ordered of circuitOrders(document)) {
      const analysis = analyzeCircuit(ordered);
      if (exponent === 971) {
        // Half the span is MAX_VALUE + 2^970, the tie that rounds to infinity.
        expect(analysis.status).toBe("invalid");
        continue;
      }
      // Half the span is MAX_VALUE + 2^968, which still rounds to MAX_VALUE.
      // A bound at exact MAX_VALUE would incorrectly reject these references.
      expect(openCircuitChecks(analysis), analysis.message).toEqual(finiteOpen);
      expect(analysis.parts.B1!.voltageVolts).toBe(Number.MAX_VALUE);
      expect(analysis.parts.B2!.voltageVolts).toBe(Number.MAX_VALUE);
      expect(analysis.parts.gap!.voltageVolts).toBe(2 ** exponent);
      expect(analysis.parts.meter!.meterStatus).toBe("floating");
    }
  });

  it.each([false, true])("keeps an open series source network independent of part order (dangling=%s)", (dangling) => {
    const document = createCircuitFromSpecs([
      ["first", "battery", ["positive", "middle"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["second", "battery", ["middle", "negative"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ...(dangling ? [["dangling", "resistor", ["middle", "unused"], { resistanceOhms: 10 }] as const] : []),
    ], "An arbitrary voltage reference must not overflow an open circuit");
    for (const parts of [document.parts, document.parts.toReversed()]) {
      for (const reverseWires of [false, true]) {
        const wires = reverseWires ? document.wires.map((wire) => ({ ...wire, from: wire.to, to: wire.from })) : document.wires;
        const analysis = analyzeCircuit({ ...document, parts, wires });
        expect(analysis.status, analysis.message).toBe("open");
        for (const id of ["first", "second"]) {
          expect(analysis.parts[id]!.voltageVolts).toBe(1e308);
          expect(analysis.parts[id]!.currentAmps).toBe(0);
          expect(analysis.parts[id]!.powerWatts).toBe(0);
          expect(Object.values(analysis.parts[id]!.terminalVoltages!).every(Number.isFinite)).toBe(true);
        }
        expect(Object.values(analysis.wireCurrents).every((current) => current === 0)).toBe(true);
      }
    }
  });

  it("preserves finite load currents and powers while correcting a floating meter", () => {
    const document = createCircuitFromSpecs([
      ["B1", "battery", ["p", "m"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B2", "battery", ["m", "n"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["B3", "battery", ["u", "v"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["load1", "resistor", ["p", "m"], { resistanceOhms: 1e308 }],
      ["load2", "resistor", ["m", "n"], { resistanceOhms: 1e308 }],
      ["load3", "resistor", ["u", "v"], { resistanceOhms: 1e308 }],
      ["meter", "voltmeter", ["n", "u"]],
    ], "Exact local voltage drops survive a large reference shift");
    for (const ordered of circuitOrders(document)) {
      const analysis = analyzeCircuit(ordered);
      expect(analysis.status, analysis.message).toBe("closed");
      for (const id of ["B1", "B2", "B3", "load1", "load2", "load3"]) {
        // Each independent loop carries 1e308 / (1e308 + 1 + wire resistance),
        // which rounds to 1 A while retaining the internal drop exactly.
        expect(analysis.parts[id]!.currentAmps).toBe(id.startsWith("B") ? -1 : 1);
        expect(analysis.parts[id]!.voltageVolts).toBe(1e308);
        expect(analysis.parts[id]!.powerWatts).toBe(1e308);
        expect(Object.values(analysis.parts[id]!.terminalVoltages!).every(Number.isFinite)).toBe(true);
      }
      expect(analysis.parts.meter!.meterStatus).toBe("floating");
      expect(Number.isFinite(analysis.parts.meter!.voltageVolts)).toBe(true);
    }
  });

  it.each(["voltmeter", "switch"] as const)("still rejects a physical %s voltage outside the finite output range", (kind) => {
    const document = createCircuitFromSpecs([
      ["first", "battery", ["positive", "middle"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["second", "battery", ["middle", "negative"], { voltageVolts: 1e308, internalResistanceOhms: 1 }],
      ["open", kind, ["positive", "negative"], { initiallyClosed: false }],
    ], "The physical measured voltage itself overflows");
    for (const ordered of circuitOrders(document)) { expect(analyzeCircuit(ordered).status).toBe("invalid"); }
  });

  it.each(["current", "power", "terminal range"])("still rejects physical %s overflow", (quantity) => {
    const specs: CircuitSpec[] = quantity === "terminal range"
      ? Array.from({ length: 4 }, (_, index) => [
        `B${index}`, "battery", [`n${index}`, `n${index + 1}`], { voltageVolts: 1e308, internalResistanceOhms: 1 },
      ])
      : [
        ["source", "battery", ["p", "n"], { voltageVolts: 1e308, internalResistanceOhms: quantity === "current" ? 0 : 1 }],
        ["load", "resistor", ["p", "n"], { resistanceOhms: quantity === "current" ? 1e-6 : 1 }],
      ];
    const document = createCircuitFromSpecs(specs, "A reference shift cannot hide physical overflow");
    for (const ordered of circuitOrders(document)) { expect(analyzeCircuit(ordered).status).toBe("invalid"); }
  });
});
