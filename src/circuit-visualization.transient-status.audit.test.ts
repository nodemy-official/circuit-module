import { describe, expect, it } from "vitest";

import type { CircuitDocument } from "./circuit-model.js";
import { analysisAtTransientFrame } from "./circuit-visualization.js";
import { analyzeCircuit } from "./circuit-solver.js";
import { simulateTransient } from "./transient-solver.js";

describe("transient frame public analysis status", () => {
  it("preserves an open-circuit state in a sampled frame", () => {
    const document: CircuitDocument = {
      title: "開スイッチを含む過渡回路",
      parts: [
        { id: "battery", kind: "battery", label: "電池", x: 0, y: 0, voltageVolts: 5 },
        { id: "switch", kind: "switch", label: "スイッチ", x: 1, y: 0, initiallyClosed: true },
        { id: "resistor", kind: "resistor", label: "抵抗", x: 2, y: 0, resistanceOhms: 100 },
        { id: "capacitor", kind: "capacitor", label: "コンデンサー", x: 3, y: 0, capacitanceFarads: 0.001 },
      ],
      wires: [
        { id: "w1", from: { partId: "battery", terminal: "a" }, to: { partId: "switch", terminal: "a" } },
        { id: "w2", from: { partId: "switch", terminal: "b" }, to: { partId: "resistor", terminal: "a" } },
        { id: "w3", from: { partId: "resistor", terminal: "b" }, to: { partId: "capacitor", terminal: "a" } },
        { id: "w4", from: { partId: "capacitor", terminal: "b" }, to: { partId: "battery", terminal: "b" } },
      ],
    };
    const transient = simulateTransient(document, {
      durationSeconds: 0.001,
      timeStepSeconds: 0.001,
      switchStates: { switch: false },
    });
    expect(transient.status, transient.message).toBe("valid");

    const frame = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 0 });

    expect(frame?.status).toBe("open");
    expect(frame?.parts.resistor.currentAmps).toBeCloseTo(0, 12);
  });

  it("keeps an RC charging frame closed even though its DC steady state is open", () => {
    const document: CircuitDocument = {
      title: "RC charging",
      parts: [
        { id: "battery", kind: "battery", label: "電池", x: 0, y: 0, voltageVolts: 5 },
        { id: "resistor", kind: "resistor", label: "抵抗", x: 1, y: 0, resistanceOhms: 100 },
        { id: "capacitor", kind: "capacitor", label: "コンデンサー", x: 2, y: 0, capacitanceFarads: 0.001 },
        { id: "ground", kind: "ground", label: "GND", x: 3, y: 0 },
      ],
      wires: [
        { id: "w1", from: { partId: "battery", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
        { id: "w2", from: { partId: "resistor", terminal: "b" }, to: { partId: "capacitor", terminal: "a" } },
        { id: "w3", from: { partId: "capacitor", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
        { id: "w4", from: { partId: "ground", terminal: "a" }, to: { partId: "battery", terminal: "b" } },
      ],
    };
    const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(transient.status, transient.message).toBe("valid");
    expect(analyzeCircuit(document, {}, { mode: "dc" }).status).toBe("open");

    const frame = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 0 });

    expect(frame?.status).toBe("closed");
  });

  it("reports a source-free LC discharge as closed while stored inductor energy remains", () => {
    const document: CircuitDocument = {
      title: "電源のないLC放電",
      parts: [
        { id: "inductor", kind: "inductor", label: "コイル", x: 0, y: 0, inductanceHenries: 0.1, initialCurrentAmps: 0.1 },
        { id: "resistor", kind: "resistor", label: "抵抗", x: 1, y: 0, resistanceOhms: 10 },
        { id: "capacitor", kind: "capacitor", label: "コンデンサー", x: 2, y: 0, capacitanceFarads: 0.001, initialVoltageVolts: 1 },
      ],
      wires: [
        { id: "w1", from: { partId: "inductor", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
        { id: "w2", from: { partId: "resistor", terminal: "b" }, to: { partId: "capacitor", terminal: "a" } },
        { id: "w3", from: { partId: "capacitor", terminal: "b" }, to: { partId: "inductor", terminal: "b" } },
      ],
    };
    const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(transient.status, transient.message).toBe("valid");

    const frame = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 0 });

    expect(frame?.status).toBe("closed");
    expect(frame?.currentAmps).toBeNull();
  });

  it("checks an op-amp output path from C to the reference rather than between its inputs", () => {
    const document: CircuitDocument = {
      title: "入力端子が分離したオペアンプ出力回路",
      parts: [
        { id: "amp", kind: "op-amp", label: "オペアンプ", x: 0, y: 0 },
        { id: "load", kind: "resistor", label: "負荷", x: 1, y: 0, resistanceOhms: 100 },
        { id: "ground", kind: "ground", label: "GND", x: 2, y: 0 },
      ],
      wires: [
        { id: "w1", from: { partId: "amp", terminal: "c" }, to: { partId: "load", terminal: "a" } },
        { id: "w2", from: { partId: "load", terminal: "b" }, to: { partId: "ground", terminal: "a" } },
      ],
    };
    const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(transient.status, transient.message).toBe("valid");

    const frame = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 0 });

    expect(frame?.status).toBe("closed");
  });

  it("reports an unexcited transient network as idle", () => {
    const document: CircuitDocument = {
      title: "無励振RC回路",
      parts: [
        { id: "resistor", kind: "resistor", label: "抵抗", x: 0, y: 0, resistanceOhms: 10 },
        { id: "capacitor", kind: "capacitor", label: "コンデンサー", x: 1, y: 0, capacitanceFarads: 0.001 },
      ],
      wires: [
        { id: "w1", from: { partId: "resistor", terminal: "b" }, to: { partId: "capacitor", terminal: "a" } },
        { id: "w2", from: { partId: "capacitor", terminal: "b" }, to: { partId: "resistor", terminal: "a" } },
      ],
    };
    const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(transient.status, transient.message).toBe("valid");

    const frame = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 0 });

    expect(frame?.status).toBe("idle");
  });

  it("keeps a closed return path with multiple active voltage sources", () => {
    const document: CircuitDocument = {
      title: "複数電源の直列回路",
      parts: [
        { id: "battery-1", kind: "battery", label: "電池1", x: 0, y: 0, voltageVolts: 3 },
        { id: "battery-2", kind: "battery", label: "電池2", x: 1, y: 0, voltageVolts: 3 },
        { id: "resistor", kind: "resistor", label: "抵抗", x: 2, y: 0, resistanceOhms: 10 },
      ],
      wires: [
        { id: "w1", from: { partId: "battery-1", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
        { id: "w2", from: { partId: "resistor", terminal: "b" }, to: { partId: "battery-2", terminal: "a" } },
        { id: "w3", from: { partId: "battery-2", terminal: "b" }, to: { partId: "battery-1", terminal: "b" } },
      ],
    };
    const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(transient.status, transient.message).toBe("valid");

    const frame = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 0 });

    expect(frame?.status).toBe("closed");
    expect(frame?.currentAmps).toBeNull();
  });

  it("keeps an AC source loop closed at an instantaneous zero crossing", () => {
    const document: CircuitDocument = {
      title: "交流電源のゼロ交差",
      parts: [
        { id: "source", kind: "ac-source", label: "交流電源", x: 0, y: 0, voltageVolts: 5, frequencyHz: 1 },
        { id: "resistor", kind: "resistor", label: "抵抗", x: 1, y: 0, resistanceOhms: 10 },
      ],
      wires: [
        { id: "w1", from: { partId: "source", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
        { id: "w2", from: { partId: "resistor", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      ],
    };
    const transient = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.25 });
    expect(transient.status, transient.message).toBe("valid");
    expect(transient.samples[1]?.parts.source?.voltageVolts).toBeCloseTo(0, 12);

    const frame = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 1 });

    expect(frame?.status).toBe("closed");
    expect(frame?.parts.resistor.currentAmps).toBeCloseTo(0, 12);
  });

  it("does not treat an off MOS channel as a transient return path", () => {
    const document: CircuitDocument = {
      title: "遮断MOSFETを含む直流回路",
      parts: [
        { id: "battery", kind: "battery", label: "電池", x: 0, y: 0, voltageVolts: 5 },
        { id: "resistor", kind: "resistor", label: "抵抗", x: 1, y: 0, resistanceOhms: 100 },
        { id: "mos", kind: "nmos", label: "MOSFET", x: 2, y: 0 },
        { id: "ground", kind: "ground", label: "GND", x: 3, y: 0 },
      ],
      wires: [
        { id: "w1", from: { partId: "battery", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
        { id: "w2", from: { partId: "resistor", terminal: "b" }, to: { partId: "mos", terminal: "a" } },
        { id: "w3", from: { partId: "mos", terminal: "c" }, to: { partId: "battery", terminal: "b" } },
        { id: "w4", from: { partId: "mos", terminal: "b" }, to: { partId: "battery", terminal: "b" } },
        { id: "w5", from: { partId: "ground", terminal: "a" }, to: { partId: "battery", terminal: "b" } },
      ],
    };
    const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(transient.status, transient.message).toBe("valid");

    const frame = analysisAtTransientFrame(document, { analysis: transient, sampleIndex: 0 });

    expect(frame?.parts.mos.channelConducting).toBe(false);
    expect(frame?.status).toBe("open");
  });
});
