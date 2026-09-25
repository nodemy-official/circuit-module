import { describe, expect, it } from "vitest";

import { createExampleCircuit } from "./circuit-model.js";
import { analyzeCircuit } from "./circuit-solver.js";

describe("analyzeCircuit", () => {
  it("calculates current and bulb power for a closed series circuit", () => {
    const result = analyzeCircuit(createExampleCircuit());
    expect(result.status).toBe("closed");
    expect(result.currentAmps).toBeCloseTo(0.3);
    expect(result.bulbPowerWatts["part-3"]).toBeCloseTo(1.8);
  });

  it("reports zero current when the switch is open", () => {
    const result = analyzeCircuit(createExampleCircuit(), { "part-4": false });
    expect(result.status).toBe("open");
    expect(result.currentAmps).toBe(0);
  });

  it("calculates a circuit with a parallel branch", () => {
    const document = createExampleCircuit();
    document.parts.push({
      id: "part-5",
      kind: "resistor",
      label: "枝の抵抗",
      x: 3,
      y: 4,
      resistanceOhms: 5,
    });
    document.wires.push(
      {
        id: "wire-5",
        from: { partId: "part-5", terminal: "a" },
        to: { partId: "part-2", terminal: "a" },
      },
      {
        id: "wire-6",
        from: { partId: "part-5", terminal: "b" },
        to: { partId: "part-2", terminal: "b" },
      },
    );
    const result = analyzeCircuit(document);
    expect(result.status).toBe("closed");
    expect(result.currentAmps).not.toBeNull();
    expect(result.bulbPowerWatts["part-3"]).toBeGreaterThan(0);
  });

  it("reports a shorted battery", () => {
    const document = createExampleCircuit();
    document.wires.push({
      id: "wire-5",
      from: { partId: "part-1", terminal: "a" },
      to: { partId: "part-1", terminal: "b" },
    });
    expect(analyzeCircuit(document).status).toBe("short");
  });
});
