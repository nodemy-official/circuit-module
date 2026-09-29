import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  terminalsOf,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { analyzeAnalogCircuit } from "../analog-solver.js";

const part = (
  id: string,
  kind: CircuitPartKind,
  extra: Partial<CircuitPart> = {},
): CircuitPart => ({ id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...extra });

const wire = (
  id: string,
  from: string,
  fromTerminal: CircuitTerminal,
  to: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

function mixedSourceCircuit(): CircuitDocument {
  return {
    title: "電池と異周波数電源を含む交流回路",
    parts: [
      part("source-50", "ac-source", { voltageVolts: 10, frequencyHz: 50 }),
      part("load", "resistor", { resistanceOhms: 20 }),
      part("battery", "battery", { voltageVolts: 5, internalResistanceOhms: 5 }),
      part("source-60", "ac-source", { voltageVolts: 7, frequencyHz: 60 }),
      part("dc-current", "current-source", { currentAmps: 0.1 }),
    ],
    wires: [
      wire("series-load", "source-50", "a", "load", "a"),
      wire("series-battery", "load", "b", "battery", "a"),
      wire("series-source-60", "battery", "b", "source-60", "a"),
      wire("series-return", "source-60", "b", "source-50", "b"),
      wire("dc-current-a", "dc-current", "a", "load", "a"),
      wire("dc-current-b", "dc-current", "b", "load", "b"),
    ],
  };
}

function netKclSums(document: CircuitDocument, readings: ReturnType<typeof analyzeAnalogCircuit>) {
  const parent = new Map<string, string>();
  const key = (partId: string, terminal: CircuitTerminal) => JSON.stringify([partId, terminal]);
  const find = (endpoint: string): string => {
    const root = parent.get(endpoint);
    if (root === undefined) { parent.set(endpoint, endpoint); return endpoint; }
    if (root === endpoint) { return endpoint; }
    const result = find(root);
    parent.set(endpoint, result);
    return result;
  };
  for (const item of document.parts) {
    for (const terminal of terminalsOf(item.kind)) { find(key(item.id, terminal)); }
  }
  for (const connection of document.wires) {
    const from = find(key(connection.from.partId, connection.from.terminal));
    const to = find(key(connection.to.partId, connection.to.terminal));
    if (from !== to) { parent.set(from, to); }
  }
  const nodes = new Map<string, Array<{ partId: string; terminal: CircuitTerminal }>>();
  for (const item of document.parts) {
    for (const terminal of terminalsOf(item.kind)) {
      const root = find(key(item.id, terminal));
      const endpoints = nodes.get(root) ?? [];
      endpoints.push({ partId: item.id, terminal });
      nodes.set(root, endpoints);
    }
  }
  const sums: Array<{ real: number; imaginary: number }> = [];
  for (const endpoints of nodes.values()) {
    const current = endpoints.reduce((sum, endpoint) => {
      const value = readings.parts[endpoint.partId]?.terminalCurrents[endpoint.terminal];
      return { real: sum.real + (value?.real ?? 0), imaginary: sum.imaginary + (value?.imaginary ?? 0) };
    }, { real: 0, imaginary: 0 });
    sums.push(current);
  }
  return sums;
}

describe("mixed-source AC small-signal audit", () => {
  it("does not combine a source whose frequency differs by 5e-10 relative", () => {
    const document: CircuitDocument = {
      title: "ごく近い別周波数の交流源",
      parts: [
        part("source-50", "ac-source", { voltageVolts: 10, frequencyHz: 50 }),
        part("source-near-50", "ac-source", { voltageVolts: 7, frequencyHz: 50.000_000_025 }),
        part("load", "resistor", { resistanceOhms: 20 }),
      ],
      wires: [
        wire("series-load", "source-50", "a", "load", "a"),
        wire("series-source", "load", "b", "source-near-50", "b"),
        wire("series-return", "source-near-50", "a", "source-50", "b"),
      ],
    };

    const result = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 50 });

    // A single-frequency phasor solve excites the 50 Hz source. The nearby
    // source is a different tone and is set to zero for this analysis.
    expect(result.status, result.message).toBe("closed");
    expect(result.parts.load.voltageVolts).toBeCloseTo(10, 12);
    expect(result.parts.load.currentAmps).toBeCloseTo(0.5, 12);
    expect(result.parts["source-near-50"].voltageVolts).toBe(0);
    expect(result.issues.some((issue) => issue.message.includes("解析周波数と異なる"))).toBe(true);
  });

  it("does not count a nearby distinct-frequency source as active for status", () => {
    const document: CircuitDocument = {
      title: "近接する別周波数だけの回路",
      parts: [
        part("source-near-50", "ac-source", { voltageVolts: 7, frequencyHz: 50.000_000_025 }),
        part("load", "resistor", { resistanceOhms: 20 }),
      ],
      wires: [
        wire("series-load", "source-near-50", "a", "load", "a"),
        wire("series-return", "load", "b", "source-near-50", "b"),
      ],
    };

    const result = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 50 });

    expect(result.status).toBe("idle");
    expect(result.parts.load.voltageVolts).toBe(0);
    expect(result.issues.some((issue) => issue.message.includes("解析周波数と異なる"))).toBe(true);
  });

  it.each([
    { frequencyHz: 50, activeSource: "source-50", sourceVoltage: 10 },
    { frequencyHz: 60, activeSource: "source-60", sourceVoltage: 7 },
  ])("uses the $frequencyHz Hz source and suppresses the other source types", ({
    frequencyHz,
    activeSource,
    sourceVoltage,
  }) => {
    const document = mixedSourceCircuit();
    const result = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    const analog = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });
    const expectedCurrent = sourceVoltage / (20 + 5);
    const expectedLoadVoltage = expectedCurrent * 20;
    const expectedBatteryVoltage = expectedCurrent * 5;
    const signedLoadVoltage = activeSource === "source-50" ? expectedLoadVoltage : -expectedLoadVoltage;

    expect(result.status, result.message).toBe("closed");
    expect(result.parts.load.currentAmps).toBeCloseTo(expectedCurrent, 12);
    expect(result.parts.load.voltageVolts).toBeCloseTo(expectedLoadVoltage, 12);
    expect(result.parts.load.powerWatts).toBeCloseTo(expectedCurrent ** 2 * 20, 12);
    expect(result.parts.battery.currentAmps).toBeCloseTo(expectedCurrent, 12);
    expect(result.parts.battery.voltageVolts).toBeCloseTo(expectedBatteryVoltage, 12);
    expect(result.parts.battery.powerWatts).toBeCloseTo(expectedCurrent ** 2 * 5, 12);
    expect(result.parts[activeSource].powerWatts).toBeCloseTo(sourceVoltage * expectedCurrent, 12);

    const inactiveSource = activeSource === "source-50" ? "source-60" : "source-50";
    expect(result.parts[inactiveSource].voltageVolts).toBe(0);
    expect(result.parts[inactiveSource].currentAmps).toBeCloseTo(expectedCurrent, 12);
    expect(result.parts[inactiveSource].powerWatts).toBeCloseTo(0, 12);
    expect(analog.parts["dc-current"].current).toEqual({ real: 0, imaginary: 0 });
    expect(analog.parts["dc-current"].voltage.real).toBeCloseTo(signedLoadVoltage, 12);
    expect(analog.parts["dc-current"].voltage.imaginary).toBeCloseTo(0, 12);
    for (const current of netKclSums(document, analog)) {
      expect(current.real).toBeCloseTo(0, 12);
      expect(current.imaginary).toBeCloseTo(0, 12);
    }

    // RMS complex power delivered by the active source equals resistor and battery losses.
    expect(result.parts[activeSource].powerWatts).toBeCloseTo(
      result.parts.load.powerWatts + result.parts.battery.powerWatts,
      12,
    );
  });

  it("uses battery and DC-current-source bias for nonlinear AC conductance while opening the DC source", () => {
    const document: CircuitDocument = {
      title: "直流バイアスを含む交流ダイオード回路",
      parts: [
        part("battery", "battery", { voltageVolts: 5, internalResistanceOhms: 1000 }),
        part("source", "ac-source", { voltageVolts: 1, frequencyHz: 1000 }),
        part("diode", "diode", { saturationCurrentAmps: 1e-12, emissionCoefficient: 1 }),
        part("dc-current", "current-source", { currentAmps: 1e-3 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-to-battery", "source", "b", "battery", "a"),
        wire("source-to-diode", "source", "a", "diode", "a"),
        wire("current-to-diode", "dc-current", "a", "diode", "a"),
        wire("diode-ground", "diode", "b", "ground", "a"),
        wire("current-ground", "dc-current", "b", "ground", "a"),
        wire("battery-ground", "battery", "b", "ground", "a"),
      ],
    };
    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
    const result = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });
    const saturationCurrent = 1e-12;
    const thermalVoltage = 0.025_85;
    const smallSignalConductance = (dc.parts.diode.current.real + saturationCurrent) / thermalVoltage;
    const expectedDiodeVoltage = 1 / (1 + 1000 * smallSignalConductance);
    const expectedCurrent = expectedDiodeVoltage * smallSignalConductance;

    expect(dc.status, dc.message).toBe("valid");
    expect(ac.status, ac.message).toBe("valid");
    expect(result.status, result.message).toBe("closed");
    expect(dc.parts.diode.current.real).toBeGreaterThan(0);
    expect(dc.parts["dc-current"].current.real).toBeCloseTo(1e-3, 10);
    expect(ac.parts.diode.voltage.real).toBeCloseTo(expectedDiodeVoltage, 10);
    expect(ac.parts.diode.voltage.imaginary).toBeCloseTo(0, 10);
    expect(ac.parts.diode.current.real).toBeCloseTo(expectedCurrent, 10);
    expect(ac.parts["dc-current"].current).toEqual({ real: 0, imaginary: 0 });
    expect(ac.parts["dc-current"].voltage.real).toBeCloseTo(expectedDiodeVoltage, 10);
    expect(ac.parts.battery.power.real).toBeCloseTo(expectedCurrent ** 2 * 1000, 10);
    expect(ac.parts.diode.power.real).toBeCloseTo(expectedDiodeVoltage * expectedCurrent, 10);
    expect(result.parts.source.powerWatts).toBeCloseTo(
      ac.parts.battery.power.real + ac.parts.diode.power.real,
      10,
    );
    for (const current of netKclSums(document, ac)) {
      expect(current.real).toBeCloseTo(0, 10);
      expect(current.imaginary).toBeCloseTo(0, 10);
    }
  });
});
