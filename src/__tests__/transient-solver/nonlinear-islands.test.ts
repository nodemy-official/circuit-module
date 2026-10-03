import { describe, expect, it } from "vitest";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs, type CircuitSpec } from "../helpers/circuit-fixture.js";

const model = { thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 2, channelLengthModulation: 0 };

function seriesMosCircuit(kind: "nmos" | "pmos", reverse: boolean, driven: boolean | "rc", island: false | "floating" | "grounded" | "middle" | "drain", ground: boolean) {
  const sign = kind === "nmos" ? 1 : -1;
  const voltage = (id: string, node: string, reference: string, value: number): CircuitSpec =>
    [id, "ac-source", [node, reference], { voltageVolts: 0, offsetVolts: sign * value }];
  const specs: CircuitSpec[] = [
    voltage("supply", "supply", "0", 10),
    ["g1", "ac-source", [driven === "rc" ? "bias" : "g1", "0"], { voltageVolts: driven === true ? 0.05 : 0, offsetVolts: sign * (driven === "rc" ? 2.5 : 3),
      frequencyHz: 1, phaseDegrees: kind === "nmos" ? 90 : 270 }],
    voltage("g2", "g2", "0", 4),
    ["l", "inductor", ["supply", "drain"], { inductanceHenries: 1, initialCurrentAmps: sign }],
    ["m1", kind, ["middle", "g1", "0"], model],
    ["m2", kind, ["drain", "g2", "middle"], model],
  ];
  if (driven === "rc") {
    specs.push(["rg", "resistor", ["bias", "g1"], { resistanceOhms: 2 }],
      ["cg", "capacitor", ["g1", "0"], { capacitanceFarads: 1, initialVoltageVolts: sign * 3 }]);
  }
  if (ground) { specs.push(["ground", "ground", ["0"]]); }
  if (island) {
    const reference = island === "grounded" ? "0" : island === "floating" ? "t0" : island;
    specs.push(voltage("island-gate", "tg", reference, 3),
      ["island-current", "current-source", [reference, "td"], { currentAmps: sign * 0.5 }],
      ["island-mos", kind, ["td", "tg", reference], model]);
  }
  return createCircuitFromSpecs(reverse ? specs.toReversed() : specs, "Independent triode and saturated MOS islands");
}

describe("transient Newton guesses across independent nonlinear islands", () => {
  for (const kind of ["nmos", "pmos"] as const) {
    it.each([1, 3].flatMap((count) => [false, true].flatMap((reverse) => [false, true].map((resistiveGate) => ({ count, reverse, resistiveGate })))))(`${kind} preserves $count near-saturated triodes on a moving reference, reverse=$reverse, resistiveGate=$resistiveGate`, ({ count, reverse, resistiveGate }) => {
      const sign = kind === "nmos" ? 1 : -1;
      const document = seriesMosCircuit(kind, false, "rc", "drain", false);
      const current = sign * (1 - 2 ** -52);
      document.parts.find((part) => part.id === "island-current")!.currentAmps = current;
      if (resistiveGate) {
        document.parts.push({ id: "island-gate-r", kind: "resistor", label: "Gate resistor", x: 0, y: 0, resistanceOhms: 1 });
        document.wires = document.wires.map((wire) => ({ ...wire,
          from: wire.from.partId === "island-gate" && wire.from.terminal === "a" ? { partId: "island-gate-r", terminal: "b" } : wire.from,
          to: wire.to.partId === "island-gate" && wire.to.terminal === "a" ? { partId: "island-gate-r", terminal: "b" } : wire.to,
        }));
        document.wires.push({ id: "gate-resistor-bias", from: { partId: "island-gate", terminal: "a" }, to: { partId: "island-gate-r", terminal: "a" } });
      }
      for (let index = 1; index < count; index += 1) {
        const prefix = `extra${index}`;
        const extra = createCircuitFromSpecs([
          [`${prefix}gate`, "ac-source", ["gate", "source"], { voltageVolts: 0, offsetVolts: sign * 3 }],
          [`${prefix}current`, "current-source", ["source", "drain"], { currentAmps: current }],
          [`${prefix}mos`, kind, ["drain", "gate", "source"], model],
        ], "Additional near-saturated triode");
        document.parts.push(...extra.parts);
        document.wires.push(...extra.wires.map((wire) => ({ ...wire, id: `${prefix}${wire.id}` })),
          { id: `${prefix}anchor`, from: { partId: `${prefix}gate`, terminal: "b" }, to: { partId: "l", terminal: "b" } });
      }
      if (reverse) { document.parts.reverse(); document.wires.reverse(); }
      const result = simulateTransient(document, { durationSeconds: 1e-5, timeStepSeconds: 1e-5 });
      expect(result.status, result.message).toBe("valid");
      const initial = result.samples[0]!.parts;
      // Vg'=(2.5-3)/2/1=-1/4; I'=2*1*Vg'=-1/2 exactly.
      expect(initial.l!.voltageVolts).toBe(-sign * 0.5);
      expect(initial["island-mos"]!.currentAmps).toBe(current);
      expect(initial["island-mos"]!.voltageVolts).toBe(sign * (1 - 2 ** -26));
    });
  }
  for (const kind of ["nmos", "pmos"] as const) {
    for (const reverse of [false, true]) {
      for (const driven of [false, true]) {
        it.each([1e-3, 1e-5].flatMap((dt) => [false, true].map((ground) => ({ dt, ground }))))(`${kind}, reverse=${reverse}, driven=${driven}, dt=$dt, ground=$ground`, ({ dt, ground }) => {
          const sign = kind === "nmos" ? 1 : -1;
          const islands = ground ? [false, "floating", "grounded", "middle", "drain"] as const : [false, "floating"] as const;
          for (const island of islands) {
            const result = simulateTransient(seriesMosCircuit(kind, reverse, driven, island, ground), {
              durationSeconds: 3 * dt, timeStepSeconds: dt,
            });
            expect(result.status, result.message).toBe("valid");
            expect(result.samples).toHaveLength(4);
            let previousCurrent = sign;
            for (const sample of result.samples) {
              // The lower MOS stays saturated: I = (Vg-2)^2. The upper
              // device fixes its source at 2-sqrt(I), independently of the island.
              const overdrive = 1 - (driven ? Math.SQRT2 * 0.05 * Math.sin(2 * Math.PI * sample.timeSeconds) : 0);
              const expectedCurrent = sign * overdrive * overdrive;
              const expectedVoltage = sample.timeSeconds === 0
                ? driven ? -sign * 4 * Math.PI * Math.SQRT2 * 0.05 : 0
                : (expectedCurrent - previousCurrent) / dt;
              for (const id of ["l", "m1", "m2"]) {
                expect(sample.parts[id]!.currentAmps).toBeCloseTo(expectedCurrent, 12);
              }
              expect(sample.parts.l!.voltageVolts).toBeCloseTo(expectedVoltage, 8);
              expect(sample.parts.l!.voltageVolts + sample.parts.m1!.voltageVolts + sample.parts.m2!.voltageVolts).toBeCloseTo(sign * 10, 12);
              if (island) {
                expect(sample.parts["island-mos"]!.currentAmps).toBeCloseTo(sign * 0.5, 14);
                expect(sample.parts["island-mos"]!.voltageVolts).toBeCloseTo(sign * (1 - Math.SQRT1_2), 14);
              }
              previousCurrent = expectedCurrent;
            }
          }
        });
      }
    }
  }
});
