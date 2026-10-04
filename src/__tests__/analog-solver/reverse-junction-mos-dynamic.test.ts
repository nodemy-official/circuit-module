import { expect, it } from "vitest";
import { analyzeAnalogCircuit, type AnalogCircuitAnalysis } from "../../analog-solver.js";
import type { CircuitTerminal } from "../../circuit-model.js";
import { simulateTransient, type TransientSample } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

const thermalVoltage = 0.025_85;
const saturationCurrent = 2 ** -20;
const tailCurrent = 2 ** -200;
const stepSeconds = 0.125;
const gateBeta = 1 / 32;
const gateCapacitance = 2 ** -80 / thermalVoltage;
const initialGateMagnitude = 60 * Math.LN2 * thermalVoltage;
const meshBeta = 2 ** -300;
const meshGateMagnitude = 180 * Math.LN2 * thermalVoltage;
const meshOverdrive = meshGateMagnitude - 1;

interface ScalarReading {
  voltage: number;
  current: number;
  power: number;
  terminalVoltages: Partial<Record<CircuitTerminal, number>>;
  terminalCurrents: Partial<Record<CircuitTerminal, number>>;
}

type ScalarReadings = Record<string, ScalarReading>;
type Comparison = readonly [number, number, string];

interface Comparisons {
  relative: readonly Comparison[];
  zero: readonly (readonly [number, string])[];
  residuals: readonly Comparison[];
}

// 読み取りの軸だけを揃える。期待値には製品の演算関数や解析値を使わない。
function analogReadings(analysis: AnalogCircuitAnalysis, axis: "real" | "imaginary" = "real"): ScalarReadings {
  return Object.fromEntries(Object.entries(analysis.parts).map(([id, reading]) => [id, {
    voltage: reading.voltage[axis], current: reading.current[axis], power: reading.power[axis],
    terminalVoltages: Object.fromEntries(Object.entries(reading.terminalVoltages).map(([terminal, value]) => [terminal, value![axis]])),
    terminalCurrents: Object.fromEntries(Object.entries(reading.terminalCurrents).map(([terminal, value]) => [terminal, value![axis]])),
  }]));
}

function transientReadings(sample: TransientSample): ScalarReadings {
  return Object.fromEntries(Object.entries(sample.parts).map(([id, reading]) => [id, {
    voltage: reading.voltageVolts, current: reading.currentAmps, power: reading.powerWatts,
    terminalVoltages: reading.terminalVoltages!, terminalCurrents: reading.terminalCurrents!,
  }]));
}

function gateResidual(magnitude: number): number {
  // 大きいIs同士を引かず、接合の指数尾と容量の履歴項を直接比較する。
  return gateCapacitance * (magnitude - initialGateMagnitude) / stepSeconds
    - saturationCurrent * Math.exp(-magnitude / thermalVoltage) + tailCurrent;
}

function nextGateMagnitude(): number {
  let low = initialGateMagnitude;
  let high = initialGateMagnitude + 1;
  // 微分はC/dt + Is/Vt*exp(-u/Vt)>0で、区間内の根は一意。
  // 指数関数と二分法のbinary64丸めは相対2e-13で検証する。
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (low + high) / 2;
    if (gateResidual(middle) < 0) { low = middle; } else { high = middle; }
  }
  return (low + high) / 2;
}

function gateExpectation(magnitude: number, polarity: number) {
  const overdrive = magnitude - 1;
  const outputMagnitude = 1 / 4 - overdrive ** 2 / 2;
  return {
    magnitude, overdrive, outputMagnitude,
    gateVoltage: polarity * magnitude,
    outputVoltage: polarity * outputMagnitude,
    mosCurrent: polarity * gateBeta * overdrive ** 2 / 2,
    shuntCurrent: polarity * gateBeta * outputMagnitude,
    // 差(u-u0)の相対丸めを容量・履歴抵抗の電流期待へ持ち込まない。
    gateCurrent: polarity * (saturationCurrent * Math.exp(-magnitude / thermalVoltage) - tailCurrent),
    storedEnergy: gateCapacitance * magnitude ** 2 / 2,
    shuntPower: gateBeta * outputMagnitude ** 2,
  };
}

const gateCases = (["nmos", "pmos"] as const).flatMap((kind) =>
  [false, true].flatMap((reverseParts) =>
    (["dc", "transient"] as const).map((mode) => ({ kind, reverseParts, mode })),
  ),
);

function gateSpecs(kind: "nmos" | "pmos", mode: "dc" | "transient"): CircuitSpec[] {
  const polarity = kind === "nmos" ? 1 : -1;
  const junctionNodes = kind === "nmos" ? ["0", "gate"] : ["gate", "0"];
  const specs: CircuitSpec[] = [
    ["ground", "ground", ["0"]],
    ["junction", "diode", junctionNodes, { saturationCurrentAmps: saturationCurrent, emissionCoefficient: 1 }],
    ["cancel", "current-source", junctionNodes, { currentAmps: saturationCurrent }],
    ["tail", "current-source", junctionNodes.toReversed(), { currentAmps: tailCurrent }],
    ["mos", kind, ["out", "gate", "0"], {
      thresholdVolts: 1, transconductanceAmpsPerVoltSquared: gateBeta, channelLengthModulation: 0,
    }],
    ["load", "current-source", kind === "nmos" ? ["0", "out"] : ["out", "0"], { currentAmps: gateBeta / 4 }],
    ["shunt", "resistor", ["out", "0"], { resistanceOhms: 32 }],
    ["gate-meter", "voltmeter", ["gate", "0"]],
    ["out-meter", "voltmeter", ["out", "0"]],
  ];
  if (mode === "dc") {
    // 電池の電圧は正とし、向きで履歴電圧の極性を表す。
    specs.push(
      ["old-bias", "battery", kind === "nmos" ? ["old", "0"] : ["0", "old"], {
        voltageVolts: initialGateMagnitude, internalResistanceOhms: 0,
      }],
      ["history", "resistor", ["gate", "old"], { resistanceOhms: stepSeconds / gateCapacitance }],
    );
  } else {
    specs.push(["history", "capacitor", ["gate", "0"], {
      capacitanceFarads: gateCapacitance, initialVoltageVolts: polarity * initialGateMagnitude,
    }]);
  }
  return specs;
}

function gateComparisons(
  readings: ScalarReadings,
  expected: ReturnType<typeof gateExpectation>,
  polarity: number,
  mode: "dc" | "transient",
): Comparisons {
  const mos = readings.mos!;
  const history = readings.history!;
  const relative: Comparison[] = [
    [readings["gate-meter"]!.voltage, expected.gateVoltage, "gate voltage"],
    [readings["out-meter"]!.voltage, expected.outputVoltage, "out voltage"],
    [readings.junction!.voltage, -expected.magnitude, "reverse junction voltage"],
    [readings.cancel!.current, saturationCurrent, "cancellation source"],
    [readings.tail!.current, tailCurrent, "tail source"],
    [mos.voltage, expected.outputVoltage, "MOS D-S voltage"],
    [mos.current, expected.mosCurrent, "MOS primary current"],
    [mos.terminalVoltages.a!, expected.outputVoltage, "MOS drain voltage"],
    [mos.terminalVoltages.b!, expected.gateVoltage, "MOS gate voltage"],
    [mos.terminalCurrents.a!, expected.mosCurrent, "MOS drain current"],
    [mos.terminalCurrents.c!, -expected.mosCurrent, "MOS source current"],
    [readings.load!.voltage, -expected.outputMagnitude, "load voltage"],
    [readings.load!.current, gateBeta / 4, "load current"],
    [readings.shunt!.voltage, expected.outputVoltage, "shunt voltage"],
    [readings.shunt!.current, expected.shuntCurrent, "shunt current"],
    [readings.shunt!.power, expected.shuntPower, "shunt power"],
    [history.current, expected.gateCurrent, "gate current from independent KCL"],
    [history.terminalVoltages.a!, expected.gateVoltage, "history gate terminal voltage"],
    [history.terminalCurrents.a!, expected.gateCurrent, "history gate terminal current"],
    [history.terminalCurrents.b!, -expected.gateCurrent, "history return terminal current"],
  ];
  const zero: (readonly [number, string])[] = [
    [mos.terminalVoltages.c!, "MOS ground"],
    [mos.terminalCurrents.b!, "MOS gate current"],
    [readings["gate-meter"]!.current, "gate meter current"],
    [readings["out-meter"]!.current, "out meter current"],
  ];
  if (mode === "dc") {
    relative.push(
      [history.voltage, polarity * (expected.magnitude - initialGateMagnitude), "history resistor voltage"],
      [history.terminalVoltages.b!, polarity * initialGateMagnitude, "old voltage"],
      [history.power, expected.gateCurrent ** 2 * stepSeconds / gateCapacitance, "history resistor power"],
      [readings["old-bias"]!.voltage, initialGateMagnitude, "positive history battery"],
    );
  } else {
    relative.push(
      [history.voltage, expected.gateVoltage, "capacitor voltage"],
      [history.power, expected.gateVoltage * expected.gateCurrent, "capacitor power"],
    );
    zero.push([history.terminalVoltages.b!, "capacitor ground"]);
  }
  const loadTerminal = polarity === 1 ? "b" : "a";
  return { relative, zero, residuals: [
    [mos.terminalCurrents.a! + readings.shunt!.current + readings.load!.terminalCurrents[loadTerminal]!, gateBeta / 4, "out KCL"],
  ] };
}

it.each(gateCases)(
  "ゲート容量の履歴を保って$kindの逆飽和尾を解く ($mode, reverseParts=$reverseParts)",
  ({ kind, mode, reverseParts }) => {
    const check = ({ relative, zero, residuals }: Comparisons): void => {
      for (const [actual, expected, label] of relative) {
        expect(Math.abs(actual / expected - 1), label).toBeLessThan(2e-13);
      }
      for (const [actual, label] of zero) { expect(actual, label).toBe(0); }
      for (const [residual, scale, label] of residuals) {
        expect(Math.abs(residual / scale), label).toBeLessThan(2e-13);
      }
    };
    const polarity = kind === "nmos" ? 1 : -1;
    expect(gateResidual(initialGateMagnitude)).toBeLessThan(0);
    expect(gateResidual(initialGateMagnitude + 1)).toBeGreaterThan(0);
    const initial = gateExpectation(initialGateMagnitude, polarity);
    const final = gateExpectation(nextGateMagnitude(), polarity);
    // I_MOS=beta*(u-1)^2/2、x=1/4-(u-1)^2/2は飽和領域の独立解。
    expect(initial.outputMagnitude).toBeGreaterThan(initial.overdrive);
    expect(final.outputMagnitude).toBeGreaterThan(final.overdrive);
    const specs = gateSpecs(kind, mode);
    const document = createCircuitFromSpecs(reverseParts ? specs.toReversed() : specs, "Reverse-junction MOS gate with capacitive history");
    const original = structuredClone(document);
    if (mode === "dc") {
      const analysis = analyzeAnalogCircuit(document, { mode: "dc" });
      expect(analysis.status, analysis.message).toBe("valid");
      check(gateComparisons(analogReadings(analysis), final, polarity, mode));
      expect(document).toEqual(original);
      return;
    }
    const transient = simulateTransient(document, {
      durationSeconds: stepSeconds, timeStepSeconds: stepSeconds, startFromOperatingPoint: false,
    });
    expect(transient.status, transient.message).toBe("valid");
    expect(transient.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, stepSeconds]);
    const capacitorEnergy = transient.energyReadings!.history!;
    const resistorEnergy = transient.energyReadings!.shunt!;
    expect(capacitorEnergy.coefficient).toBe(gateCapacitance);
    expect(capacitorEnergy.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, stepSeconds]);
    expect(resistorEnergy.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, stepSeconds]);
    for (const [index, expected] of [initial, final].entries()) {
      check(gateComparisons(transientReadings(transient.samples[index]!), expected, polarity, mode));
      const stored = capacitorEnergy.samples[index]!.storedJoules!;
      expect(Math.abs(stored / expected.storedEnergy - 1), `${index}: capacitor stored energy`).toBeLessThan(2e-13);
    }
    // 抵抗の積算値は初期・終値の独立電力を用いた台形積分。
    expect(resistorEnergy.samples[0]!.dissipatedJoules).toBe(0);
    const dissipated = stepSeconds * (initial.shuntPower + final.shuntPower) / 2;
    expect(Math.abs(resistorEnergy.samples[1]!.dissipatedJoules! / dissipated - 1)).toBeLessThan(2e-13);
    expect(document).toEqual(original);
  },
);

const meshExponents = [0, 60, 180, 420] as const;
const meshJunctions = [
  { from: 1, to: 0, emission: 1, saturationExponent: 16 },
  { from: 2, to: 0, emission: 3, saturationExponent: 40 },
  { from: 3, to: 0, emission: 2, saturationExponent: 12 },
  { from: 2, to: 1, emission: 2, saturationExponent: 28 },
  { from: 3, to: 2, emission: 4, saturationExponent: 24 },
];

interface MeshCase {
  shuntScale: number;
  lambda: number;
  reverseParts: boolean;
  extraCircuit: boolean;
  mode: "dc" | "ac" | "transient";
}

const meshCases = [0.5, 1].flatMap((shuntScale) =>
  [0, 2].flatMap((lambda) =>
    [false, true].flatMap((reverseParts) =>
      [false, true].flatMap((extraCircuit) =>
        (["dc", "ac", "transient"] as const).map((mode) => ({ shuntScale, lambda, reverseParts, extraCircuit, mode })),
      ),
    ),
  ),
);

function meshExpectation({ shuntScale, lambda }: MeshCase) {
  let low = 0;
  let high = Math.min(meshOverdrive, 0.25 / shuntScale);
  // (overdrive*x-x^2/2)*(1+lambda*x)+shuntScale*x=1/4。
  // 区間内の微分は正。βはKCLから消去して独立に根を求める。
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (low + high) / 2;
    const current = (meshOverdrive * middle - middle ** 2 / 2) * (1 + lambda * middle) + shuntScale * middle;
    if (current < 1 / 4) { low = middle; } else { high = middle; }
  }
  const magnitude = (low + high) / 2;
  const triode = meshOverdrive * magnitude - magnitude ** 2 / 2;
  const conductance = meshBeta * ((meshOverdrive - magnitude) * (1 + lambda * magnitude) + lambda * triode);
  return {
    magnitude, conductance,
    mosCurrent: -meshBeta * triode * (1 + lambda * magnitude),
    shuntCurrent: -meshBeta * shuntScale * magnitude,
  };
}

function meshSpecs(scenario: MeshCase, conductance: number): CircuitSpec[] {
  const specs: CircuitSpec[] = [["ground", "ground", ["n0"]]];
  for (const { from, to, emission, saturationExponent } of meshJunctions) {
    const id = `junction-${from}-${to}`;
    const nodes = [`n${from}`, `n${to}`];
    const saturation = 2 ** -saturationExponent;
    const exponent = (meshExponents[from]! - meshExponents[to]!) / emission;
    specs.push(
      [id, "diode", nodes, { saturationCurrentAmps: saturation, emissionCoefficient: emission }],
      [`cancel-${id}`, "current-source", nodes, { currentAmps: saturation }],
      [`tail-${id}`, "current-source", nodes.toReversed(), { currentAmps: saturation * 2 ** -exponent }],
    );
  }
  specs.push(
    ["mos", "pmos", ["out", "n2", "n0"], {
      thresholdVolts: 1, transconductanceAmpsPerVoltSquared: meshBeta, channelLengthModulation: scenario.lambda,
    }],
    ["load", "current-source", ["out", "n0"], { currentAmps: meshBeta / 4 }],
    ["shunt", "resistor", ["out", "n0"], { resistanceOhms: 1 / (meshBeta * scenario.shuntScale) }],
    ["gate-meter", "voltmeter", ["n2", "n0"]],
    ["out-meter", "voltmeter", ["out", "n0"]],
  );
  if (scenario.extraCircuit) {
    specs.push(
      ["extra-supply", "battery", ["extra", "n0"], { voltageVolts: 2, internalResistanceOhms: 0 }],
      ["extra-load", "resistor", ["extra", "n0"], { resistanceOhms: 512 }],
    );
  }
  if (scenario.mode === "ac") {
    specs.push(
      ["signal", "ac-source", ["u", "n0"], { voltageVolts: 1e-6, frequencyHz: 1, offsetVolts: 0, phaseDegrees: 0 }],
      ["coupling", "capacitor", ["u", "out"], { capacitanceFarads: (conductance + meshBeta * scenario.shuntScale) / (2 * Math.PI) }],
    );
  }
  return specs;
}

function meshDcComparisons(readings: ScalarReadings, expected: ReturnType<typeof meshExpectation>, extraCircuit: boolean): Comparisons {
  const mos = readings.mos!;
  const relative: Comparison[] = [
    [readings["gate-meter"]!.voltage, -meshGateMagnitude, "mesh gate voltage"],
    [readings["out-meter"]!.voltage, -expected.magnitude, "mesh out voltage"],
    [mos.voltage, -expected.magnitude, "mesh MOS D-S voltage"],
    [mos.current, expected.mosCurrent, "mesh MOS primary current"],
    [mos.terminalVoltages.a!, -expected.magnitude, "mesh MOS drain voltage"],
    [mos.terminalVoltages.b!, -meshGateMagnitude, "mesh MOS gate voltage"],
    [mos.terminalCurrents.a!, expected.mosCurrent, "mesh MOS drain current"],
    [mos.terminalCurrents.c!, -expected.mosCurrent, "mesh MOS source current"],
    [readings.shunt!.voltage, -expected.magnitude, "mesh shunt voltage"],
    [readings.shunt!.current, expected.shuntCurrent, "mesh shunt current"],
    [readings.load!.voltage, -expected.magnitude, "mesh load voltage"],
    [readings.load!.current, meshBeta / 4, "mesh independent load"],
  ];
  if (extraCircuit) {
    relative.push(
      [readings["extra-supply"]!.voltage, 2, "extra supply voltage"],
      [readings["extra-supply"]!.current, -1 / 256, "extra supply current"],
      [readings["extra-load"]!.voltage, 2, "extra load voltage"],
      [readings["extra-load"]!.current, 1 / 256, "extra load current"],
    );
  }
  // 各枝の指数尾が個別にcancel/tailと釣り合い、閉路KVLも成立する。
  for (const { from, to } of meshJunctions) {
    const voltage = -(meshExponents[from]! - meshExponents[to]!) * Math.LN2 * thermalVoltage;
    relative.push([readings[`junction-${from}-${to}`]!.voltage, voltage, "mesh junction voltage"]);
  }
  return { relative, zero: [
    [mos.terminalVoltages.c!, "mesh MOS ground"], [mos.terminalCurrents.b!, "mesh MOS gate current"],
  ], residuals: [
    [mos.terminalCurrents.a! + readings.shunt!.current + readings.load!.terminalCurrents.a!, meshBeta / 4, "mesh out KCL"],
  ] };
}

function meshAcComparisons(
  readings: ScalarReadings,
  scenario: MeshCase,
  conductance: number,
  axis: "real" | "imaginary",
): Comparisons {
  const voltage = 0.5e-6;
  const resistorConductance = meshBeta * scenario.shuntScale;
  const couplingCurrent = (conductance + resistorConductance) * voltage;
  const mos = readings.mos!;
  const relative: Comparison[] = [
    [readings["out-meter"]!.voltage, voltage, "AC out voltage"],
    [mos.voltage, voltage, "AC MOS D-S voltage"],
    [mos.current, conductance * voltage, "AC MOS primary current"],
    [mos.terminalVoltages.a!, voltage, "AC MOS drain voltage"],
    [mos.terminalCurrents.a!, conductance * voltage, "AC MOS drain current"],
    [mos.terminalCurrents.c!, -conductance * voltage, "AC MOS source current"],
    [readings.shunt!.voltage, voltage, "AC shunt voltage"],
    [readings.shunt!.current, resistorConductance * voltage, "AC shunt current"],
    [readings.coupling!.voltage, axis === "real" ? voltage : -voltage, "AC capacitor voltage"],
    [readings.coupling!.current, couplingCurrent, "AC capacitor current"],
    [readings.signal!.current, -couplingCurrent, "AC signal current"],
  ];
  const zero: (readonly [number, string])[] = [
    [readings["gate-meter"]!.voltage, "AC gate voltage"],
    [mos.terminalVoltages.b!, "AC MOS gate voltage"], [mos.terminalVoltages.c!, "AC MOS ground"],
    [mos.terminalCurrents.b!, "AC MOS gate current"], [readings.load!.current, "AC independent load increment"],
  ];
  if (scenario.extraCircuit) {
    zero.push(
      [readings["extra-supply"]!.voltage, "AC extra supply voltage"], [readings["extra-supply"]!.current, "AC extra supply current"],
      [readings["extra-load"]!.voltage, "AC extra load voltage"], [readings["extra-load"]!.current, "AC extra load current"],
    );
  }
  for (const { from, to } of meshJunctions) { zero.push([readings[`junction-${from}-${to}`]!.voltage, "AC mesh junction voltage"]); }
  if (axis === "real") { relative.push([readings.signal!.voltage, 1e-6, "AC signal voltage"]); }
  else { zero.push([readings.signal!.voltage, "AC signal quadrature"]); }
  return { relative, zero, residuals: [
    [mos.terminalCurrents.a! + readings.shunt!.current + readings.coupling!.terminalCurrents.b!, couplingCurrent, "AC out KCL"],
  ] };
}

it.each(meshCases)(
  "有限負荷付き5接合メッシュのPMOSを解く ($mode, shuntScale=$shuntScale, lambda=$lambda, reverseParts=$reverseParts, extraCircuit=$extraCircuit)",
  (scenario) => {
    const check = ({ relative, zero, residuals }: Comparisons): void => {
      for (const [actual, expected, label] of relative) {
        expect(Math.abs(actual / expected - 1), label).toBeLessThan(2e-13);
      }
      for (const [actual, label] of zero) { expect(actual, label).toBe(0); }
      for (const [residual, scale, label] of residuals) {
        expect(Math.abs(residual / scale), label).toBeLessThan(2e-13);
      }
    };
    const expected = meshExpectation(scenario);
    expect(expected.magnitude).toBeGreaterThan(0);
    expect(expected.magnitude).toBeLessThan(meshOverdrive);
    const specs = meshSpecs(scenario, expected.conductance);
    const document = createCircuitFromSpecs(scenario.reverseParts ? specs.toReversed() : specs, "Loaded mixed reverse-junction mesh with PMOS control");
    const original = structuredClone(document);
    if (scenario.mode === "transient") {
      const transient = simulateTransient(document, { durationSeconds: stepSeconds, timeStepSeconds: stepSeconds });
      expect(transient.status, transient.message).toBe("valid");
      expect(transient.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, stepSeconds]);
      for (const sample of transient.samples) { check(meshDcComparisons(transientReadings(sample), expected, scenario.extraCircuit)); }
      const shuntEnergy = transient.energyReadings!.shunt!.samples;
      expect(shuntEnergy[0]!.dissipatedJoules).toBe(0);
      const dissipated = meshBeta * scenario.shuntScale * expected.magnitude ** 2 * stepSeconds;
      expect(Math.abs(shuntEnergy[1]!.dissipatedJoules! / dissipated - 1)).toBeLessThan(2e-13);
      expect(document).toEqual(original);
      return;
    }
    const analysis = analyzeAnalogCircuit(document, scenario.mode === "ac" ? { mode: "ac", frequencyHz: 1 } : { mode: "dc" });
    expect(analysis.status, analysis.message).toBe("valid");
    if (scenario.mode === "dc") {
      check(meshDcComparisons(analogReadings(analysis), expected, scenario.extraCircuit));
    } else {
      // omega*C=gMOS+gRなのでVout/U=j/(1+j)=(1+j)/2。
      // MOS自身の電流はgMOS*Voutで、並列抵抗の分は加えない。
      for (const axis of ["real", "imaginary"] as const) {
        check(meshAcComparisons(analogReadings(analysis, axis), scenario, expected.conductance, axis));
      }
    }
    expect(document).toEqual(original);
  },
);
