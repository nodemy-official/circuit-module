import { expect, it } from "vitest";
import { analyzeAnalogCircuit, type AnalogCircuitAnalysis } from "../../analog-solver.js";
import { simulateTransient, type TransientSample } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

type MosKind = "nmos" | "pmos";

const thermalVoltage = 0.025_85;
const saturationCurrent = 2 ** -20;
const tailCurrent = 2 ** -200;
const threshold = 1;
const gateMagnitude = 180 * Math.LN2 * thermalVoltage;
const overdrive = gateMagnitude - threshold;

// ゲートKCL: Is * exp(-|Vg|/Vt) = 2^-200, Is = 2^-20。
// MOS二乗則と抵抗のKCL: (overdrive + shuntScale) * x - x^2/2 = 1/4。
// x = |Vloaded|、MOS電流の絶対値はbeta/4 - beta*shuntScale*x。
// 小さい根を有理化し、近い値の減算を避ける。Mathによる独立式を
// binary64で評価する丸め誤差は、相対2e-13の範囲で比較する。
interface MosCase {
  kind: MosKind;
  beta: number;
  swapDrainSource: boolean;
  shuntScale: number;
}

function loadedBiasExpectation({ beta, shuntScale }: MosCase) {
  const u = overdrive + shuntScale;
  const loadedMagnitude = 0.5 / (u + Math.sqrt(u ** 2 - 0.5));
  const shuntCurrent = beta * shuntScale * loadedMagnitude;
  return { loadedMagnitude, shuntCurrent, channelCurrent: beta / 4 - shuntCurrent };
}

const cases = (["nmos", "pmos"] as const).flatMap((kind) =>
  [2 ** -300, 1 / 32].flatMap((beta) =>
    [0, 1, 2, 32].flatMap((shuntScale) =>
      [false, true].flatMap((swapDrainSource) =>
        [false, true].flatMap((reverseParts) =>
          (["dc", "ac", "transient"] as const).map((mode) => ({
            kind, beta, swapDrainSource, reverseParts, mode, shuntScale,
          })),
        ),
      ),
    ),
  ),
);

function loadedMosSpecs(
  { kind, beta, swapDrainSource, shuntScale }: MosCase,
  gateNode = "gate",
  referenceNode = "0",
): CircuitSpec[] {
  const specs: CircuitSpec[] = [
    ["mos", kind, swapDrainSource
      ? [referenceNode, gateNode, "loaded"]
      : ["loaded", gateNode, referenceNode], {
      thresholdVolts: threshold,
      transconductanceAmpsPerVoltSquared: beta,
      channelLengthModulation: 0,
    }],
    ["load", "current-source", kind === "nmos"
      ? [referenceNode, "loaded"] : ["loaded", referenceNode], {
      currentAmps: beta / 4,
    }],
    ["gate-meter", "voltmeter", [gateNode, referenceNode]],
    ["loaded-meter", "voltmeter", ["loaded", referenceNode]],
  ];
  if (shuntScale > 0) {
    specs.push(["shunt", "resistor", ["loaded", referenceNode], {
      resistanceOhms: 1 / (shuntScale * beta),
    }]);
  }
  return specs;
}

function reverseJunctionMosSpecs(scenario: MosCase): CircuitSpec[] {
  const junctionNodes = scenario.kind === "pmos" ? ["gate", "0"] : ["0", "gate"];
  return [
    ["ground", "ground", ["0"]],
    ["junction", "diode", junctionNodes, {
      saturationCurrentAmps: saturationCurrent, emissionCoefficient: 1,
    }],
    ["cancel", "current-source", junctionNodes, { currentAmps: saturationCurrent }],
    ["tail", "current-source", junctionNodes.toReversed(), { currentAmps: tailCurrent }],
    ...loadedMosSpecs(scenario),
  ];
}

interface BiasComparisons {
  relative: readonly (readonly [number, number, string])[];
  zero: readonly number[];
}

function dcBiasComparisons(analysis: AnalogCircuitAnalysis, scenario: MosCase): BiasComparisons {
  const polarity = scenario.kind === "nmos" ? 1 : -1;
  const orientation = polarity * (scenario.swapDrainSource ? -1 : 1);
  const mos = analysis.parts.mos!;
  const loadedTerminal = scenario.swapDrainSource ? "c" : "a";
  const groundedTerminal = scenario.swapDrainSource ? "a" : "c";
  const { loadedMagnitude, channelCurrent, shuntCurrent } = loadedBiasExpectation(scenario);
  const relative: [number, number, string][] = [
    [analysis.parts["gate-meter"]!.voltage.real, polarity * gateMagnitude, "DC gate"],
    [analysis.parts["loaded-meter"]!.voltage.real, polarity * loadedMagnitude, "DC loaded"],
    [mos.voltage.real, orientation * loadedMagnitude, "DC MOS D-S voltage"],
    [mos.current.real, orientation * channelCurrent, "DC MOS D current"],
    [mos.terminalVoltages.b!.real, polarity * gateMagnitude, "DC MOS gate terminal"],
    [mos.terminalCurrents[loadedTerminal]!.real, polarity * channelCurrent, "DC loaded current"],
    [mos.terminalCurrents[groundedTerminal]!.real, -polarity * channelCurrent, "DC return current"],
    [analysis.parts.load!.current.real, scenario.beta / 4, "DC independent load"],
  ];
  if (scenario.shuntScale > 0) {
    relative.push(
      [analysis.parts.shunt!.voltage.real, polarity * loadedMagnitude, "DC shunt voltage"],
      [analysis.parts.shunt!.current.real, polarity * shuntCurrent, "DC shunt current"],
    );
  }
  return {
    relative,
    zero: [mos.terminalVoltages[groundedTerminal]!.real, mos.terminalCurrents.b!.real],
  };
}

function transientBiasComparisons(sample: TransientSample, scenario: MosCase): BiasComparisons {
  const polarity = scenario.kind === "nmos" ? 1 : -1;
  const orientation = polarity * (scenario.swapDrainSource ? -1 : 1);
  const mos = sample.parts.mos!;
  const loadedTerminal = scenario.swapDrainSource ? "c" : "a";
  const groundedTerminal = scenario.swapDrainSource ? "a" : "c";
  const { loadedMagnitude, channelCurrent, shuntCurrent } = loadedBiasExpectation(scenario);
  const relative: [number, number, string][] = [
    [sample.parts["gate-meter"]!.voltageVolts, polarity * gateMagnitude, "transient gate"],
    [sample.parts["loaded-meter"]!.voltageVolts, polarity * loadedMagnitude, "transient loaded"],
    [mos.voltageVolts, orientation * loadedMagnitude, "transient MOS D-S voltage"],
    [mos.currentAmps, orientation * channelCurrent, "transient MOS D current"],
    [mos.terminalVoltages!.b!, polarity * gateMagnitude, "transient MOS gate terminal"],
    [mos.terminalCurrents![loadedTerminal]!, polarity * channelCurrent, "transient loaded current"],
    [mos.terminalCurrents![groundedTerminal]!, -polarity * channelCurrent, "transient return current"],
    [sample.parts.load!.currentAmps, scenario.beta / 4, "transient independent load"],
  ];
  if (scenario.shuntScale > 0) {
    relative.push(
      [sample.parts.shunt!.voltageVolts, polarity * loadedMagnitude, "transient shunt voltage"],
      [sample.parts.shunt!.currentAmps, polarity * shuntCurrent, "transient shunt current"],
    );
  }
  return {
    relative,
    zero: [mos.terminalVoltages![groundedTerminal]!, mos.terminalCurrents!.b!],
  };
}

const capacitorCases = (["nmos", "pmos"] as const).flatMap((kind) =>
  [2 ** -300, 1 / 32].flatMap((beta) =>
    [false, true].flatMap((swapDrainSource) =>
      [false, true].map((reverseParts) => ({
        kind, beta, swapDrainSource, reverseParts, shuntScale: 1,
      })),
    ),
  ),
);

function capacitorBiasComparisons(
  sample: TransientSample,
  scenario: MosCase,
  magnitude: number,
  capacitorCurrent: number,
): BiasComparisons {
  const polarity = scenario.kind === "nmos" ? 1 : -1;
  const orientation = polarity * (scenario.swapDrainSource ? -1 : 1);
  const loadedTerminal = scenario.swapDrainSource ? "c" : "a";
  const groundedTerminal = scenario.swapDrainSource ? "a" : "c";
  const loadTerminal = scenario.kind === "nmos" ? "b" : "a";
  const channelCurrent = scenario.beta * (overdrive * magnitude - magnitude ** 2 / 2);
  const voltage = polarity * magnitude;
  const mos = sample.parts.mos!;
  const capacitor = sample.parts["output-capacitor"]!;
  const comparisons: [number, number, string][] = [
    [sample.parts["gate-meter"]!.voltageVolts, polarity * gateMagnitude, "charging gate"],
    [sample.parts["loaded-meter"]!.voltageVolts, voltage, "charging loaded"],
    [mos.voltageVolts, orientation * magnitude, "charging MOS D-S voltage"],
    [mos.currentAmps, orientation * channelCurrent, "charging MOS D current"],
    [mos.terminalVoltages![loadedTerminal]!, voltage, "charging MOS loaded voltage"],
    [mos.terminalVoltages![groundedTerminal]!, 0, "charging MOS ground"],
    [mos.terminalVoltages!.b!, polarity * gateMagnitude, "charging MOS gate voltage"],
    [mos.terminalCurrents![loadedTerminal]!, polarity * channelCurrent, "charging MOS loaded current"],
    [mos.terminalCurrents![groundedTerminal]!, -polarity * channelCurrent, "charging MOS return current"],
    [mos.terminalCurrents!.b!, 0, "charging MOS gate current"],
    [sample.parts.shunt!.voltageVolts, voltage, "charging shunt voltage"],
    [sample.parts.shunt!.currentAmps, polarity * scenario.beta * magnitude, "charging shunt current"],
    [sample.parts.load!.currentAmps, scenario.beta / 4, "charging independent load"],
    [sample.parts.load!.terminalCurrents![loadTerminal]!, -polarity * scenario.beta / 4, "charging load terminal current"],
    [capacitor.voltageVolts, voltage, "charging capacitor voltage"],
    [capacitor.currentAmps, capacitorCurrent, "charging capacitor current"],
    [capacitor.terminalVoltages!.a!, voltage, "charging capacitor loaded voltage"],
    [capacitor.terminalVoltages!.b!, 0, "charging capacitor ground"],
    [capacitor.terminalCurrents!.a!, capacitorCurrent, "charging capacitor loaded current"],
    [capacitor.terminalCurrents!.b!, -capacitorCurrent, "charging capacitor return current"],
    [capacitor.powerWatts, voltage * capacitorCurrent, "charging capacitor power"],
  ];
  const relative: [number, number, string][] = [];
  const zero: number[] = [];
  for (const [actual, expected, label] of comparisons) {
    if (expected === 0) {
      zero.push(actual);
    } else {
      relative.push([actual, expected, label]);
    }
  }
  return { relative, zero };
}

it.each(cases)(
  "逆飽和接合が端子独立$kindをバイアスする ($mode, beta=$beta, shuntScale=$shuntScale, swapDrainSource=$swapDrainSource, reverseParts=$reverseParts)",
  (scenario) => {
    const expectRelative = (actual: number, expected: number, label: string): void => {
      expect(Math.abs(actual / expected - 1), label).toBeLessThan(2e-13);
    };
    const expectBias = ({ relative, zero }: BiasComparisons): void => {
      for (const [actual, expected, label] of relative) {
        expectRelative(actual, expected, label);
      }
      for (const actual of zero) {
        expect(actual).toBe(0);
      }
    };
    // NMOSはPMOSの全電位と電流方向を反転する。loadedは端子交換後も
    // 元の物理ドレインであり、部品のprimary読み取りだけがD/S交換で反転する。
    const specs = reverseJunctionMosSpecs(scenario);

    // CはDC開放、信号源のoffsetは0なので、ACを追加しても元のバイアスは同じ。
    const { loadedMagnitude } = loadedBiasExpectation(scenario);
    const conductance = scenario.beta * (overdrive - loadedMagnitude);
    const shuntConductance = scenario.beta * scenario.shuntScale;
    if (scenario.mode === "ac") {
      specs.push(
        ["signal", "ac-source", ["u", "0"], {
          voltageVolts: 1e-6, offsetVolts: 0, frequencyHz: 1, phaseDegrees: 0,
        }],
        ["coupling", "capacitor", ["u", "loaded"], {
          capacitanceFarads: (conductance + shuntConductance) / (2 * Math.PI),
        }],
      );
    }
    const document = createCircuitFromSpecs(
      scenario.reverseParts ? specs.toReversed() : specs,
      "Reverse-junction bias for a terminal-independent MOS channel",
    );

    if (scenario.mode === "dc") {
      const analysis = analyzeAnalogCircuit(document, { mode: "dc" });
      expect(analysis.status, analysis.message).toBe("valid");
      expectBias(dcBiasComparisons(analysis, scenario));
      return;
    }
    if (scenario.mode === "transient") {
      const transient = simulateTransient(document, {
        durationSeconds: 0.125, timeStepSeconds: 0.125,
      });
      expect(transient.status, transient.message).toBe("valid");
      expect(transient.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, 0.125]);
      for (const sample of transient.samples) {
        expectBias(transientBiasComparisons(sample, scenario));
      }
      return;
    }

    const analysis = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1 });
    expect(analysis.status, analysis.message).toBe("valid");
    const mos = analysis.parts.mos!;
    const orientation = scenario.swapDrainSource ? -1 : 1;
    const loadedTerminal = scenario.swapDrainSource ? "c" : "a";
    const groundedTerminal = scenario.swapDrainSource ? "a" : "c";
    // 独立電流源の増分とMOSゲート電流は0なのでδVg=0。
    // loadedの節点式: (g+gR)*V + j*omega*C*(V-U)=0。
    // omega*C=g+gRよりV/U=j/(1+j)=(1+j)/2。MOS電流はg*Vのみ。
    // PMOSでも増分gは正で、
    // primary電流の符号はDCの極性ではなくD/S端子交換だけで変わる。
    for (const axis of ["real", "imaginary"] as const) {
      expectRelative(analysis.parts["loaded-meter"]!.voltage[axis], 0.5e-6, `AC loaded ${axis}`);
      expectRelative(mos.voltage[axis], orientation * 0.5e-6, `AC MOS D-S voltage ${axis}`);
      expectRelative(mos.current[axis], orientation * conductance * 0.5e-6, `AC MOS D current ${axis}`);
      expectRelative(mos.terminalVoltages[loadedTerminal]![axis], 0.5e-6, `AC loaded terminal ${axis}`);
      expectRelative(mos.terminalCurrents[loadedTerminal]![axis], conductance * 0.5e-6, `AC loaded current ${axis}`);
      expectRelative(mos.terminalCurrents[groundedTerminal]![axis], -conductance * 0.5e-6, `AC return current ${axis}`);
      if (scenario.shuntScale > 0) {
        expectRelative(analysis.parts.shunt!.voltage[axis], 0.5e-6, `AC shunt voltage ${axis}`);
        expectRelative(analysis.parts.shunt!.current[axis], shuntConductance * 0.5e-6, `AC shunt current ${axis}`);
      }
      expect(analysis.parts["gate-meter"]!.voltage[axis]).toBe(0);
      expect(mos.terminalVoltages.b![axis]).toBe(0);
      expect(mos.terminalVoltages[groundedTerminal]![axis]).toBe(0);
      expect(mos.terminalCurrents.b![axis]).toBe(0);
      expect(analysis.parts.load!.current[axis]).toBe(0);
    }
  },
);

it.each(capacitorCases)(
  "逆飽和接合の$kindゲートを維持して出力コンデンサを充電する (beta=$beta, swapDrainSource=$swapDrainSource, reverseParts=$reverseParts)",
  (scenario) => {
    const dt = 2 ** -10;
    const capacitance = scenario.beta * dt;
    const specs: CircuitSpec[] = [
      ...reverseJunctionMosSpecs(scenario),
      ["output-capacitor", "capacitor", ["loaded", "0"], {
        capacitanceFarads: capacitance, initialVoltageVolts: 0,
      }],
    ];
    const document = createCircuitFromSpecs(
      scenario.reverseParts ? specs.toReversed() : specs,
      "Reverse-junction MOS gate during output-capacitor charging",
    );
    const original = structuredClone(document);
    const transient = simulateTransient(document, {
      durationSeconds: 2 * dt, timeStepSeconds: dt, startFromOperatingPoint: false,
    });
    expect(transient.status, transient.message).toBe("valid");
    expect(transient.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, dt, 2 * dt]);
    const energy = transient.energyReadings!["output-capacitor"]!;
    expect(energy.coefficient).toBe(capacitance);
    expect(energy.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, dt, 2 * dt]);

    const polarity = scenario.kind === "nmos" ? 1 : -1;
    const loadedTerminal = scenario.swapDrainSource ? "c" : "a";
    const loadTerminal = scenario.kind === "nmos" ? "b" : "a";
    let previous = 0;
    // C/dt=beta、gR=betaより後退Eulerの独立KCLは
    // (overdrive+2)*x - x^2/2 = 1/4 + x_prev。
    // 期待値は前の期待値から更新し、解析結果を次の期待値に使わない。
    for (const [index, sample] of transient.samples.entries()) {
      let magnitude = 0;
      if (index > 0) {
        const q = 1 / 4 + previous;
        const u = overdrive + 2;
        magnitude = 2 * q / (u + Math.sqrt(u ** 2 - 2 * q));
      }
      // loadedへ流入する負荷電流を、端子aで受ける初期コンデンサ電流は
      // +polarity*beta/4。逆端子bの電流は-polarity*beta/4となる。
      const capacitorCurrent = index === 0
        ? polarity * scenario.beta / 4
        : polarity * scenario.beta * (magnitude - previous);
      const comparisons = capacitorBiasComparisons(sample, scenario, magnitude, capacitorCurrent);
      for (const [actual, expected, label] of comparisons.relative) {
        expect(Math.abs(actual / expected - 1), `${index}: ${label}`).toBeLessThan(2e-13);
      }
      for (const actual of comparisons.zero) {
        expect(actual).toBe(0);
      }
      const expectedEnergy = capacitance * magnitude ** 2 / 2;
      const storedEnergy = energy.samples[index]!.storedJoules!;
      if (expectedEnergy === 0) {
        expect(storedEnergy).toBe(0);
      } else {
        expect(Math.abs(storedEnergy / expectedEnergy - 1), `${index}: capacitor stored energy`).toBeLessThan(2e-13);
      }
      // betaを一度だけ含む電流・電力・エネルギーの期待値は、今回の
      // beta=2^-300でも正規化数の範囲にある。初期電力・エネルギーは厳密に0。
      // KCLは独立の負荷電流beta/4で正規化し、微小値を絶対誤差で隠さない。
      const currentSum = sample.parts.mos!.terminalCurrents![loadedTerminal]!
        + sample.parts.shunt!.currentAmps
        + sample.parts["output-capacitor"]!.currentAmps
        + sample.parts.load!.terminalCurrents![loadTerminal]!;
      expect(Math.abs(currentSum / (scenario.beta / 4)), `${index}: loaded KCL`).toBeLessThan(2e-13);
      previous = magnitude;
    }
    expect(document).toEqual(original);
  },
);

it.each(["nmos", "pmos"] as const)(
  "固定した閾値ゲートの%sは同じ非零負荷を流せず、初期推定が理想電圧拘束を変えない",
  (kind) => {
    const specs: CircuitSpec[] = [
      ["ground", "ground", ["0"]],
      ["fixed-gate", "battery", kind === "nmos" ? ["gate", "0"] : ["0", "gate"], {
        voltageVolts: threshold, internalResistanceOhms: 0,
      }],
      ...loadedMosSpecs({ kind, beta: 2 ** -300, swapDrainSource: false, shuntScale: 0 }),
    ];
    const document = createCircuitFromSpecs(specs, "An ideal gate fixed at the MOS threshold");
    const original = structuredClone(document);
    // |Vgs|=Vthを理想電池が固定する。負荷が要求する向きではチャネル電流は
    // 常に0であり、beta/4 > 0とのKCLを満たす解はない。
    const analysis = analyzeAnalogCircuit(document, { mode: "dc" });
    expect(analysis.status, analysis.message).toBe("invalid");
    expect(document).toEqual(original);
  },
);

const meshCases = [false, true].flatMap((reverseParts) =>
  (["dc", "transient"] as const).map((mode) => ({ reverseParts, mode })),
);

it.each(meshCases)(
  "混合放出係数・Isの5接合閉路が端子独立PMOSをバイアスする ($mode, reverseParts=$reverseParts)",
  ({ reverseParts, mode }) => {
    const expectRelative = (actual: number, expected: number, label: string): void => {
      expect(Math.abs(actual / expected - 1), label).toBeLessThan(2e-13);
    };
    const expectBias = ({ relative, zero }: BiasComparisons): void => {
      for (const [actual, expected, label] of relative) {
        expectRelative(actual, expected, label);
      }
      for (const actual of zero) {
        expect(actual).toBe(0);
      }
    };
    // 独立レビューの再現: V(ni)=-ki*ln(2)*Vt。
    // 各枝はIs*exp((Vi-Vj)/(n*Vt))=Is*2^-((ki-kj)/n)で個別に平衡し、
    // 閉路のKVLも満たす。正の接合微分と接地によりゲート側の解は一意。
    const nodeExponents = [0, 60, 180, 420] as const;
    const junctions = [
      { from: 1, to: 0, emission: 1, saturationExponent: 16 },
      { from: 2, to: 0, emission: 3, saturationExponent: 40 },
      { from: 3, to: 0, emission: 2, saturationExponent: 12 },
      { from: 2, to: 1, emission: 2, saturationExponent: 28 },
      { from: 3, to: 2, emission: 4, saturationExponent: 24 },
    ];
    const specs: CircuitSpec[] = [["ground", "ground", ["n0"]]];
    for (const { from, to, emission, saturationExponent } of junctions) {
      const id = `junction-${from}-${to}`;
      const nodes = [`n${from}`, `n${to}`];
      const saturation = 2 ** -saturationExponent;
      const exponent = (nodeExponents[from]! - nodeExponents[to]!) / emission;
      specs.push(
        [id, "diode", nodes, { saturationCurrentAmps: saturation, emissionCoefficient: emission }],
        [`cancel-${id}`, "current-source", nodes, { currentAmps: saturation }],
        [`tail-${id}`, "current-source", nodes.toReversed(), { currentAmps: saturation * 2 ** -exponent }],
      );
    }
    const scenario = { kind: "pmos", beta: 2 ** -300, swapDrainSource: false, shuntScale: 0 } as const;
    specs.push(
      ...loadedMosSpecs(scenario, "n2", "n0"),
      ["extra-supply", "battery", ["extra", "n0"], { voltageVolts: 2, internalResistanceOhms: 0 }],
      ["extra-load", "resistor", ["extra", "n0"], { resistanceOhms: 512 }],
    );
    const document = createCircuitFromSpecs(
      reverseParts ? specs.toReversed() : specs,
      "Five mixed reverse junctions driving a terminal-independent PMOS gate",
    );
    if (mode === "dc") {
      const analysis = analyzeAnalogCircuit(document, { mode: "dc" });
      expect(analysis.status, analysis.message).toBe("valid");
      expectBias(dcBiasComparisons(analysis, scenario));
      for (const { from, to } of junctions) {
        const expected = -(nodeExponents[from]! - nodeExponents[to]!) * Math.LN2 * thermalVoltage;
        expectRelative(analysis.parts[`junction-${from}-${to}`]!.voltage.real, expected, "DC mesh junction");
      }
      expect(analysis.parts["extra-load"]!.voltage.real).toBe(2);
      expect(analysis.parts["extra-load"]!.current.real).toBe(1 / 256);
      return;
    }

    const transient = simulateTransient(document, {
      durationSeconds: 0.125, timeStepSeconds: 0.125,
    });
    expect(transient.status, transient.message).toBe("valid");
    expect(transient.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, 0.125]);
    for (const sample of transient.samples) {
      expectBias(transientBiasComparisons(sample, scenario));
      for (const { from, to } of junctions) {
        const expected = -(nodeExponents[from]! - nodeExponents[to]!) * Math.LN2 * thermalVoltage;
        expectRelative(sample.parts[`junction-${from}-${to}`]!.voltageVolts, expected, "transient mesh junction");
      }
      expect(sample.parts["extra-load"]!.voltageVolts).toBe(2);
      expect(sample.parts["extra-load"]!.currentAmps).toBe(1 / 256);
    }
  },
);
