import type { CircuitAnalysis } from "../circuit-solver.js";

/** Standalone readouts may omit a status; failed analyses never supply usable readings. */
export function analysisReadingsAvailable(status?: CircuitAnalysis["status"]) {
  return status !== "invalid" && status !== "short" && status !== "empty";
}

export function analysisPartReading(analysis: CircuitAnalysis | undefined, partId: string) {
  return analysisReadingsAvailable(analysis?.status) ? analysis?.parts[partId] : undefined;
}
