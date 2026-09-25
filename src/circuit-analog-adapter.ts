import { analyzeAnalogCircuit, type ComplexValue, type AnalogCircuitPartReading } from "./analog-solver.js";
import type { CircuitDocument, CircuitPart, CircuitTerminal } from "./circuit-model.js";
import type { CircuitAnalysis, CircuitAnalysisOptions, CircuitPartReading } from "./circuit-solver.js";

const sourceKinds = new Set(["battery", "ac-source", "current-source"]);
const magnitude = (value: ComplexValue) => Math.hypot(value.real, value.imaginary);
const phase = (value: ComplexValue) => magnitude(value) < 1e-15 ? 0 : Math.atan2(value.imaginary, value.real) * 180 / Math.PI;

function terminalValues(values: Partial<Record<CircuitTerminal, ComplexValue>>, ac: boolean) {
  return Object.fromEntries(Object.entries(values).map(([terminal, value]) =>
    [terminal, ac ? magnitude(value) : value.real],
  ));
}

function adaptReading(part: CircuitPart, reading: AnalogCircuitPartReading, ac: boolean): CircuitPartReading {
  const powerWatts = part.kind === "capacitor" || part.kind === "inductor" ? 0
    : reading.power.real * (sourceKinds.has(part.kind) ? -1 : 1);
  const result: CircuitPartReading = {
    voltageVolts: ac ? magnitude(reading.voltage) : reading.voltage.real,
    currentAmps: ac ? magnitude(reading.current) : reading.current.real,
    powerWatts,
    terminalVoltages: terminalValues(reading.terminalVoltages, ac),
    terminalCurrents: terminalValues(reading.terminalCurrents, ac),
    ...(reading.meterStatus ? { meterStatus: reading.meterStatus } : {}),
  };
  if (ac) {
    result.voltagePhaseDegrees = phase(reading.voltage);
    result.currentPhaseDegrees = phase(reading.current);
    result.reactivePowerVars = reading.power.imaginary;
    result.terminalVoltagePhasesDegrees = Object.fromEntries(Object.entries(reading.terminalVoltages).map(([terminal, value]) => [terminal, phase(value)]));
    result.terminalCurrentPhasesDegrees = Object.fromEntries(Object.entries(reading.terminalCurrents).map(([terminal, value]) => [terminal, phase(value)]));
  }
  if (part.kind === "bulb") { result.brightness = Math.max(0, Math.min(1, powerWatts / (part.ratedPowerWatts ?? 2))); }
  if (part.kind === "led" && !ac) { result.brightness = Math.max(0, Math.min(1, result.currentAmps / (part.ratedCurrentAmps ?? 0.02))); }
  return result;
}

/** Bridges complex circuit analysis to the editor's scalar reading API. */
export function analyzeExtendedCircuit(
  document: CircuitDocument,
  switchStates: Record<string, boolean>,
  options: CircuitAnalysisOptions,
): CircuitAnalysis {
  const firstAc = document.parts.find((part) => part.kind === "ac-source");
  const mode = options.mode === "ac" || (options.mode !== "dc" && firstAc) ? "ac" : "dc";
  const frequencyHz = options.frequencyHz ?? firstAc?.frequencyHz ?? 1000;
  const analog = analyzeAnalogCircuit(document, { mode, frequencyHz, switchStates });
  const parts: Record<string, CircuitPartReading> = {};
  for (const part of document.parts) {
    const reading = analog.parts[part.id];
    if (reading) { parts[part.id] = adaptReading(part, reading, mode === "ac"); }
  }
  const sources = document.parts.filter((part) => sourceKinds.has(part.kind));
  const status = analog.status === "valid"
    ? sources.length > 0 || document.parts.some((part) => part.kind === "op-amp") ? "closed" : "idle"
    : analog.status;
  const currentAmps = analog.status === "valid" && sources.length === 1 && !document.parts.some((part) => part.kind === "op-amp")
    ? Math.abs(parts[sources[0].id]?.currentAmps ?? 0) : null;
  return {
    status,
    message: analog.message,
    mode,
    ...(mode === "ac" ? { frequencyHz } : {}),
    currentAmps,
    parts,
    bulbPowerWatts: Object.fromEntries(document.parts.filter((part) => part.kind === "bulb").map((part) => [part.id, parts[part.id]?.powerWatts ?? 0])),
    // Ideal wires can form loops with indeterminate branch currents; do not invent flow directions.
    wireCurrents: {},
    issues: analog.issues,
  };
}
