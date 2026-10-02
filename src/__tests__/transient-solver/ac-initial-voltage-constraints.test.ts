import { expect, it } from "vitest";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

it("keeps an AC source ideal when it carries an unused battery resistance field", () => {
  const voltage = 0.1 * Math.SQRT2;
  const document = createCircuitFromSpecs([
    ["source", "ac-source", ["v", "g"], {
      voltageVolts: 0.1, frequencyHz: 1, phaseDegrees: 0, internalResistanceOhms: 1,
    }],
    ["cap", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: voltage }],
  ], "An AC source ignores battery-only parameters");
  const step = 1e-5;
  const result = simulateTransient(document, { durationSeconds: step, timeStepSeconds: step });
  expect(result.status, result.message).toBe("valid");
  expect(result.samples[0]!.parts.cap.voltageVolts).toBe(voltage);
  const expectedCurrent = -2 * voltage * Math.sin(Math.PI * step) ** 2 / step;
  expect(Math.abs(result.samples[1]!.parts.cap.currentAmps / expectedCurrent - 1)).toBeLessThan(1e-13);
});

it.each([0, 1].flatMap((voltageVolts) => [
  { voltageVolts, reverse: false }, { voltageVolts, reverse: true },
]))("keeps a pure DC capacitor constraint exact with another AC branch $voltageVolts; reverse=$reverse", ({ voltageVolts, reverse }) => {
  const document = createCircuitFromSpecs([
    ["dc", "battery", ["v", "m"], { voltageVolts: 1, internalResistanceOhms: 0 }],
    ["tiny", "battery", ["m", "g"], { voltageVolts: 2 ** -54, internalResistanceOhms: 0 }],
    ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: 1 }],
    ["ac", "ac-source", ["x", "g"], { voltageVolts, frequencyHz: 1 }],
  ], "Independent AC cannot relax DC initial state");
  if (reverse) { document.parts.reverse(); document.wires.reverse(); }
  const options = { durationSeconds: 1e-10, timeStepSeconds: 1e-10 };
  expect(simulateTransient(document, options).status).toBe("invalid");
  document.parts = document.parts.filter((part) => part.id !== "tiny");
  document.wires = document.wires.filter((wire) => wire.from.partId !== "tiny" && wire.to.partId !== "tiny");
  document.wires.push({ id: "dc-ground", from: { partId: "dc", terminal: "b" }, to: { partId: "c", terminal: "b" } });
  expect(simulateTransient(document, options).status).toBe("valid");
});
