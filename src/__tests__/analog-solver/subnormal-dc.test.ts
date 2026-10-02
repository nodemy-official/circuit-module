import { expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import type { CircuitDocument, CircuitPart, CircuitTerminal } from "../../circuit-model.js";

it("retains DC bridge currents with subnormal excitation", () => {
  // A 1/16 Ω resistor in series with 1/16 || (1/16 + 1/16) Ω
  // draws 9.6 times the applied voltage; two extra parallel resistors
  // exercise the source-current sum and elimination pivot order.
  const edges = [[0, 1], [1, 2], [2, 0], [0, 2], [1, 3], [3, 2]] as const;
  for (const units of [1, 3, 7, 13, 31]) {
    const parts: CircuitPart[] = [
      { id: "source", kind: "battery", x: 0, y: 0, voltageVolts: units * Number.MIN_VALUE },
      ...edges.map((_, index): CircuitPart => ({
        id: `r${index}`, kind: "resistor", x: 0, y: 0, resistanceOhms: 1 / 16,
      })),
    ];
    const endpoints: Array<Array<{ partId: string; terminal: CircuitTerminal }>> = Array.from({ length: 4 }, () => []);
    for (const [index, edge] of [[0, 2], ...edges].entries()) {
      endpoints[edge[0]!]!.push({ partId: parts[index]!.id, terminal: "a" });
      endpoints[edge[1]!]!.push({ partId: parts[index]!.id, terminal: "b" });
    }
    const document: CircuitDocument = {
      title: "Subnormal DC bridge",
      parts,
      wires: endpoints.flatMap((node, index) => node.slice(1).map((endpoint, offset) => ({
        id: `${index}-${offset}`, from: node[0]!, to: endpoint,
      }))),
    };
    const analysis = analyzeAnalogCircuit(document);
    expect(analysis.status, analysis.message).toBe("valid");
    // Form the full normal-valued multiplier before the final subnormal rounding.
    for (const [id, factor] of [["r0", 9.6], ["r1", 6.4], ["r4", 3.2], ["r5", 3.2]] as const) {
      expect(analysis.parts[id]!.current.real / Number.MIN_VALUE, `${units} units / ${id}`)
        .toBe((factor * units * Number.MIN_VALUE) / Number.MIN_VALUE);
    }
  }
});
