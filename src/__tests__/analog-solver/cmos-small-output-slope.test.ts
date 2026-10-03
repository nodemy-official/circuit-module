import { expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";
import { addRational, assertCorrectRounding, divideRational, multiplyRational, negateRational, rational, rationalFromNumber } from "../helpers/numeric-oracle.js";

it.each([2 ** -1000, 1, 2 ** 900].flatMap((scale) =>
  [1e-14, 1e-16, 1e-20].flatMap((lambda) =>
    ["none", "diode-r", "diode-i", "led-r", "bjt-r"].map((island) => ({ scale, lambda, island }))),
))("resolves the symmetric CMOS voltage with a small output slope (scale=$scale, lambda=$lambda, island=$island)", ({ scale, lambda, island }) => {
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["supply", "battery", ["v", "0"], { voltageVolts: 5 }],
    ["input", "ac-source", ["in", "0"], { voltageVolts: 0, offsetVolts: 2.5, frequencyHz: 1 }],
    ["n", "nmos", ["out", "in", "0"], { thresholdVolts: 1, transconductanceAmpsPerVoltSquared: scale / 32, channelLengthModulation: lambda }],
    ["p", "pmos", ["out", "in", "v"], { thresholdVolts: 1, transconductanceAmpsPerVoltSquared: scale / 32, channelLengthModulation: lambda }],
  ];
  // This bias circuit shares only the ground reference with the inverter.
  // Its rounded exponential residual must not stop the MOS corrections.
  if (island === "diode-i") {
    specs.push(["extra-i", "current-source", ["0", "extra-d"], { currentAmps: 0.001 }],
      ["extra-d", "diode", ["extra-d", "0"], { saturationCurrentAmps: 1e-12, emissionCoefficient: 1 }]);
  } else if (island !== "none") {
    specs.push(["extra-s", "battery", ["extra-v", "0"], { voltageVolts: 1 }],
      ["extra-r", "resistor", ["extra-v", "extra-d"], { resistanceOhms: 1000 }]);
    if (island === "bjt-r") {
      specs.push(["extra-d", "npn-transistor", ["extra-d", "extra-d", "0"], { saturationCurrentAmps: 1e-12, currentGain: 100 }]);
    } else {
      specs.push(["extra-d", island === "led-r" ? "led" : "diode", ["extra-d", "0"], { saturationCurrentAmps: 1e-12, emissionCoefficient: 1 }]);
    }
  }
  // Both overdrives are 1.5 V. In saturation, KCL cancels the identical
  // beta*U^2/2 terms, leaving lambda*(Vout-(5-Vout))=0 exactly.
  for (const ordered of [specs, specs.toReversed()]) {
    const document = createCircuitFromSpecs(ordered, "CMOS with nonzero sub-ulp output conductance");
    const dc = analyzeAnalogCircuit(document);
    expect(dc.status, dc.message).toBe("valid");
    expect(dc.parts.n!.voltage.real).toBe(2.5);
    expect(dc.parts.p!.voltage.real).toBe(-2.5);
    expect(dc.parts.n!.current.real).toBe(-dc.parts.p!.current.real);
    const transient = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
    expect(transient.status, transient.message).toBe("valid");
    for (const sample of transient.samples) {
      expect(sample.parts.n!.voltageVolts).toBe(2.5);
      expect(sample.parts.p!.voltageVolts).toBe(-2.5);
    }
    const amplitude = lambda / 1024;
    const acDocument = { ...document, parts: document.parts.map((part) => part.id === "input" ? { ...part, voltageVolts: amplitude } : part) };
    const ac = analyzeAnalogCircuit(acDocument, { mode: "ac", frequencyHz: 1 });
    expect(ac.status, ac.message).toBe("valid");
    // -sum(gm)/sum(gds) = -(1 + 2.5*lambda)/(0.75*lambda).
    // Compute the expectation with the independent rational oracle; a
    // bisection of rounded terminal currents cannot resolve this weak slope.
    const exactLambda = rationalFromNumber(lambda)!;
    const gain = negateRational(divideRational(
      addRational(rational(1n), multiplyRational(rational(5n, 2n), exactLambda)),
      multiplyRational(rational(3n, 4n), exactLambda),
    ));
    const expected = multiplyRational(gain, rationalFromNumber(amplitude)!);
    assertCorrectRounding(ac.parts.n!.voltage.real, expected, "CMOS small-signal output voltage");
    expect(ac.parts.n!.voltage.imaginary).toBe(0);
  }
});
