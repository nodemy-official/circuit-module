import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { MAX_TRANSIENT_STEPS, type TransientAnalysis } from "../../transient-solver.js";
import { CircuitEnergyPanel } from "../CircuitEnergyPanel.js";

// Keep the full 512,256-reading fixture and allow headroom under shared CPU load.
it("renders the full stored-energy scale for many capacitors and the maximum sample count", () => {
  const document: CircuitDocument = {
    title: "多数のコンデンサの蓄積エネルギー",
    parts: Array.from({ length: 256 }, (_, index) => ({
      id: `c${index + 1}`, kind: "capacitor", label: `C${index + 1}`, x: index * 6, y: 0,
      capacitanceFarads: index + 1, initialVoltageVolts: 1,
    })),
    wires: [],
  };
  // Isolated ideal capacitors retain their initial 1 V at every sample.
  const parts = Object.fromEntries(document.parts.map((part) => [part.id, {
    voltageVolts: 1, currentAmps: 0, powerWatts: 0,
  }]));
  const transient: TransientAnalysis = {
    status: "valid", message: "過渡解析が完了しました。", issues: [],
    samples: Array.from({ length: MAX_TRANSIENT_STEPS + 1 }, (_, index) => ({
      timeSeconds: index / MAX_TRANSIENT_STEPS, parts,
    })),
  };
  const markup = renderToStaticMarkup(<CircuitEnergyPanel
    document={document} analysis={analyzeCircuit(document)} frame={{ analysis: transient, sampleIndex: MAX_TRANSIENT_STEPS }}
  />);

  expect(markup).toContain('data-state="transient"');
  expect(markup.match(/data-energy-joules=/g)).toHaveLength(256);
  // Emax = (1/2) * 256 F * (1 V)^2 = 128 J.
  expect(markup.match(/data-scale-max="128"/g)).toHaveLength(256);
  expect(markup).toContain('data-energy-joules="0.5"');
  expect(markup).toContain('data-energy-joules="128"');
}, 30_000);
