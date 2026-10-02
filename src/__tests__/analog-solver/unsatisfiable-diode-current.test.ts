import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../../circuit-model.js";

const part = (id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (
  id: string,
  fromPart: string,
  fromTerminal: "a" | "b",
  toPart: string,
  toTerminal: "a" | "b",
) => ({
  id,
  from: { partId: fromPart, terminal: fromTerminal },
  to: { partId: toPart, terminal: toTerminal },
});

describe("unsatisfiable nonlinear DC operating points", () => {
  it.each(["dc", "ac"] as const)(
    "does not report an ideal-voltage-source loop for current beyond a diode's reverse limit in %s mode",
    (mode) => {
      const document: CircuitDocument = {
        title: "ダイオード逆方向の飽和電流を超える理想電流源",
        parts: [
          part("source", "current-source", { currentAmps: 1.001e-12 }),
          part("diode", "diode"),
          part("ground", "ground"),
        ],
        wires: [
          wire("source-anode", "source", "a", "diode", "a"),
          wire("source-cathode", "source", "b", "diode", "b"),
          wire("ground-cathode", "ground", "a", "diode", "b"),
        ],
      };

      const analysis = analyzeAnalogCircuit(document, { mode });

      expect(analysis.status).toBe("invalid");
      expect(analysis.message).not.toContain("理想電圧源のループ");
    },
  );
});
