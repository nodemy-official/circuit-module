import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

interface BiasOptions {
  kind: "nmos" | "pmos";
  reverse?: boolean;
  initial?: boolean;
  scale?: number;
  current?: number;
  lambda?: number;
}

function fixedGateSpecs({ kind, reverse = false, initial = false, scale = 1, current = scale, lambda = 0 }: BiasOptions): CircuitSpec[] {
  const sign = kind === "nmos" ? 1 : -1;
  return [
    ["ground", "ground", ["0"]],
    ["gate", "ac-source", ["gate", "0"], { voltageVolts: 0, offsetVolts: sign * 3 }],
    ["mos", kind, reverse ? ["0", "gate", "drain"] : ["drain", "gate", "0"], {
      thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 2 * scale, channelLengthModulation: lambda,
    }],
    ...(initial ? [
      ["supply", "ac-source", ["supply", "0"], { voltageVolts: 0, offsetVolts: sign * 10 }],
      ["current", "inductor", ["supply", "drain"], { inductanceHenries: 1 / scale, initialCurrentAmps: sign * current }],
    ] satisfies CircuitSpec[] : [
      ["current", "current-source", ["0", "drain"], { currentAmps: sign * current }],
    ] satisfies CircuitSpec[]),
  ];
}

const biasCases = (["nmos", "pmos"] as const).flatMap((kind) =>
  [false, true].flatMap((reverse) => [false, true].flatMap((initial) =>
    [2 ** -1000, 1, 2 ** 900].map((scale) => ({ kind, reverse, initial, scale })),
  )),
);

const orientations = (["nmos", "pmos"] as const).flatMap((kind) =>
  [false, true].map((reverse) => ({ kind, reverse })),
);

describe("MOS current feasibility", () => {
  it.each(biasCases)("rejects a current above saturation ($kind, reverse=$reverse, initial=$initial, scale=$scale)", (bias) => {
    // Exact dyadic inputs: beta/2 * (3-2)^2 = scale. The excess is
    // scale * 2^-40, independently of the solver's arithmetic helpers.
    const document = createCircuitFromSpecs(fixedGateSpecs({ ...bias, current: bias.scale * (1 + 2 ** -40) }), "Impossible MOS current");
    for (const parts of [document.parts, document.parts.toReversed()]) {
      const result = analyzeAnalogCircuit({ ...document, parts }, { mode: "dc", initialInductorCurrents: bias.initial });
      expect(result.status, result.message).toBe("invalid");
      expect(result.message).not.toContain("理想電圧源のループ");
    }
  });

  it.each(biasCases)("allows the saturation endpoint ($kind, reverse=$reverse, initial=$initial, scale=$scale)", (bias) => {
    const document = createCircuitFromSpecs(fixedGateSpecs(bias), "Exact MOS saturation endpoint");
    const result = analyzeAnalogCircuit(document, { mode: "dc", initialInductorCurrents: bias.initial });
    expect(result.status, result.message).toBe("valid");
    const sign = (bias.kind === "nmos" ? 1 : -1) * (bias.reverse ? -1 : 1);
    expect(Math.abs(result.parts.mos!.current.real / (sign * bias.scale) - 1)).toBeLessThan(1e-12);
  });

  it.each(biasCases)("allows a triode current below the bound ($kind, reverse=$reverse, initial=$initial, scale=$scale)", (bias) => {
    const document = createCircuitFromSpecs(fixedGateSpecs({ ...bias, current: 0.75 * bias.scale }), "MOS triode current");
    const result = analyzeAnalogCircuit(document, { mode: "dc", initialInductorCurrents: bias.initial });
    expect(result.status, result.message).toBe("valid");
    // beta * (U*Vds - Vds^2/2) = scale * 3/4 at U=1, Vds=1/2.
    const sign = (bias.kind === "nmos" ? 1 : -1) * (bias.reverse ? -1 : 1);
    expect(Math.abs(result.parts.mos!.voltage.real / (sign * 0.5) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(result.parts.mos!.current.real / (sign * 0.75 * bias.scale) - 1)).toBeLessThan(1e-12);
  });

  it.each(biasCases.filter(({ initial }) => !initial))("resolves a DC voltage at the flat MOS knee ($kind, reverse=$reverse, scale=$scale)", (bias) => {
    const sign = bias.kind === "nmos" ? 1 : -1;
    const orientation = sign * (bias.reverse ? -1 : 1);
    for (const junction of [false, true]) {
      for (const fraction of [1 - 2 ** -52, 1]) {
        const current = bias.scale * fraction;
        const specs = fixedGateSpecs({ ...bias, current }).filter(([id]) => !junction || id !== "gate");
        if (junction) {
          specs.push(
            ["bias", "ac-source", ["bias", "0"], { voltageVolts: 0, offsetVolts: sign * 3 }],
            ["q", sign === 1 ? "npn-transistor" : "pnp-transistor", ["split", "bias", "gate"], { saturationCurrentAmps: 0.01, currentGain: 100 }],
            ["tie1", "ac-source", ["split", "middle"], { voltageVolts: 0, offsetVolts: sign * 0.125 }],
            ["tie2", "ac-source", ["middle", "gate"], { voltageVolts: 0, offsetVolts: -sign * 0.125 }],
          );
        }
        for (const parts of [specs, specs.toReversed()]) {
          const result = analyzeAnalogCircuit(createCircuitFromSpecs(parts, "DC MOS knee"));
          expect(result.status, result.message).toBe("valid");
          expect(result.parts.mos!.current.real).toBe(orientation * current);
          // I/scale = 2*V - V^2 = 1-(1-V)^2. The dyadic current
          // 1-2^-52 has the exactly representable triode root 1-2^-26.
          // At I/scale=1, every valid operating point instead has V>=1.
          const voltage = orientation * result.parts.mos!.voltage.real;
          if (fraction < 1) { expect(voltage).toBe(1 - 2 ** -26); }
          else { expect(voltage).toBeGreaterThanOrEqual(1); }
        }
      }
    }
  });

  it.each(orientations)("uses the resolved knee in small-signal AC ($kind, reverse=$reverse)", (bias) => {
    const sign = bias.kind === "nmos" ? 1 : -1;
    const orientation = sign * (bias.reverse ? -1 : 1);
    const amplitude = 2 ** -30;
    for (const current of [1 - 2 ** -52, 1]) {
      const specs = fixedGateSpecs({ ...bias, current }).map((spec): CircuitSpec =>
        spec[0] === "gate" ? ["gate", "ac-source", sign === 1 ? ["gate", "0"] : ["0", "gate"], { voltageVolts: amplitude, offsetVolts: 3 }] : spec,
      );
      for (const parts of [specs, specs.toReversed()]) {
        const result = analyzeAnalogCircuit(createCircuitFromSpecs(parts, "AC MOS knee"), { mode: "ac", frequencyHz: 1000 });
        if (current === 1) {
          // At saturation gds=0: a varying gate cannot preserve the current
          // imposed by an ideal DC source, so the small-signal system has no solution.
          expect(result.status, result.message).toBe("invalid");
        } else {
          expect(result.status, result.message).toBe("valid");
          // At Vds=1-2^-26, -gm/gds=-(2^26-1). All inputs are dyadic.
          expect(result.parts.mos!.voltage.real).toBe(-orientation * (2 ** 26 - 1) * amplitude);
          expect(result.parts.mos!.voltage.imaginary).toBe(0);
        }
      }
    }
  });

  it.each(orientations)("does not bound the opposite current direction ($kind, reverse=$reverse)", (bias) => {
    for (const lambda of [0, 0.5]) {
      const current = -8 * (1 + 2 * lambda);
      const document = createCircuitFromSpecs(fixedGateSpecs({ ...bias, current, lambda }), "Reverse MOS current with a free effective source");
      const result = analyzeAnalogCircuit(document);
      expect(result.status, result.message).toBe("valid");
      // Drain=-2 gives effective overdrive=3 and |Vds|=2: I=-8*(1+2*lambda).
      const sign = (bias.kind === "nmos" ? 1 : -1) * (bias.reverse ? -1 : 1);
      expect(Math.abs(result.parts.mos!.voltage.real / (-2 * sign) - 1)).toBeLessThan(1e-12);
      expect(Math.abs(result.parts.mos!.current.real / (sign * current) - 1)).toBeLessThan(1e-12);
    }
  });

  it.each(orientations)("allows a modulated current above the lambda-zero cap ($kind, reverse=$reverse)", (bias) => {
    for (const initial of [false, true]) {
      const document = createCircuitFromSpecs(fixedGateSpecs({ ...bias, initial, current: 2, lambda: 0.5 }), "MOS channel modulation");
      const result = analyzeAnalogCircuit(document, { mode: "dc", initialInductorCurrents: initial });
      expect(result.status, result.message).toBe("valid");
      const sign = (bias.kind === "nmos" ? 1 : -1) * (bias.reverse ? -1 : 1);
      // I=(beta/2)*U^2*(1+lambda*Vds)=1*(1+0.5*2)=2.
      expect(Math.abs(result.parts.mos!.voltage.real / (2 * sign) - 1)).toBeLessThan(1e-12);
      expect(Math.abs(result.parts.mos!.current.real / (2 * sign) - 1)).toBeLessThan(1e-12);
    }
  });

  it.each(orientations)("allows a gate controlled through resistance ($kind, reverse=$reverse)", (bias) => {
    const specs = fixedGateSpecs({ ...bias, current: 4 }).filter(([id]) => id !== "gate");
    specs.push(["feedback", "resistor", ["drain", "gate"], { resistanceOhms: 1e6 }]);
    const result = analyzeAnalogCircuit(createCircuitFromSpecs(specs, "Free MOS gate with resistive feedback"));
    expect(result.status, result.message).toBe("valid");
    const sign = (bias.kind === "nmos" ? 1 : -1) * (bias.reverse ? -1 : 1);
    // No gate current: Vgate=Vdrain=4 and beta/2*(4-2)^2=4.
    expect(Math.abs(result.parts.mos!.voltage.real / (4 * sign) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(result.parts.mos!.current.real / (4 * sign) - 1)).toBeLessThan(1e-12);
  });

  it.each(["nmos", "pmos"] as const)("allows a source voltage controlled through resistance (%s)", (kind) => {
    const sign = kind === "nmos" ? 1 : -1;
    const specs = fixedGateSpecs({ kind, current: 4 }).map((spec): CircuitSpec =>
      spec[0] === "mos" ? [spec[0], spec[1], ["drain", "gate", "source"], spec[3]] : spec,
    );
    specs.push(
      ["return", "ac-source", ["return", "0"], { voltageVolts: 0, offsetVolts: -5 * sign }],
      ["source-r", "resistor", ["source", "return"], { resistanceOhms: 1 }],
    );
    const result = analyzeAnalogCircuit(createCircuitFromSpecs(specs, "Free MOS source voltage"));
    expect(result.status, result.message).toBe("valid");
    // Vsource=-5+4*1=-1 gives overdrive=3-(-1)-2=2 and saturation current=4.
    expect(Math.abs(result.parts.mos!.current.real / (4 * sign) - 1)).toBeLessThan(1e-12);
  });

  it.each(orientations)("retains the cutoff bound with positive lambda ($kind, reverse=$reverse)", (bias) => {
    const sign = bias.kind === "nmos" ? 1 : -1;
    for (const current of [0, Number.MIN_VALUE, -1.5]) {
      const specs = fixedGateSpecs({ ...bias, current, lambda: 0.5 }).map((spec): CircuitSpec =>
        spec[0] === "gate" ? [spec[0], spec[1], spec[2], { voltageVolts: 0, offsetVolts: 2 * sign }] : spec,
      );
      const result = analyzeAnalogCircuit(createCircuitFromSpecs(specs, "Directional MOS cutoff"));
      // U=0 forbids positive current. In reverse, Vdrain=-1 gives U=1,
      // |Vds|=1 and |I|=1*(1+0.5)=1.5; a symmetric zero cap would be wrong.
      expect(result.status, result.message).toBe(current > 0 ? "invalid" : "valid");
    }
  });

  it.each([false, true])("checks a floating island independently (initial=%s)", (initial) => {
    for (const current of [1, 1 + 2 ** -40]) {
      const specs = fixedGateSpecs({ kind: "nmos", initial, current }).filter(([id]) => id !== "ground");
      specs.push(
        ["ground", "ground", ["other-0"]],
        ["other-supply", "ac-source", ["other-v", "other-0"], { voltageVolts: 0, offsetVolts: 1e100 }],
        ["other-load", "resistor", ["other-v", "other-0"], { resistanceOhms: 1e100 }],
      );
      for (const parts of [specs, specs.toReversed()]) {
        const result = analyzeAnalogCircuit(createCircuitFromSpecs(parts, "MOS on a separate island"), { mode: "dc", initialInductorCurrents: initial });
        expect(result.status, result.message).toBe(current === 1 ? "valid" : "invalid");
      }
    }
  });

  it("sums ideal voltage paths before subtracting the threshold", () => {
    for (const current of [1, 1 + 2 ** -40]) {
      const specs = fixedGateSpecs({ kind: "nmos", current }).filter(([id]) => id !== "gate");
      specs.push(
        ["high", "ac-source", ["high", "0"], { voltageVolts: 0, offsetVolts: 1e300 }],
        ["cancel", "ac-source", ["middle", "high"], { voltageVolts: 0, offsetVolts: -1e300 }],
        ["gate", "ac-source", ["gate", "middle"], { voltageVolts: 0, offsetVolts: 3 }],
      );
      for (const parts of [specs, specs.toReversed()]) {
        const result = analyzeAnalogCircuit(createCircuitFromSpecs(parts, "Exact ideal gate voltage path"));
        expect(result.status, result.message).toBe(current === 1 ? "valid" : "invalid");
      }
    }
  });

  it("preserves the current bound after large imposed currents cancel", () => {
    const scale = 2 ** -1000;
    for (const current of [scale, scale * (1 + 2 ** -40)]) {
      const specs = fixedGateSpecs({ kind: "nmos", scale, current });
      specs.push(
        ["large-in", "current-source", ["0", "drain"], { currentAmps: 1e300 }],
        ["large-out", "current-source", ["0", "drain"], { currentAmps: -1e300 }],
      );
      for (const parts of [specs, specs.toReversed()]) {
        const result = analyzeAnalogCircuit(createCircuitFromSpecs(parts, "Exact MOS current cancellation"));
        expect(result.status, result.message).toBe(current === scale ? "valid" : "invalid");
      }
    }
  });

  it.each([-600, 600])("retains a current bound when squaring the control would exceed binary64 (exponent=%s)", (exponent) => {
    const voltage = 2 ** exponent;
    const betaExponent = exponent < 0 ? 600 : -1000;
    const limit = 2 ** (betaExponent + 2 * exponent - 1);
    for (const current of [limit, limit * (1 + 2 ** -40)]) {
      const specs: CircuitSpec[] = [
        ["ground", "ground", ["0"]],
        ["gate", "ac-source", ["gate", "0"], { voltageVolts: 0, offsetVolts: voltage }],
        ["current", "current-source", ["0", "drain"], { currentAmps: current }],
        ["mos", "nmos", ["drain", "gate", "0"], {
          thresholdVolts: 0, transconductanceAmpsPerVoltSquared: 2 ** betaExponent, channelLengthModulation: 0,
        }],
      ];
      // I=2^(betaExponent+2*exponent-1); the chosen beta also keeps V*I finite.
      const result = analyzeAnalogCircuit(createCircuitFromSpecs(specs, "Exact MOS square-law bound"));
      expect(result.status, result.message).toBe(current === limit ? "valid" : "invalid");
    }
  });

  it("retains the exact square's tail when current sources sum to the cap", () => {
    for (const excess of [0, 2 ** -100]) {
      const specs = fixedGateSpecs({ kind: "nmos", current: 1 + 2 ** -26 }).map((spec): CircuitSpec =>
        spec[0] === "gate" ? [spec[0], spec[1], spec[2], { voltageVolts: 0, offsetVolts: 3 + 2 ** -27 }] : spec,
      );
      specs.push(["tail", "current-source", ["0", "drain"], { currentAmps: 2 ** -54 + excess }]);
      // (1+2^-27)^2 = 1+2^-26+2^-54, whose tail cannot fit in the displayed
      // primary current. A 2^-100 excess is still strictly impossible.
      const result = analyzeAnalogCircuit(createCircuitFromSpecs(specs, "Exact MOS squared bound"));
      expect(result.status, result.message).toBe(excess === 0 ? "valid" : "invalid");
    }
  });

  it("uses the existing MOS control boundary after the exact gate voltage path", () => {
    for (const current of [1, 1 + 2 ** -40]) {
      const specs = fixedGateSpecs({ kind: "nmos", current }).filter(([id]) => id !== "gate");
      specs.push(
        ["bias", "ac-source", ["bias", "0"], { voltageVolts: 0, offsetVolts: 3 }],
        ["gate", "ac-source", ["gate", "bias"], { voltageVolts: 0, offsetVolts: -(2 ** -54) }],
      );
      // The exact overdrive 1-2^-54 rounds to 1 at the established model
      // boundary; the current polynomial is then evaluated without rounding.
      const result = analyzeAnalogCircuit(createCircuitFromSpecs(specs, "MOS model control boundary"));
      expect(result.status, result.message).toBe(current === 1 ? "valid" : "invalid");
    }
  });

  it("keeps a nonzero bound below the smallest representable current", () => {
    const specs = fixedGateSpecs({ kind: "nmos", current: Number.MIN_VALUE });
    specs.find(([id]) => id === "mos")![3]!.transconductanceAmpsPerVoltSquared = Number.MIN_VALUE;
    // The exact cap is MIN_VALUE/2, so MIN_VALUE is strictly impossible.
    const result = analyzeAnalogCircuit(createCircuitFromSpecs(specs, "Subnormal MOS current bound"));
    expect(result.status, result.message).toBe("invalid");
  });

  it("combines parallel MOS caps across a series resistance", () => {
    for (const current of [2, 2 + 2 ** -40]) {
      const specs = fixedGateSpecs({ kind: "nmos", current }).map((spec): CircuitSpec =>
        spec[0] === "current" ? [spec[0], spec[1], ["0", "input"], spec[3]] : spec,
      );
      specs.push(
        ["series", "resistor", ["input", "drain"], { resistanceOhms: 1 }],
        ["parallel", "nmos", ["drain", "gate", "0"], {
          thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 2, channelLengthModulation: 0,
        }],
      );
      const result = analyzeAnalogCircuit(createCircuitFromSpecs(specs, "Parallel MOS saturation limits"));
      expect(result.status, result.message).toBe(current === 2 ? "valid" : "invalid");
    }
  });

  it("allows a forward diode to carry current beyond the MOS limit", () => {
    const specs = fixedGateSpecs({ kind: "nmos", current: 2 });
    specs.push(["diode", "diode", ["drain", "0"], { saturationCurrentAmps: 1e-12 }]);
    const result = analyzeAnalogCircuit(createCircuitFromSpecs(specs, "MOS with a conducting diode bypass"));
    expect(result.status, result.message).toBe("valid");
    expect(Math.abs((result.parts.mos!.current.real + result.parts.diode!.current.real) / 2 - 1)).toBeLessThan(1e-12);
  });

  it("rejects the impossible initial inductor current before producing transient samples", () => {
    const document = createCircuitFromSpecs(fixedGateSpecs({ kind: "nmos", initial: true, current: 1 + 2 ** -40 }), "Impossible initial MOS current");
    const result = simulateTransient(document, { durationSeconds: 1e-5, timeStepSeconds: 1e-5 });
    expect(result.status, result.message).toBe("invalid");
    expect(result.samples).toHaveLength(0);
  });
});
