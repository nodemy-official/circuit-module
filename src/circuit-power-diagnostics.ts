import { exactProductSumRatio } from "./analog-math.js";
import { circuitPartCatalog, type CircuitPart } from "./circuit-model.js";
import type { CircuitIssue } from "./circuit-solver.js";
import type { ExactRational } from "./exact-linear-algebra.js";

const OVERLOAD_RATIO = 1.5;

/** Compare power before display rounding, including subnormal ratings. */
export function bulbOverloadIssue(part: Pick<CircuitPart, "id" | "ratedPowerWatts"> & { label?: string }, power: ExactRational): CircuitIssue | undefined {
  const excess = exactProductSumRatio([
    { factors: [power] },
    { factors: [part.ratedPowerWatts ?? 2, OVERLOAD_RATIO], sign: -1 },
  ], 1);
  if (excess === null || excess.numerator <= 0n) { return; }
  return {
    severity: "warning",
    partId: part.id,
    message: `${part.label ?? circuitPartCatalog.bulb.defaults.label}に定格の${OVERLOAD_RATIO}倍を超える電力がかかっています。`,
  };
}
