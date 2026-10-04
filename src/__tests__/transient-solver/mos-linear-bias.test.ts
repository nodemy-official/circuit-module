import { describe, expect, it } from "vitest";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

const model = { thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 2, channelLengthModulation: 0 };
const networks = ["potentiometer", "internal-resistance", "switch", "ammeter", "voltage-source", "capacitor", "inductor", "mixed", "diode", "led", "diode-parallel", "bjt", "opamp", "opamp-feedback", "bjt-ideal-tie", "bjt-offset-tie", "bjt-ce-offset-tie", "bjt-be-offset-tie", "dynamic-diode", "charged-diode"] as const;

function gateNetwork(network: typeof networks[number], sign: number): CircuitSpec[] {
  const bias: CircuitSpec = ["tg", "ac-source", ["tb", "drain"], { voltageVolts: 0, offsetVolts: sign * (network === "charged-diode" ? 3.5 : 3) }];
  if (network === "diode" || network === "led" || network === "diode-parallel") {
    const junction: CircuitSpec = ["di", network === "led" ? "led" : "diode", ["tb", "tg"]];
    return network === "diode-parallel" ? [bias, junction, ["tr", "resistor", ["tb", "tg"], { resistanceOhms: 1 }]] : [bias, junction];
  }
  if (network === "bjt-ideal-tie" || network === "bjt-offset-tie") {
    const offset = network === "bjt-offset-tie" ? 1 : 0;
    return [bias, ["tie1", "ac-source", ["x", "tb"], { voltageVolts: 0, offsetVolts: offset }],
      ["tie2", "ac-source", ["y", "x"], { voltageVolts: 0, offsetVolts: -offset }],
      ["q", sign === 1 ? "npn-transistor" : "pnp-transistor", ["y", "tb", "tg"], { saturationCurrentAmps: 0.01, currentGain: 100 }]];
  }
  if (network === "bjt-ce-offset-tie" || network === "bjt-be-offset-tie") {
    const collectorEmitter = network === "bjt-ce-offset-tie";
    return [bias, ["tie1", "ac-source", ["x", "y"], { voltageVolts: 0, offsetVolts: sign * 0.125 }],
      ["tie2", "ac-source", ["y", collectorEmitter ? "tg" : "tb"], { voltageVolts: 0, offsetVolts: -sign * 0.125 }],
      ["q", sign === 1 ? "npn-transistor" : "pnp-transistor", collectorEmitter ? ["x", "tb", "tg"] : ["tg", "x", "tb"], { saturationCurrentAmps: 0.01, currentGain: 100 }]];
  }
  if (network === "dynamic-diode" || network === "charged-diode") {
    return [bias, ["di", "diode", ["tb", "x"], { saturationCurrentAmps: 0.01, emissionCoefficient: 1 }],
      ["tl", "inductor", ["x", "y"], { inductanceHenries: 1, initialCurrentAmps: 0 }],
      ["tc", "capacitor", ["y", "tg"], { capacitanceFarads: 2, initialVoltageVolts: network === "charged-diode" ? sign * 0.5 : 0 }]];
  }
  if (network === "bjt") {
    return [bias, ["q", sign === 1 ? "npn-transistor" : "pnp-transistor", ["tb", "tb", "tg"], { saturationCurrentAmps: 1e-12, currentGain: 100 }]];
  }
  if (network === "opamp") {
    return [bias, ["buffer", "op-amp", ["tb", "0", "tg"], { openLoopGain: 1, positiveRailVolts: 100, negativeRailVolts: -100 }]];
  }
  if (network === "opamp-feedback") {
    return [bias, ["buffer", "op-amp", ["plus", "tg", "tg"], { openLoopGain: 16, positiveRailVolts: 100, negativeRailVolts: -100 }],
      ["feedback-scale", "ac-source", ["plus", "tb"], { voltageVolts: 0, offsetVolts: sign * 13.5 / 16 }]];
  }
  const resistor: CircuitSpec = ["tr", "resistor", ["tb", "x"], { resistanceOhms: 1 }];
  if (network === "potentiometer") {
    return [bias, ["tp", "potentiometer", ["tb", "tb", "tg"], { resistanceOhms: 4, wiperPosition: 0.5 }]];
  }
  if (network === "internal-resistance") {
    return [["tg", "battery", sign === 1 ? ["tg", "drain"] : ["drain", "tg"], { voltageVolts: 3, internalResistanceOhms: 1 }]];
  }
  const endpoint = network === "mixed" ? "y" : "tg";
  const connector: CircuitSpec = network === "switch" ? ["sw", "switch", ["x", endpoint], { initiallyClosed: true }]
    : network === "ammeter" ? ["am", "ammeter", ["x", endpoint]]
    : network === "voltage-source" ? ["shift", "ac-source", [endpoint, "x"], { voltageVolts: 0, offsetVolts: 0 }]
    : network === "capacitor" ? ["tc", "capacitor", ["x", endpoint], { capacitanceFarads: 1, initialVoltageVolts: 0 }]
    : ["tl", "inductor", ["x", endpoint], { inductanceHenries: 1, initialCurrentAmps: 0 }];
  return network === "mixed" ? [bias, resistor, connector,
    ["tc", "capacitor", ["y", "z"], { capacitanceFarads: 2, initialVoltageVolts: 0 }],
    ["sw", "switch", ["z", "tg"], { initiallyClosed: true }]] : [bias, resistor, connector];
}

describe("MOS initial constraints through gate bias networks", () => {
  for (const kind of ["nmos", "pmos"] as const) {
    for (const reversed of [false, true]) {
      it.each(networks)(`kind=${kind}, network=%s, reversed=${reversed}`, (network) => {
        const sign = kind === "nmos" ? 1 : -1;
        const specs: CircuitSpec[] = [
          ["supply", "ac-source", ["supply", "0"], { voltageVolts: 0, offsetVolts: sign * 10 }],
          ["g1", "ac-source", ["bias", "0"], { voltageVolts: 0, offsetVolts: sign * 2.5 }],
          ["g2", "ac-source", ["gate2", "0"], { voltageVolts: 0, offsetVolts: sign * 4 }],
          ["l", "inductor", ["supply", "drain"], { inductanceHenries: 1, initialCurrentAmps: sign }],
          ["rg", "resistor", ["bias", "gate1"], { resistanceOhms: 2 }],
          ["cg", "capacitor", ["gate1", "0"], { capacitanceFarads: 1, initialVoltageVolts: sign * 3 }],
          ["m1", kind, reversed ? ["0", "gate1", "middle"] : ["middle", "gate1", "0"], model],
          ["m2", kind, reversed ? ["middle", "gate2", "drain"] : ["drain", "gate2", "middle"], model],
          ["ti", "current-source", ["drain", "td"], { currentAmps: sign * (1 - 2 ** -52) }],
          ["tm", kind, reversed ? ["drain", "tg", "td"] : ["td", "tg", "drain"], model],
          ...gateNetwork(network, sign),
        ];
        if (network === "opamp") {
          // Three unknown nonlinear biases must not hide the saturated pair.
          // A prefix-only subset search misses the correct active set.
          for (const id of ["extra1", "extra2"]) {
            specs.push([`${id}-current`, "current-source", ["drain", id], { currentAmps: sign * (1 - 2 ** -52) }],
              [id, kind, [id, "tg", "drain"], model]);
          }
        }
        if (!reversed || network.startsWith("opamp")) { specs.push(["ground", "ground", ["0"]]); }
        const result = simulateTransient(createCircuitFromSpecs(reversed ? specs.toReversed() : specs, "Zero-current gate paths"), {
          durationSeconds: 1e-5, timeStepSeconds: 1e-5,
        });
        expect(result.status, result.message).toBe("valid");
        const initial = result.samples[0]!.parts;
        // The gate networks carry zero current. The lower saturated MOS has
        // I' = 2*(3-2)*(2.5-3)/(R*C) = -1/2 A/s, hence V_L = -1/2 V.
        expect(initial.l!.voltageVolts).toBe(-sign * 0.5);
        expect(initial.tm!.currentAmps).toBe((reversed ? -sign : sign) * (1 - 2 ** -52));
        expect(initial.tm!.voltageVolts).toBe((reversed ? -sign : sign) * (1 - 2 ** -26));
        for (const sample of result.samples) {
          for (const id of ["tr", "tp", "tc", "tl", "sw", "am", "di", "q", "buffer"]) {
            if (sample.parts[id]) { expect(sample.parts[id]!.currentAmps).toBe(0); }
          }
          if (sample.parts.tl) { expect(sample.parts.tl.voltageVolts).toBe(0); }
          if (network === "bjt-ce-offset-tie" || network === "bjt-be-offset-tie") {
            // Equal external potentials do not make the unloaded midpoint
            // equipotential: each source must retain its nonzero voltage.
            expect(sample.parts.tie1!.voltageVolts).toBe(sign * 0.125);
            expect(sample.parts.tie2!.voltageVolts).toBe(-sign * 0.125);
          }
        }
      });
    }
  }
});
