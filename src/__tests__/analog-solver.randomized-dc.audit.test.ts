import { describe, expect, it } from "vitest";

import { complexMagnitude, exactComponentSum, type ComplexValue } from "../analog-math.js";
import { analyzeAnalogCircuit } from "../analog-solver.js";
import { circuitPartCatalog, type CircuitDocument } from "../circuit-model.js";

function makeRandomizedCircuits() {
  let seed = 61_723;
  const random = () => {
    // biome-ignore lint/suspicious/noBitwiseOperators: Preserve the legacy LCG's unsigned wraparound exactly.
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 2 ** 32;
  };

  return Array.from({ length: 1000 }, () => {
    const parts = Array.from({ length: 5 }, (_, node) => ({
      id: `n${node}`,
      kind: "junction" as const,
      x: 0,
      y: 0,
      ...circuitPartCatalog.junction.defaults,
    }));
    const wires: CircuitDocument["wires"] = [];
    const branchNodes: { partId: string; nodeA: number; nodeB: number }[] = [];

    for (let branch = 0; branch < 12; branch += 1) {
      const nodeA = Math.floor(random() * 5);
      const nodeB = (nodeA + 1 + Math.floor(random() * 4)) % 5;
      const isBattery = branch < 3;
      const voltageVolts = 1 + random() * 10;
      const internalResistanceOhms = 10 ** (random() * 8);
      const resistanceOhms = 10 ** (random() * 20);
      parts.push({
        id: `p${branch}`,
        kind: isBattery ? "battery" : "resistor",
        x: 0,
        y: 0,
        label: `p${branch}`,
        ...(isBattery ? { voltageVolts, internalResistanceOhms } : { resistanceOhms }),
      });
      branchNodes.push({ partId: `p${branch}`, nodeA, nodeB });
      wires.push(
        {
          id: `w${branch}a`,
          from: { partId: `p${branch}`, terminal: "a" },
          to: { partId: `n${nodeA}`, terminal: "a" },
        },
        {
          id: `w${branch}b`,
          from: { partId: `p${branch}`, terminal: "b" },
          to: { partId: `n${nodeB}`, terminal: "a" },
        },
      );
    }

    return {
      document: { title: "randomized DC KCL audit", parts, wires } as CircuitDocument,
      branchNodes,
    };
  });
}

const randomizedCircuits = makeRandomizedCircuits();
const randomizedCaseBatches = Array.from({ length: 10 }, (_, batchIndex) => {
  const firstCaseIndex = batchIndex * 100;
  return {
    firstCaseIndex,
    lastCaseIndex: firstCaseIndex + 99,
    cases: randomizedCircuits.slice(firstCaseIndex, firstCaseIndex + 100),
  };
});

describe("analog DC randomized KCL audit", () => {
  it.each(randomizedCaseBatches)(
    "solves seeded DC KCL cases $firstCaseIndex–$lastCaseIndex with balanced junction currents",
    ({ firstCaseIndex, cases }) => {
      const invalidCases: { caseIndex: number; status: string; message: string }[] = [];
      const missingCurrents: { caseIndex: number; node: number; partId: string; terminal: "a" | "b" }[] = [];
      const residualViolations: {
        caseIndex: number;
        node: number;
        residualAmps: number;
        scaleAmps: number;
        relativeResidual: number;
      }[] = [];

      for (const [caseOffset, { document, branchNodes }] of cases.entries()) {
        const caseIndex = firstCaseIndex + caseOffset;
        const analysis = analyzeAnalogCircuit(document);
        if (analysis.status !== "valid") {
          invalidCases.push({ caseIndex, status: analysis.status, message: analysis.message });
          continue;
        }

        const nodeCurrents: ComplexValue[][] = Array.from({ length: 5 }, () => []);
        for (const branch of branchNodes) {
          const reading = analysis.parts[branch.partId];
          const currentA = reading?.terminalCurrents.a;
          const currentB = reading?.terminalCurrents.b;
          if (!currentA) { missingCurrents.push({ caseIndex, node: branch.nodeA, partId: branch.partId, terminal: "a" }); }
          else { nodeCurrents[branch.nodeA]?.push(currentA); }
          if (!currentB) { missingCurrents.push({ caseIndex, node: branch.nodeB, partId: branch.partId, terminal: "b" }); }
          else { nodeCurrents[branch.nodeB]?.push(currentB); }
        }

        for (const [node, currents] of nodeCurrents.entries()) {
          if (missingCurrents.some((missing) => missing.caseIndex === caseIndex && missing.node === node)) { continue; }
          const realResidual = exactComponentSum(currents.map((current) => current.real));
          const imaginaryResidual = exactComponentSum(currents.map((current) => current.imaginary));
          const residualAmps = Math.hypot(realResidual, imaginaryResidual);
          const scaleAmps = Math.max(0, ...currents.map(complexMagnitude));
          const relativeResidual = scaleAmps === 0
            ? residualAmps === 0 ? 0 : Number.POSITIVE_INFINITY
            : residualAmps / scaleAmps;
          if (!Number.isFinite(relativeResidual) || relativeResidual > 1e-8) {
            residualViolations.push({ caseIndex, node, residualAmps, scaleAmps, relativeResidual });
          }
        }
      }

      expect(invalidCases).toEqual([]);
      expect(missingCurrents).toEqual([]);
      expect(residualViolations).toEqual([]);
    },
  );
});
