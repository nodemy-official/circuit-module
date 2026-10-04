import { expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { restoredComplex } from "../../circuit-reading.js";
import { exactComplexValue } from "../../exact-numeric-state.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";
import { addRational, compareRational, multiplyRational, rational, rationalFromNumber, subtractRational, type Rational } from "../helpers/numeric-oracle.js";

const thermalVoltage = 0.025_85;

it.each([
  [0, 40, 100, 300],
  [0, 80, 220, 500],
  [0, 20, 100, 600],
].flatMap((ks) => [false, true].flatMap((reversed) =>
  (["dc", "transient"] as const).map((mode) => ({ ks, reversed, mode })),
)))("solves a four-node complete reverse-junction mesh ($mode, ks=$ks, reversed=$reversed)", ({ ks, reversed, mode }) => {
  const saturation = 2 ** -20;
  const junctions = ks.flatMap((ki, i) => ks.slice(0, i).map((kj, j) => ({
    id: `d${i}${j}`, nodes: [`n${i}`, `n${j}`], exponent: ki - kj,
  })));
  const specs: CircuitSpec[] = [["ground", "ground", ["n0"]]];
  for (const { id, nodes, exponent } of junctions) {
    specs.push(
      [id, "diode", nodes, { saturationCurrentAmps: saturation }],
      [`reverse-${id}`, "current-source", nodes, { currentAmps: saturation }],
      [`tail-${id}`, "current-source", nodes.toReversed(), { currentAmps: saturation * 2 ** -exponent }],
    );
  }
  const document = createCircuitFromSpecs(reversed ? specs.toReversed() : specs, "A complete mesh with unequal reverse-current scales");
  // I + Is = Is * exp(V/Vt) = Is * 2^-(ki-kj) balances every branch
  // at V(ni) = -ki * ln(2) * Vt. Positive junction derivatives make the
  // grounded solution unique. All expectations use independent equations.
  const checkJunction = (id: string, exponent: number, voltage: number, exactCurrent: Rational) => {
    const expectedVoltage = -exponent * Math.LN2 * thermalVoltage;
    expect(Math.abs(voltage / expectedVoltage - 1), `${id} voltage`).toBeLessThan(2e-13);
    // A rounded -Is current cannot reveal whether the much smaller tail survived.
    const actualTail = addRational(exactCurrent, rational(1n, 2n ** 20n));
    const expectedTail = rational(1n, 2n ** BigInt(20 + exponent));
    const error = subtractRational(actualTail, expectedTail);
    const magnitude = rational(error.numerator < 0n ? -error.numerator : error.numerator, error.denominator);
    const bound = multiplyRational(expectedTail, rationalFromNumber(2e-12)!);
    expect(compareRational(magnitude, bound), `${id} exact current + Is`).toBeLessThanOrEqual(0);
  };
  if (mode === "dc") {
    const dc = analyzeAnalogCircuit(document);
    expect(dc.status, dc.message).toBe("valid");
    for (const { id, exponent } of junctions) {
      const reading = dc.parts[id]!;
      checkJunction(id, exponent, reading.voltage.real, exactComplexValue(reading.current)!.real);
    }
    return;
  }
  const transient = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
  expect(transient.status, transient.message).toBe("valid");
  expect(transient.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, 0.125]);
  for (const sample of transient.samples) {
    for (const { id, exponent } of junctions) {
      const reading = sample.parts[id]!;
      const current = restoredComplex(reading.exactTerminalCurrents?.a, transient.precisionExpressions);
      checkJunction(id, exponent, reading.voltageVolts,
        current ? exactComplexValue(current)!.real : rationalFromNumber(reading.currentAmps)!,
      );
    }
  }
});

it.each([200, 500].flatMap((exponent) => [false, true].map((extra) => ({ exponent, extra }))))(
  "resolves a triangular reverse-junction loop independently of a separate circuit (2^-$exponent, extra=$extra)", ({ exponent, extra }) => {
    const saturation = 2 ** -20;
    const firstTail = saturation * 2 ** -exponent;
    const directTail = saturation * 2 ** (-2 * exponent);
    const expected = -exponent * Math.LN2 * thermalVoltage;
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["reverse", "current-source", ["x", "0"], { currentAmps: 2 * saturation }],
      ["tail", "current-source", ["0", "x"], { currentAmps: firstTail }],
      ["tail2", "current-source", ["0", "x"], { currentAmps: directTail }],
      ["first", "diode", ["x", "y"], { saturationCurrentAmps: saturation }],
      ["second", "diode", ["y", "0"], { saturationCurrentAmps: saturation }],
      ["direct", "diode", ["x", "0"], { saturationCurrentAmps: saturation }],
      ...(extra ? [
        ["other-supply", "battery", ["v", "0"], { voltageVolts: 4 }] as CircuitSpec,
        ["other-load", "resistor", ["v", "z"], { resistanceOhms: 1000 }] as CircuitSpec,
        ["other-junction", "diode", ["z", "0"]] as CircuitSpec,
      ] : []),
    ];
    for (const ordered of [specs, specs.toReversed()]) {
      const document = createCircuitFromSpecs(ordered, "A direct junction in parallel with two series junctions");
      const dc = analyzeAnalogCircuit(document);
      expect(dc.status, dc.message).toBe("valid");
      const transient = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
      expect(transient.status, transient.message).toBe("valid");
      const ac = analyzeAnalogCircuit(createCircuitFromSpecs([
        ...ordered,
        ["drive", "ac-source", ["u", "0"], { voltageVolts: 1e-6, offsetVolts: 0, frequencyHz: 1 }],
        ["cap", "capacitor", ["u", "x"], { capacitanceFarads: (firstTail / (2 * thermalVoltage) + directTail / thermalVoltage) / (2 * Math.PI) }],
      ], "Triangular reverse-junction AC transfer"), { mode: "ac", frequencyHz: 1 });
      expect(ac.status, ac.message).toBe("valid");
      for (const id of ["first", "second", "direct"]) {
        const factor = id === "direct" ? 2 : 1;
        expect(Math.abs(dc.parts[id]!.voltage.real / (expected * factor) - 1)).toBeLessThan(2e-13);
        for (const sample of transient.samples) {
          expect(Math.abs(sample.parts[id]!.voltageVolts / (expected * factor) - 1)).toBeLessThan(2e-13);
        }
        expect(Math.abs(ac.parts[id]!.voltage.real / (2.5e-7 * factor) - 1)).toBeLessThan(2e-12);
        expect(Math.abs(ac.parts[id]!.voltage.imaginary / (2.5e-7 * factor) - 1)).toBeLessThan(2e-12);
      }
    }
  },
);

it.each((["diode", "npn-transistor", "pnp-transistor"] as const).flatMap((kind) =>
  [2, 3].flatMap((count) => [200, 500].flatMap((exponent) =>
    [false, true].flatMap((reversed) => (["dc", "ac", "transient"] as const).map((mode) =>
      ({ kind, count, exponent, reversed, mode }))),
  )),
))("resolves coupled parallel branches of $count series $kind junctions ($mode, 2^-$exponent, reversed=$reversed)", ({ kind, count, exponent, reversed, mode }) => {
  const bjt = kind !== "diode";
  const sign = kind === "pnp-transistor" ? -1 : 1;
  const coefficient = bjt ? 2 : 1;
  const saturation = 2 ** -20;
  const tail = saturation * 2 ** -exponent;
  const idealities = Array.from({ length: count }, (_, index) => bjt ? 1 : index % 2 + 1);
  const totalIdeality = idealities.reduce((sum, ideality) => sum + ideality, 0);
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["reverse", "current-source", ["x", "0"], { currentAmps: sign * 2 * coefficient * saturation }],
    ["tail", "current-source", ["0", "x"], { currentAmps: sign * 2 * coefficient * tail }],
  ];
  for (const branch of [0, 1]) {
    for (const [index, ideality] of idealities.entries()) {
      const first = index === 0 ? "x" : `b${branch}n${index}`;
      const last = index + 1 === count ? "0" : `b${branch}n${index + 1}`;
      specs.push([`b${branch}d${index}`, bjt ? kind : index % 2 ? "led" : "diode",
        bjt ? [first, first, last] : [first, last], { saturationCurrentAmps: saturation, currentGain: 1, emissionCoefficient: ideality }]);
    }
  }
  const ordered = reversed ? specs.toReversed() : specs;
  const document = createCircuitFromSpecs(ordered, "Two equal series-junction branches sharing a reverse-current source");
  if (mode === "dc") {
    const dc = analyzeAnalogCircuit(document);
    expect(dc.status, dc.message).toBe("valid");
    for (const branch of [0, 1]) {
      for (const [index, ideality] of idealities.entries()) {
        const id = `b${branch}d${index}`;
        const expected = -sign * exponent * Math.LN2 * thermalVoltage * ideality;
        expect(Math.abs(dc.parts[id]!.voltage.real / expected - 1)).toBeLessThan(2e-13);
      }
    }
    return;
  }
  if (mode === "ac") {
    const ac = analyzeAnalogCircuit(createCircuitFromSpecs([
      ...ordered,
      ["drive", "ac-source", ["u", "0"], { voltageVolts: 1e-6, offsetVolts: 0, frequencyHz: 1 }],
      ["cap", "capacitor", ["u", "x"], { capacitanceFarads: 2 * coefficient * tail / (totalIdeality * thermalVoltage * 2 * Math.PI) }],
    ], "Coupled parallel-series reverse junctions in AC"), { mode: "ac", frequencyHz: 1 });
    expect(ac.status, ac.message).toBe("valid");
    for (const branch of [0, 1]) {
      for (const [index, ideality] of idealities.entries()) {
        const id = `b${branch}d${index}`;
        expect(Math.abs(ac.parts[id]!.voltage.real / (5e-7 * ideality / totalIdeality) - 1)).toBeLessThan(2e-12);
        expect(Math.abs(ac.parts[id]!.voltage.imaginary / (5e-7 * ideality / totalIdeality) - 1)).toBeLessThan(2e-12);
      }
    }
    return;
  }
  const transient = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
  expect(transient.status, transient.message).toBe("valid");
  for (const branch of [0, 1]) {
    for (const [index, ideality] of idealities.entries()) {
      const id = `b${branch}d${index}`;
      const expected = -sign * exponent * Math.LN2 * thermalVoltage * ideality;
      for (const sample of transient.samples) {
        expect(Math.abs(sample.parts[id]!.voltageVolts / expected - 1)).toBeLessThan(2e-13);
      }
    }
  }
});

it.each((["nmos", "pmos"] as const).flatMap((kind) => [200, 500].map((exponent) => ({ kind, exponent }))))(
  "does not pin a reverse-junction voltage connected to the gate of a tied $kind channel (2^-$exponent)", ({ kind, exponent }) => {
    const sign = kind === "nmos" ? 1 : -1;
    const saturation = 2 ** -20;
    const tail = saturation * 2 ** -exponent;
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["reverse", "current-source", ["x", "0"], { currentAmps: sign * saturation }],
      ["tail", "current-source", ["0", "x"], { currentAmps: sign * tail }],
      ["junction", "diode", sign === 1 ? ["x", "0"] : ["0", "x"], { saturationCurrentAmps: saturation }],
      ["channel", kind, ["0", "x", "0"], { thresholdVolts: 1, transconductanceAmpsPerVoltSquared: 1 / 32 }],
    ];
    for (const ordered of [specs, specs.toReversed()]) {
      const document = createCircuitFromSpecs(ordered, "A reverse junction biasing a zero-drop MOS gate");
      const dc = analyzeAnalogCircuit(document);
      expect(dc.status, dc.message).toBe("valid");
      const expected = -exponent * Math.LN2 * thermalVoltage;
      expect(Math.abs(dc.parts.junction!.voltage.real / expected - 1)).toBeLessThan(2e-13);
      expect(dc.parts.channel!.current.real).toBe(0);
      const transient = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
      expect(transient.status, transient.message).toBe("valid");
      for (const sample of transient.samples) {
        expect(Math.abs(sample.parts.junction!.voltageVolts / expected - 1)).toBeLessThan(2e-13);
        expect(sample.parts.channel!.currentAmps).toBe(0);
      }
      const ac = analyzeAnalogCircuit(createCircuitFromSpecs([
        ...ordered,
        ["drive", "ac-source", ["u", "0"], { voltageVolts: 1e-6, offsetVolts: 0, frequencyHz: 1 }],
        ["cap", "capacitor", ["u", "x"], { capacitanceFarads: tail / (thermalVoltage * 2 * Math.PI) }],
      ], "A reverse junction driving a tied MOS gate in AC"), { mode: "ac", frequencyHz: 1 });
      expect(ac.status, ac.message).toBe("valid");
      expect(Math.abs(ac.parts.reverse!.voltage.real / 5e-7 - 1)).toBeLessThan(2e-12);
      expect(Math.abs(ac.parts.reverse!.voltage.imaginary / 5e-7 - 1)).toBeLessThan(2e-12);
    }
  },
);

it.each([2, 3, 4].flatMap((count) => [200, 500].map((exponent) => ({ count, exponent }))))(
  "preserves previously polished drops in a $count-junction reverse series chain (2^-$exponent)", ({ count, exponent }) => {
    const saturation = 2 ** -20;
    const tail = saturation * 2 ** -exponent;
    const idealities = Array.from({ length: count }, (_, index) => index % 2 + 1);
    const totalIdeality = idealities.reduce((sum, ideality) => sum + ideality, 0);
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["reverse", "current-source", ["n0", "0"], { currentAmps: saturation }],
      ["tail", "current-source", ["0", "n0"], { currentAmps: tail }],
      ...idealities.map((ideality, index): CircuitSpec => [
        `junction${index}`, index % 2 ? "led" : "diode", [`n${index}`, index + 1 === count ? "0" : `n${index + 1}`],
        { saturationCurrentAmps: saturation, emissionCoefficient: ideality },
      ]),
    ];
    for (const ordered of [specs, specs.toReversed()]) {
      const document = createCircuitFromSpecs(ordered, "A reverse-current source through several series junctions");
      const dc = analyzeAnalogCircuit(document);
      expect(dc.status, dc.message).toBe("valid");
      const transient = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
      expect(transient.status, transient.message).toBe("valid");
      const ac = analyzeAnalogCircuit(createCircuitFromSpecs([
        ...ordered,
        ["drive", "ac-source", ["u", "0"], { voltageVolts: 1e-6, offsetVolts: 0, frequencyHz: 1 }],
        ["cap", "capacitor", ["u", "n0"], { capacitanceFarads: tail / (totalIdeality * thermalVoltage * 2 * Math.PI) }],
      ], "Reverse series-junction AC transfer"), { mode: "ac", frequencyHz: 1 });
      expect(ac.status, ac.message).toBe("valid");
      for (const [index, ideality] of idealities.entries()) {
        const id = `junction${index}`;
        const expected = -exponent * Math.LN2 * thermalVoltage * ideality;
        expect(Math.abs(dc.parts[id]!.voltage.real / expected - 1)).toBeLessThan(2e-13);
        for (const sample of transient.samples) {
          expect(Math.abs(sample.parts[id]!.voltageVolts / expected - 1)).toBeLessThan(2e-13);
        }
        expect(Math.abs(ac.parts[id]!.voltage.real / (5e-7 * ideality / totalIdeality) - 1)).toBeLessThan(2e-12);
        expect(Math.abs(ac.parts[id]!.voltage.imaginary / (5e-7 * ideality / totalIdeality) - 1)).toBeLessThan(2e-12);
      }
    }
  },
);

it.each([200, 500].flatMap((exponent) => [1, 2].flatMap((secondIdeality) =>
  [false, true].map((shunted) => ({ exponent, secondIdeality, shunted })),
)))("combines parallel reverse junctions before inverting their KCL (2^-$exponent, n2=$secondIdeality, shunt=$shunted)", ({ exponent, secondIdeality, shunted }) => {
  const saturation = 2 ** -20;
  const firstTail = saturation * 2 ** (-exponent * secondIdeality);
  const secondTail = saturation * 2 ** -exponent;
  const expectedVoltage = -exponent * secondIdeality * Math.LN2 * thermalVoltage;
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["reverse", "current-source", ["x", "0"], { currentAmps: 2 * saturation }],
    ["first-tail", "current-source", ["0", "x"], { currentAmps: firstTail }],
    ["second-tail", "current-source", ["0", "x"], { currentAmps: secondTail }],
    ["first", "diode", ["x", "0"], { saturationCurrentAmps: saturation, emissionCoefficient: 1 }],
    ["second", "led", ["x", "0"], { saturationCurrentAmps: saturation, emissionCoefficient: secondIdeality }],
    ...(shunted ? [
      ["shunt", "resistor", ["x", "0"], { resistanceOhms: 1 / (32 * secondTail) }] as CircuitSpec,
      ["shunt-tail", "current-source", ["0", "x"], { currentAmps: 32 * secondTail * expectedVoltage }] as CircuitSpec,
    ] : []),
  ];
  const conductance = firstTail / thermalVoltage + secondTail / (secondIdeality * thermalVoltage) + (shunted ? 32 * secondTail : 0);
  for (const ordered of [specs, specs.toReversed()]) {
    const document = createCircuitFromSpecs(ordered, "Parallel reverse junctions sharing a uniquely determined voltage");
    const dc = analyzeAnalogCircuit(document);
    expect(dc.status, dc.message).toBe("valid");
    expect(Math.abs(dc.parts.first!.voltage.real / expectedVoltage - 1)).toBeLessThan(2e-13);
    const transient = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
    expect(transient.status, transient.message).toBe("valid");
    for (const sample of transient.samples) {
      expect(Math.abs(sample.parts.first!.voltageVolts / expectedVoltage - 1)).toBeLessThan(2e-13);
    }
    const ac = analyzeAnalogCircuit(createCircuitFromSpecs([
      ...ordered,
      ["drive", "ac-source", ["u", "0"], { voltageVolts: 1e-6, offsetVolts: 0, frequencyHz: 1 }],
      ["cap", "capacitor", ["u", "x"], { capacitanceFarads: conductance / (2 * Math.PI) }],
    ], "Parallel reverse-junction small-signal transfer"), { mode: "ac", frequencyHz: 1 });
    expect(ac.status, ac.message).toBe("valid");
    expect(Math.abs(ac.parts.first!.voltage.real / 5e-7 - 1)).toBeLessThan(2e-12);
    expect(Math.abs(ac.parts.first!.voltage.imaginary / 5e-7 - 1)).toBeLessThan(2e-12);
  }
});

it.each([200, 500].flatMap((exponent) => [false, true].flatMap((shunted) =>
  [0.7, 1.3].map((factor) => ({ exponent, shunted, factor })),
)))("polishes all independent reverse junctions regardless of part order (2^-$exponent, shunt=$shunted, factor=$factor)", ({ exponent, shunted, factor }) => {
  const saturation = 2 ** -20;
  const firstTail = saturation * 2 ** -200;
  const firstVoltage = -200 * Math.LN2 * thermalVoltage;
  const secondVoltage = (-exponent * Math.LN2 + Math.log(factor)) * thermalVoltage;
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["reverse", "current-source", ["x", "0"], { currentAmps: saturation }],
    ["tail", "current-source", ["0", "x"], { currentAmps: firstTail * (shunted ? 1 + firstVoltage : 1) }],
    ["first", "diode", ["x", "0"], { saturationCurrentAmps: saturation }],
    ...(shunted ? [["shunt", "resistor", ["x", "0"], { resistanceOhms: 1 / firstTail }] as CircuitSpec] : []),
    ["reverse2", "current-source", ["y", "0"], { currentAmps: saturation }],
    ["tail2", "current-source", ["0", "y"], { currentAmps: saturation * 2 ** -exponent * factor }],
    ["second", "diode", ["y", "0"], { saturationCurrentAmps: saturation }],
  ];
  for (const ordered of [specs, specs.toReversed()]) {
    const document = createCircuitFromSpecs(ordered, "Independent reverse junctions with different rounded exponential roots");
    const dc = analyzeAnalogCircuit(document);
    expect(dc.status, dc.message).toBe("valid");
    expect(Math.abs(dc.parts.first!.voltage.real / firstVoltage - 1)).toBeLessThan(2e-13);
    expect(Math.abs(dc.parts.second!.voltage.real / secondVoltage - 1)).toBeLessThan(2e-13);
    const transient = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
    expect(transient.status, transient.message).toBe("valid");
    for (const sample of transient.samples) {
      expect(Math.abs(sample.parts.first!.voltageVolts / firstVoltage - 1)).toBeLessThan(2e-13);
      expect(Math.abs(sample.parts.second!.voltageVolts / secondVoltage - 1)).toBeLessThan(2e-13);
    }
    const conductance = firstTail * (1 / thermalVoltage + (shunted ? 1 : 0));
    const ac = analyzeAnalogCircuit(createCircuitFromSpecs([
      ...ordered,
      ["drive", "ac-source", ["u", "0"], { voltageVolts: 1e-6, offsetVolts: 0, frequencyHz: 1 }],
      ["cap", "capacitor", ["u", "x"], { capacitanceFarads: conductance / (2 * Math.PI) }],
    ], "Independent reverse junctions in small-signal AC"), { mode: "ac", frequencyHz: 1 });
    expect(ac.status, ac.message).toBe("valid");
    expect(Math.abs(ac.parts.first!.voltage.real / 5e-7 - 1)).toBeLessThan(2e-12);
    expect(Math.abs(ac.parts.first!.voltage.imaginary / 5e-7 - 1)).toBeLessThan(2e-12);
  }
});

it.each((["diode", "led", "npn-transistor", "pnp-transistor"] as const).flatMap((kind) =>
  [[100, -1000], [500, -600], [1000, -1000], [500, -1074]].map(([saturationExponent, tailExponent]) =>
    ({ kind, saturationExponent: saturationExponent!, tailExponent: tailExponent! })),
))("retains the $kind scaled exponential tail after exp underflows (Is=2^$saturationExponent, tail=2^$tailExponent)", ({ kind, saturationExponent, tailExponent }) => {
  const bjt = kind === "npn-transistor" || kind === "pnp-transistor";
  const sign = kind === "pnp-transistor" ? -1 : 1;
  const coefficient = bjt ? 2 : 1;
  const ideality = kind === "led" ? 2 : 1;
  const saturation = 2 ** saturationExponent;
  const tail = 2 ** tailExponent;
  const expectedVoltage = -sign * (saturationExponent - tailExponent) * Math.LN2 * ideality * thermalVoltage;
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["reverse", "current-source", ["x", "0"], { currentAmps: sign * coefficient * saturation }],
    ["tail", "current-source", ["0", "x"], { currentAmps: sign * coefficient * tail }],
    ["device", kind, bjt ? ["x", "x", "0"] : ["x", "0"], {
      saturationCurrentAmps: saturation, emissionCoefficient: ideality, currentGain: 1,
    }],
  ];
  for (const ordered of [specs, specs.toReversed()]) {
    const document = createCircuitFromSpecs(ordered, "A representable current tail with an unrepresentable exponential coefficient");
    const dc = analyzeAnalogCircuit(document);
    expect(dc.status, dc.message).toBe("valid");
    expect(Math.abs(dc.parts.device!.voltage.real / expectedVoltage - 1)).toBeLessThan(2e-13);
    // Inspect the exact current with an independent rational oracle. A
    // binary64 -Is reading alone cannot show whether its tail was retained.
    const actualTail = addRational(exactComplexValue(dc.parts.device!.current)!.real, rationalFromNumber(sign * saturation)!);
    const error = subtractRational(actualTail, rationalFromNumber(sign * tail)!);
    const magnitude = rational(error.numerator < 0n ? -error.numerator : error.numerator, error.denominator);
    expect(compareRational(magnitude, multiplyRational(rationalFromNumber(tail)!, rationalFromNumber(2e-12)!))).toBe(-1);
    const transient = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
    expect(transient.status, transient.message).toBe("valid");
    expect(transient.samples.map((sample) => sample.parts.device!.voltageVolts))
      .toEqual(transient.samples.map(() => dc.parts.device!.voltage.real));
    const capacitance = coefficient * tail / (ideality * thermalVoltage * 2 * Math.PI);
    const ac = analyzeAnalogCircuit(createCircuitFromSpecs([
      ...ordered,
      ["drive", "ac-source", ["u", "0"], { voltageVolts: 1e-6, offsetVolts: 0, frequencyHz: 1 }],
      ["cap", "capacitor", ["u", "x"], { capacitanceFarads: capacitance }],
    ], "Scaled reverse-tail AC transfer"), { mode: "ac", frequencyHz: 1 });
    expect(ac.status, ac.message).toBe("valid");
    // Include the actual subnormal C parameter's quantization independently.
    const ratio = (capacitance / tail) * (2 * Math.PI * ideality * thermalVoltage) / coefficient;
    const denominator = 1 + ratio * ratio;
    expect(Math.abs(ac.parts.device!.voltage.real / (1e-6 * ratio * ratio / denominator) - 1)).toBeLessThan(2e-12);
    expect(Math.abs(ac.parts.device!.voltage.imaginary / (1e-6 * ratio / denominator) - 1)).toBeLessThan(2e-12);
  }
});

it.each((["diode", "led", "npn-transistor", "pnp-transistor"] as const).flatMap((kind) =>
  [200, 500].flatMap((exponent) => [0.125, 1, 32, 1024].map((shuntRatio) => ({ kind, exponent, shuntRatio }))),
))("updates the parallel resistance with the $kind reverse-tail voltage (2^-$exponent, shunt=$shuntRatio)", ({ kind, exponent, shuntRatio }) => {
  const bjt = kind === "npn-transistor" || kind === "pnp-transistor";
  const sign = kind === "pnp-transistor" ? -1 : 1;
  const coefficient = bjt ? 2 : 1;
  const ideality = kind === "led" ? 2 : 1;
  const thermal = thermalVoltage * ideality;
  const saturation = 2 ** -20;
  const tail = coefficient * saturation * 2 ** -exponent;
  const nominal = -exponent * Math.LN2 * thermal;
  const targetCurrent = tail * (1 + shuntRatio * nominal);
  // Independently bisect the dimensionless physical KCL equation. Scaling
  // out the saturation cancellation retains its tail without solver helpers.
  let low = nominal - 1;
  let high = nominal + 1;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (low + high) / 2;
    const residual = Math.exp(middle / thermal + exponent * Math.LN2) + shuntRatio * middle - targetCurrent / tail;
    if (residual > 0) { high = middle; } else { low = middle; }
  }
  const expectedVoltage = sign * (low + high) / 2;
  const conductance = tail * (1 / thermal + shuntRatio);
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["reverse", "current-source", ["x", "0"], { currentAmps: sign * coefficient * saturation }],
    ["tail", "current-source", ["0", "x"], { currentAmps: sign * targetCurrent }],
    ["device", kind, bjt ? ["x", "tied", "0"] : ["x", "0"], {
      saturationCurrentAmps: saturation, currentGain: 1, emissionCoefficient: ideality,
    }],
    ["shunt", "resistor", ["x", "0"], { resistanceOhms: 1 / (tail * shuntRatio) }],
    ...(bjt ? [["tie", "ammeter", ["x", "tied"]] as CircuitSpec] : []),
  ];
  for (const ordered of [specs, specs.toReversed()]) {
    const document = createCircuitFromSpecs(ordered, "A weak reverse junction in parallel with a finite resistance");
    const dc = analyzeAnalogCircuit(document);
    expect(dc.status, dc.message).toBe("valid");
    expect(Math.abs(dc.parts.device!.voltage.real / expectedVoltage - 1)).toBeLessThan(2e-13);
    expect(Math.abs(dc.parts.shunt!.current.real / (expectedVoltage * tail * shuntRatio) - 1)).toBeLessThan(2e-13);
    const transient = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
    expect(transient.status, transient.message).toBe("valid");
    for (const sample of transient.samples) {
      expect(Math.abs(sample.parts.device!.voltageVolts / expectedVoltage - 1)).toBeLessThan(2e-13);
    }
    const ac = analyzeAnalogCircuit(createCircuitFromSpecs([
      ...ordered,
      ["drive", "ac-source", ["u", "0"], { voltageVolts: 1e-6, offsetVolts: 0, frequencyHz: 1 }],
      ["cap", "capacitor", ["u", "x"], { capacitanceFarads: conductance / (2 * Math.PI) }],
    ], "A weak shunted junction in small-signal AC"), { mode: "ac", frequencyHz: 1 });
    expect(ac.status, ac.message).toBe("valid");
    expect(Math.abs(ac.parts.device!.voltage.real / 5e-7 - 1)).toBeLessThan(2e-12);
    expect(Math.abs(ac.parts.device!.voltage.imaginary / 5e-7 - 1)).toBeLessThan(2e-12);
  }
});

it.each((["npn-transistor", "pnp-transistor"] as const).flatMap((kind) =>
  (["collector-base", "base-emitter", "collector-emitter"] as const).flatMap((tie) =>
    (["ammeter", "switch", "ac-source"] as const).flatMap((connection) =>
      [200, 500].map((exponent) => ({ kind, tie, connection, exponent })))),
))("preserves the $kind reverse tail through a $connection $tie tie (2^-$exponent)", ({ kind, tie, connection, exponent }) => {
  const sign = kind === "pnp-transistor" ? -1 : 1;
  const beta = tie === "collector-base" ? 0.25 : 4;
  const coefficient = tie === "base-emitter" ? 2 : 1 + 1 / beta;
  const saturation = 2 ** -20;
  const nodes = tie === "collector-base" ? ["x", "tied", "0"] : ["0", "x", "tied"];
  const endpoints = tie === "collector-base" || tie === "base-emitter" ? ["x", "tied"] : ["0", "tied"];
  const expectedVoltage = -sign * exponent * Math.LN2 * thermalVoltage;
  const conductance = coefficient * saturation * 2 ** -exponent / thermalVoltage;
  for (const reversed of [false, true]) {
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["reverse", "current-source", ["x", "0"], { currentAmps: sign * coefficient * saturation }],
      ["tail", "current-source", ["0", "x"], { currentAmps: sign * coefficient * saturation * 2 ** -exponent }],
      ["device", kind, nodes, { saturationCurrentAmps: saturation, currentGain: beta }],
      ["tie", connection, reversed ? endpoints.toReversed() : endpoints, { voltageVolts: 0, offsetVolts: 0, frequencyHz: 1, closed: true }],
    ];
    const ordered = reversed ? specs.toReversed() : specs;
    const document = createCircuitFromSpecs(ordered, "A passive BJT junction joined by an ideal zero-voltage branch");
    const dc = analyzeAnalogCircuit(document);
    expect(dc.status, dc.message).toBe("valid");
    expect(Math.abs(dc.parts.reverse!.voltage.real / expectedVoltage - 1)).toBeLessThan(2e-13);
    expect(dc.parts.tie!.voltage.real).toBe(0);
    const transient = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
    expect(transient.status, transient.message).toBe("valid");
    for (const sample of transient.samples) {
      expect(Math.abs(sample.parts.reverse!.voltageVolts / expectedVoltage - 1)).toBeLessThan(2e-13);
    }
    const ac = analyzeAnalogCircuit(createCircuitFromSpecs([
      ...ordered,
      ["drive", "ac-source", ["u", "0"], { voltageVolts: 1e-6, offsetVolts: 0, frequencyHz: 1 }],
      ["cap", "capacitor", ["u", "x"], { capacitanceFarads: conductance / (2 * Math.PI) }],
    ], "The same tied BJT junction in small-signal AC"), { mode: "ac", frequencyHz: 1 });
    expect(ac.status, ac.message).toBe("valid");
    expect(Math.abs(ac.parts.reverse!.voltage.real / 5e-7 - 1)).toBeLessThan(2e-12);
    expect(Math.abs(ac.parts.reverse!.voltage.imaginary / 5e-7 - 1)).toBeLessThan(2e-12);
  }
});

it.each([false, true])("polishes a weak CMOS output beside a reverse junction without repeatedly selecting the same junction root (reversed=$0)", (reversed) => {
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["reverse", "current-source", ["x", "0"], { currentAmps: 2 ** -20 }],
    ["tail", "current-source", ["0", "x"], { currentAmps: 2 ** -220 }],
    ["diode", "diode", ["x", "0"], { saturationCurrentAmps: 2 ** -20 }],
    ["supply", "battery", ["v", "0"], { voltageVolts: 5 }],
    ["input", "ac-source", ["in", "0"], { voltageVolts: 0, offsetVolts: 2.5, frequencyHz: 1 }],
    ["n", "nmos", ["out", "in", "0"], { thresholdVolts: 1, transconductanceAmpsPerVoltSquared: 1 / 32, channelLengthModulation: 1e-20 }],
    ["p", "pmos", ["out", "in", "v"], { thresholdVolts: 1, transconductanceAmpsPerVoltSquared: 1 / 32, channelLengthModulation: 1e-20 }],
  ];
  const document = createCircuitFromSpecs(reversed ? specs.toReversed() : specs, "Two independent weak nonlinear outputs");
  const dc = analyzeAnalogCircuit(document);
  expect(dc.status, dc.message).toBe("valid");
  expect(dc.parts.n!.voltage.real).toBe(2.5);
  expect(Math.abs(dc.parts.diode!.voltage.real / (-200 * Math.LN2 * thermalVoltage) - 1)).toBeLessThan(2e-13);
  const transient = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
  expect(transient.status, transient.message).toBe("valid");
  for (const sample of transient.samples) { expect(sample.parts.n!.voltageVolts).toBe(2.5); }
});

it.each((["diode", "led", "npn-transistor", "pnp-transistor"] as const).flatMap((kind) =>
  [24, 40, 53].flatMap((exponent) => [2 ** -500, 2 ** -20, 2 ** 500].map((saturation) => ({ kind, exponent, saturation }))),
))("resolves a reverse-biased $kind close to saturation (exponent=$exponent, Is=$saturation)", ({ kind, exponent, saturation }) => {
  const bjt = kind === "npn-transistor" || kind === "pnp-transistor";
  const sign = kind === "pnp-transistor" ? -1 : 1;
  const factor = bjt ? 2 : 1;
  const tail = 2 ** -exponent;
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["source", "current-source", ["x", "0"], { currentAmps: sign * factor * saturation * (1 - tail) }],
    ["device", kind, bjt ? ["x", "x", "0"] : ["x", "0"], {
      saturationCurrentAmps: saturation, emissionCoefficient: 1, currentGain: 1,
    }],
  ];
  // I=-factor*Is*(1-2^-exponent) gives exp(V/Vt)=2^-exponent.
  // Invert the physical equation independently; the error bound permits
  // the existing binary64 exp/log boundary, not an error in the small tail.
  const expectedVoltage = -sign * exponent * Math.LN2 * thermalVoltage;
  const expectedConductance = factor * saturation * tail / thermalVoltage;
  for (const ordered of [specs, specs.toReversed()]) {
    const document = createCircuitFromSpecs(ordered, "Reverse saturation with a uniquely determined bias");
    const dc = analyzeAnalogCircuit(document);
    expect(dc.status, dc.message).toBe("valid");
    expect(Math.abs(dc.parts.device!.voltage.real / expectedVoltage - 1)).toBeLessThan(2e-13);
    expect(dc.parts.device!.current.real).toBe(-sign * saturation * (1 - tail));
    const transient = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
    expect(transient.status, transient.message).toBe("valid");
    for (const sample of transient.samples) {
      expect(Math.abs(sample.parts.device!.voltageVolts / expectedVoltage - 1)).toBeLessThan(2e-13);
    }
    const acDocument = createCircuitFromSpecs([
      ...ordered,
      ["drive", "ac-source", ["u", "0"], { voltageVolts: 1e-6, offsetVolts: 0, frequencyHz: 1 }],
      ["cap", "capacitor", ["u", "x"], { capacitanceFarads: expectedConductance / (2 * Math.PI) }],
    ], "Reverse saturation small-signal transfer");
    const ac = analyzeAnalogCircuit(acDocument, { mode: "ac", frequencyHz: 1 });
    expect(ac.status, ac.message).toBe("valid");
    // |Y_C|=g, so Vx/Vdrive=j/(1+j)=(1+j)/2. The coefficient
    // formation and exponential approximations are bounded relatively.
    expect(Math.abs(ac.parts.device!.voltage.real / 5e-7 - 1)).toBeLessThan(2e-12);
    expect(Math.abs(ac.parts.device!.voltage.imaginary / 5e-7 - 1)).toBeLessThan(2e-12);
  }
});

it.each((["diode", "led", "npn-transistor", "pnp-transistor"] as const).flatMap((kind) =>
  [200, 500].flatMap((exponent) => [2 ** -500, 2 ** -20, 2 ** 500].map((saturation) => ({ kind, exponent, saturation }))),
))("resolves the $kind bias when separate currents cancel to a 2^-$exponent tail (Is=$saturation)", ({ kind, exponent, saturation }) => {
  const bjt = kind === "npn-transistor" || kind === "pnp-transistor";
  const sign = kind === "pnp-transistor" ? -1 : 1;
  const factor = bjt ? 2 : 1;
  const tail = saturation * 2 ** -exponent;
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["reverse", "current-source", ["x", "0"], { currentAmps: sign * factor * saturation }],
    ["tail", "current-source", ["0", "x"], { currentAmps: sign * factor * tail }],
    ["device", kind, bjt ? ["x", "x", "0"] : ["x", "0"], {
      saturationCurrentAmps: saturation, emissionCoefficient: 1, currentGain: 1,
    }],
  ];
  const expectedVoltage = -sign * exponent * Math.LN2 * thermalVoltage;
  const conductance = factor * tail / thermalVoltage;
  for (const ordered of [specs, specs.toReversed()]) {
    const document = createCircuitFromSpecs(ordered, "A reverse junction fixed by a tiny independent source");
    const dc = analyzeAnalogCircuit(document);
    expect(dc.status, dc.message).toBe("valid");
    expect(Math.abs(dc.parts.device!.voltage.real / expectedVoltage - 1)).toBeLessThan(2e-13);
    const transient = simulateTransient(document, { durationSeconds: 0.125, timeStepSeconds: 0.125 });
    expect(transient.status, transient.message).toBe("valid");
    for (const sample of transient.samples) {
      expect(Math.abs(sample.parts.device!.voltageVolts / expectedVoltage - 1)).toBeLessThan(2e-13);
    }
    const ac = analyzeAnalogCircuit(createCircuitFromSpecs([
      ...ordered,
      ["drive", "ac-source", ["u", "0"], { voltageVolts: 1e-6, offsetVolts: 0, frequencyHz: 1 }],
      ["cap", "capacitor", ["u", "x"], { capacitanceFarads: conductance / (2 * Math.PI) }],
    ], "A small reverse junction tail determining the AC transfer"), { mode: "ac", frequencyHz: 1 });
    expect(ac.status, ac.message).toBe("valid");
    expect(Math.abs(ac.parts.device!.voltage.real / 5e-7 - 1)).toBeLessThan(2e-12);
    expect(Math.abs(ac.parts.device!.voltage.imaginary / 5e-7 - 1)).toBeLessThan(2e-12);
  }
});
