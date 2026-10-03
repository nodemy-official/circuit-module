import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

const cases = (["nmos", "pmos"] as const).flatMap((kind) =>
  [false, true].flatMap((reverse) => [false, true].flatMap((initial) =>
    (["diode", "led"] as const).flatMap((junction) => [false, true].map((loop) => ({ kind, reverse, initial, junction, loop }))),
  )),
);

function dividerGateSpecs(bias: typeof cases[number], current: number): CircuitSpec[] {
  const sign = bias.kind === "nmos" ? 1 : -1;
  return [
    ["ground", "ground", ["0"]],
    ["bias", "ac-source", ["bias", "0"], { voltageVolts: 0, offsetVolts: sign * 6 }],
    ["upper", "resistor", ["bias", "p"], { resistanceOhms: 7 }],
    ["lower", "resistor", ["p", "0"], { resistanceOhms: 7 }],
    ["junction", bias.junction, ["p", "gate"], { saturationCurrentAmps: 1e-12 }],
    ...(bias.loop ? [
      ["loop1", "resistor", ["p", "middle"], { resistanceOhms: 3 }],
      ["loop2", bias.junction, ["middle", "gate"], { saturationCurrentAmps: 1e-12 }],
    ] satisfies CircuitSpec[] : []),
    ["mos", bias.kind, bias.reverse ? ["0", "gate", "drain"] : ["drain", "gate", "0"], {
      thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 2, channelLengthModulation: 0,
    }],
    ...(bias.initial ? [
      ["supply", "ac-source", ["supply", "0"], { voltageVolts: 0, offsetVolts: sign * 10 }],
      ["inject", "inductor", ["supply", "drain"], { inductanceHenries: 1, initialCurrentAmps: sign * current }],
    ] satisfies CircuitSpec[] : [
      ["inject", "current-source", ["0", "drain"], { currentAmps: sign * current }],
    ] satisfies CircuitSpec[]),
  ];
}

describe("MOS bounds behind a single-port passive gate network", () => {
  it.each(cases)("proves the unloaded divider bias ($kind, reverse=$reverse, initial=$initial, $junction, loop=$loop)", (bias) => {
    for (const current of [0.75, 1, 1 + 2 ** -52]) {
      const specs = dividerGateSpecs(bias, current);
      for (const parts of [specs, specs.toReversed()]) {
        const result = analyzeAnalogCircuit(createCircuitFromSpecs(parts, "Unloaded passive gate network"), {
          mode: "dc", initialInductorCurrents: bias.initial,
        });
        // The gate network has one current-carrying port. Zero dissipated
        // power forces every junction drop to zero, so the 6 V / 2 divider
        // fixes |Vgs|=3 V and beta/2*(3-2)^2=1 A exactly.
        expect(result.status, result.message).toBe(current > 1 ? "invalid" : "valid");
        if (current <= 1) {
          const orientation = (bias.kind === "nmos" ? 1 : -1) * (bias.reverse ? -1 : 1);
          expect(result.parts.mos!.current.real).toBe(orientation * current);
          expect(result.parts.junction!.current.real).toBe(0);
          if (current === 0.75) { expect(result.parts.mos!.voltage.real).toBe(orientation * 0.5); }
        }
      }
    }
  });

  it("keeps a loaded junction gate independent of the divider voltage", () => {
    const bias = { kind: "nmos", reverse: false, initial: false, junction: "diode", loop: false } as const;
    const specs = dividerGateSpecs(bias, 2);
    specs.push(["pullup", "resistor", ["bias", "gate"], { resistanceOhms: 1 }]);
    const result = analyzeAnalogCircuit(createCircuitFromSpecs(specs, "Loaded passive gate"));

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.mos!.current.real).toBe(2);
    expect(result.parts.mos!.terminalVoltages.b!.real).toBeGreaterThan(5);
    expect(result.parts.junction!.current.real).toBeLessThan(0);
  });

  it.each((["nmos", "pmos"] as const).flatMap((kind) =>
    (["cb", "be", "ce"] as const).flatMap((tie) =>
      [false, true].flatMap((reverse) => [false, true].flatMap((initial) =>
        [false, true].map((extraPortLoad) => ({ kind, tie, reverse, initial, extraPortLoad })),
      )),
    ),
  ))("preserves loaded ideal-source offsets when proving a tied BJT bias ($kind, $tie, reverse=$reverse, initial=$initial, extraPortLoad=$extraPortLoad)", ({ kind, tie, reverse, initial, extraPortLoad }) => {
    const sign = kind === "nmos" ? 1 : -1;
    const bound = extraPortLoad ? 1 : 225 / 256;
    for (const current of [bound * 0.75, bound, bound + 2 ** -52, bound + 2 ** -40]) {
      const specs: CircuitSpec[] = [
        ["ground", "ground", ["0"]],
        ["bias", "ac-source", ["s", "0"], { voltageVolts: 0, offsetVolts: sign * (extraPortLoad ? 73 / 8 : 6) }],
        ["upper", "resistor", ["s", "p"], { resistanceOhms: 7 }],
        ["up", "ac-source", ["x", "p"], { voltageVolts: 0, offsetVolts: sign / 8 }],
        ["down", "ac-source", ["q", "x"], { voltageVolts: 0, offsetVolts: -sign / 8 }],
        ["load", "resistor", ["x", "0"], { resistanceOhms: 7 }],
        ...(extraPortLoad ? [["port-load", "resistor", ["q", "0"], { resistanceOhms: 7 }]] satisfies CircuitSpec[] : []),
        ["junction", kind === "nmos" ? "npn-transistor" : "pnp-transistor",
          tie === "cb" ? ["q", "p", "gate"] : tie === "be" ? ["gate", "q", "p"] : ["q", "gate", "p"],
          { saturationCurrentAmps: 0.001, currentGain: 8 }],
        ["mos", kind, reverse ? ["0", "gate", "drain"] : ["drain", "gate", "0"], {
          thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 2, channelLengthModulation: 0,
        }],
        ...(initial ? [
          ["supply", "ac-source", ["supply", "0"], { voltageVolts: 0, offsetVolts: sign * 10 }],
          ["inject", "inductor", ["supply", "drain"], { inductanceHenries: 1, initialCurrentAmps: sign * current }],
        ] satisfies CircuitSpec[] : [
          ["inject", "current-source", ["0", "drain"], { currentAmps: sign * current }],
        ] satisfies CircuitSpec[]),
      ];
      for (const parts of [specs, specs.toReversed()]) {
        const result = analyzeAnalogCircuit(createCircuitFromSpecs(parts, "Loaded offset-source BJT gate"), {
          mode: "dc", initialInductorCurrents: initial,
        });
        // Tied BJT ports imply zero gate current. KCL at the voltage-source
        // supernode gives (6-p)/7=(p+1/8)/7, so p=47/16 and Id<=225/256.
        // With the added q load, (73/8-p)/7=(p+1/8)/7+p/7 gives p=3.
        expect(result.status, result.message).toBe(current > bound ? "invalid" : "valid");
        if (current <= bound) {
          expect(result.parts.up!.voltage.real).toBe(sign / 8);
          expect(result.parts.down!.voltage.real).toBe(-sign / 8);
          expect(result.parts.mos!.terminalVoltages.b!.real).toBe(sign * (extraPortLoad ? 3 : 47 / 16));
          expect(result.parts.mos!.current.real).toBe((reverse ? -sign : sign) * current);
        }
      }
    }
  });
});
