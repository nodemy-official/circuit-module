import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { CircuitEnergyPanel } from "../CircuitEnergyPanel.js";

const unavailable = { configurable: true, get() { throw new Error("Unavailable optional precision"); } };

it.each(["capacitor", "inductor"] as const)("keeps scalar %s energy when its precision field cannot be read", (kind) => {
  const document = createCircuitFromSpecs([
    ["source", kind === "capacitor" ? "battery" : "current-source", ["v", "g"], { voltageVolts: 1, currentAmps: 1 }],
    ["storage", kind, ["v", "g"], { capacitanceFarads: 1, inductanceHenries: 1 }],
    ["ground", "ground", ["g"]],
  ]);
  const analysis = analyzeCircuit(document);
  expect(analysis.status).not.toBe("invalid");
  Object.defineProperty(analysis.parts.storage!, kind === "capacitor" ? "exactVoltage" : "exactTerminalCurrents", unavailable);
  Object.defineProperty(analysis, "precisionExpressions", unavailable);
  const markup = renderToStaticMarkup(<CircuitEnergyPanel document={document} analysis={analysis} />);
  // E = C*V²/2 or L*I²/2, with both coefficient and scalar equal to one.
  expect(markup).toContain('data-energy-joules="0.5"');
});

it.each(["exactVoltage", "exactTerminalCurrents", "terminal-current", "precisionExpressions", "energyPrecisionExpressions", "energyReadings"] as const)(
  "recomputes scalar transient energy when the %s field cannot be read",
  (field) => {
    const document = createCircuitFromSpecs([
      ["c", "capacitor", ["v", "g"], { capacitanceFarads: 1, initialVoltageVolts: 1 }],
      ["r", "resistor", ["v", "g"], { resistanceOhms: 1 }],
    ]);
    const transient = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
    expect(transient.status).toBe("valid");
    if (field === "precisionExpressions" || field === "energyPrecisionExpressions" || field === "energyReadings") {
      Object.defineProperty(transient, field, unavailable);
    } else {
      for (const sample of transient.samples) {
        for (const partId of ["c", "r"]) {
          const reading = sample.parts[partId]!;
          if (field === "terminal-current") {
            const terminals = {};
            Object.defineProperty(terminals, "a", unavailable);
            reading.exactTerminalCurrents = terminals;
          } else {
            Object.defineProperty(reading, field, unavailable);
          }
        }
      }
    }
    const markup = renderToStaticMarkup(<CircuitEnergyPanel
      document={document} analysis={analyzeCircuit(document)} frame={{ analysis: transient, sampleIndex: 1 }}
    />);
    // Backward Euler gives V1=1/2, so E_C=1/8 and the sampled
    // trapezoidal resistor energy is (1 + 1/4)/2 = 5/8 J.
    expect(markup).toContain('data-energy-joules="0.125"');
    expect(markup).toContain('data-dissipated-joules="0.625"');
  },
);
