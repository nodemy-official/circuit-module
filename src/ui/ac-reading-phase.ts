import { complexDivide, complexMagnitude } from "../analog-math.js";
import type { CircuitPartKind } from "../circuit-model.js";
import { readOptionalPrecision, restoredReadingComplex } from "../circuit-reading.js";
import type { CircuitAnalysis, CircuitPartReading } from "../circuit-solver.js";

/** A rounded zero RMS reading can still have a defined, retained AC phase. */
export function nonzeroAcMeasurement(
  kind: CircuitPartKind,
  reading: CircuitPartReading | undefined,
  quantity: "voltage" | "current",
  expressions?: CircuitAnalysis["precisionExpressions"],
) {
  const scalar = quantity === "voltage" ? reading?.voltageVolts : reading?.currentAmps;
  if (scalar === undefined || !Number.isFinite(scalar)) { return false; }
  if (scalar !== 0) { return true; }
  const phase = quantity === "voltage" ? reading?.voltagePhaseDegrees : reading?.currentPhaseDegrees;
  const precision = readOptionalPrecision(() => quantity === "voltage" ? reading?.exactVoltage
    : reading?.exactTerminalCurrents?.[kind === "op-amp" ? "c" : "a"]);
  const value = restoredReadingComplex(precision, scalar, phase, true, expressions);
  // Self-division preserves nonzero magnitudes below binary64's scalar range.
  return Boolean(value && complexMagnitude(complexDivide(value, value)) === 1);
}
