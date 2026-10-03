import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

describe("MOS current bounds through passive gate bias networks", () => {
  for (const kind of ["nmos", "pmos"] as const) {
    for (const topology of ["series", "parallel", "divider", "bridge", "current", "potentiometer", "internal-resistance", "switch", "ammeter", "voltage-source", "inductor", "diode", "led", "diode-parallel", "bjt-cb", "bjt-be", "bjt-ce"] as const) {
      it.each([0.5, 1 + 2 ** -40])(`${kind}, ${topology}, current=%s`, (current) => {
        const sign = kind === "nmos" ? 1 : -1;
        const source = topology === "divider" || topology === "bridge" ? 6 : topology === "current" ? 4 : topology === "internal-resistance" ? 0 : 3;
        const specs: CircuitSpec[] = [
          ["bias", "ac-source", ["bias", "0"], { voltageVolts: 0, offsetVolts: sign * source }],
          ["drive", "current-source", ["0", "drain"], { currentAmps: sign * current }],
          ["mos", kind, ["drain", "gate", "0"], { thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 2, channelLengthModulation: 0 }],
          ["ground", "ground", ["0"]],
        ];
        const resistor = (id: string, a: string, b: string, resistanceOhms = 2): CircuitSpec => [id, "resistor", [a, b], { resistanceOhms }];
        if (topology === "series") {
          specs.push(resistor("r1", "bias", "middle", 1e200), resistor("r2", "middle", "gate", 1e-200));
        } else if (topology === "parallel") {
          specs.push(resistor("r1", "bias", "gate"), resistor("r2", "bias", "gate", 4));
        } else if (topology === "divider") {
          specs.push(resistor("r1", "bias", "gate"), resistor("r2", "gate", "0"));
        } else if (topology === "bridge") {
          specs.push(resistor("r1", "bias", "x"), resistor("r2", "x", "0"), resistor("r3", "bias", "y"), resistor("r4", "y", "0"),
            resistor("r5", "x", "gate"), resistor("r6", "y", "gate", 4));
        } else if (topology === "current") {
          specs.push(resistor("r1", "bias", "gate"), ["gate-current", "current-source", ["gate", "0"], { currentAmps: sign * 0.5 }]);
        } else if (topology === "diode" || topology === "led" || topology === "diode-parallel") {
          specs.push(["junction", topology === "led" ? "led" : "diode", ["bias", "gate"]]);
          if (topology === "diode-parallel") { specs.push(resistor("r1", "bias", "gate")); }
        } else if (topology === "bjt-cb" || topology === "bjt-be" || topology === "bjt-ce") {
          const terminals = topology === "bjt-cb" ? ["bias", "bias", "gate"] : topology === "bjt-be" ? ["gate", "bias", "bias"] : ["bias", "gate", "bias"];
          specs.push(["junction", sign === 1 ? "npn-transistor" : "pnp-transistor", terminals]);
        } else if (topology === "potentiometer") {
          specs.push(["pot", "potentiometer", ["bias", "bias", "gate"], { resistanceOhms: 4, wiperPosition: 0.5 }]);
        } else if (topology === "internal-resistance") {
          specs.push(["battery", "battery", sign === 1 ? ["gate", "bias"] : ["bias", "gate"], { voltageVolts: 3, internalResistanceOhms: 2 }]);
        } else {
          specs.push(resistor("r1", "bias", "x"));
          const connector: CircuitSpec = topology === "switch" ? ["connector", "switch", ["x", "gate"], { initiallyClosed: true }]
            : topology === "ammeter" ? ["connector", "ammeter", ["x", "gate"]]
            : topology === "voltage-source" ? ["connector", "ac-source", ["gate", "x"], { voltageVolts: 0, offsetVolts: 0 }]
            : ["connector", "inductor", ["x", "gate"], { inductanceHenries: 1 }];
          specs.push(connector);
        }
        for (const order of [specs, specs.toReversed()]) {
          const result = analyzeAnalogCircuit(createCircuitFromSpecs(order, "Exactly 3 V resistive MOS gate bias"));
          // All networks fix |Vgs|=3 V by elementary KCL/KVL.
          // The square-law maximum is beta/2*(3-2)^2=1 A exactly.
          expect(result.status, result.message).toBe(current > 1 ? "invalid" : "valid");
          if (current < 1) {
            expect(result.parts.mos!.current.real / (sign * current)).toBeCloseTo(1, 12);
            expect(result.parts.mos!.voltage.real).toBeCloseTo(sign * (1 - Math.SQRT1_2), 12);
          }
        }
      });
    }
  }
});


describe("passive bias inference with nonzero gate injection", () => {
  for (const kind of ["nmos", "pmos"] as const) {
    it.each(["diode", "led"] as const)(`${kind} allows reverse-driven %s gate bias`, (junction) => {
      const sign = kind === "nmos" ? 1 : -1;
      const result = analyzeAnalogCircuit(createCircuitFromSpecs([
        ["bias", "ac-source", ["bias", "0"], { voltageVolts: 0, offsetVolts: sign * 3 }],
        ["junction", junction, sign === 1 ? ["bias", "gate"] : ["gate", "bias"], { saturationCurrentAmps: 1e-12, emissionCoefficient: 1 }],
        ["gate-current", "current-source", ["gate", "0"], { currentAmps: -sign * 5e-13 }],
        ["drive", "current-source", ["0", "drain"], { currentAmps: sign * 1.01 }],
        ["mos", kind, ["drain", "gate", "0"], { thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 2, channelLengthModulation: 0 }],
        ["ground", "ground", ["0"]],
      ], "Reverse gate current changes the saturation bound"));
      // I_diode=-Is/2 gives |Vgs|=3+Vt*ln(2), so 1.01 A is feasible.
      // A zero-current inference here would incorrectly impose a 1 A cap.
      const overdrive = 1 + 0.025_85 * Math.LN2;
      expect(result.status, result.message).toBe("valid");
      expect(result.parts.mos!.current.real).toBeCloseTo(sign * 1.01, 12);
      expect(result.parts.mos!.voltage.real).toBeCloseTo(sign * (overdrive - Math.sqrt(overdrive ** 2 - 1.01)), 12);
    });
  }
});
