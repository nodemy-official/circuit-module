// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import type { CircuitAnalysis, CircuitPartReading } from "../../circuit-solver.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { CircuitInspector } from "../CircuitInspector.js";
import { CircuitPreviewPanel } from "../CircuitPreviewPanel.js";
import { CircuitMeterReadout, getMeterDisplay } from "../CircuitMeterReadout.js";
import { CircuitBoard } from "../CircuitBoard.js";

function divider(voltageVolts: number) {
  const circuit = createCircuitFromSpecs([
    ["load", "resistor", ["l", "0"], { resistanceOhms: 1 }],
    ["source", "ac-source", ["s", "0"], { voltageVolts, frequencyHz: 1000, phaseDegrees: 37 }],
    ["series", "resistor", ["s", "m"], { resistanceOhms: 1 }],
    ["ammeter", "ammeter", ["m", "l"]],
    ["voltmeter", "voltmeter", ["l", "0"]],
    ["ground", "ground", ["0"]],
  ], "AC divider and meters below scalar precision");
  const analysis: CircuitAnalysis = JSON.parse(JSON.stringify(analyzeCircuit(circuit, {}, { mode: "ac", frequencyHz: 1000 })));
  return { circuit, analysis };
}

function render(element: React.ReactNode) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(element);
  return container;
}

function phaseRows({ circuit, analysis }: ReturnType<typeof divider>, precisionExpressions?: CircuitAnalysis["precisionExpressions"], partId = "load") {
  const inspector = render(<CircuitInspector
    part={circuit.parts.find((part) => part.id === partId)} reading={analysis.parts[partId]} analysisStatus={analysis.status} precisionExpressions={precisionExpressions}
  />);
  const preview = render(<CircuitPreviewPanel
    document={circuit} initialDocument={circuit} analysis={analysis} partId={partId} onChange={() => {}} onReset={() => {}}
  />);
  const selector = '[data-measurement="voltage-phase"], [data-measurement="current-phase"]';
  return { inspector: [...inspector.querySelectorAll(selector)], preview: [...preview.querySelectorAll(selector)] };
}

function expressionReferences(analysis: CircuitAnalysis) {
  const table: NonNullable<CircuitAnalysis["precisionExpressions"]>[number][] = [];
  for (const reading of Object.values(analysis.parts)) {
    for (const value of [reading.exactVoltage, ...Object.values(reading.exactTerminalCurrents ?? {})]) {
      if (!value || !("numerator" in value.real)) { continue; }
      const component = value.real;
      const sign = component.numerator.startsWith("-") ? -1 : BigInt(component.numerator) === 0n ? 0 : 1;
      value.real = { expression: table.length, sign };
      table.push({ operation: "literal", numerator: component.numerator, denominator: component.denominator });
    }
  }
  analysis.precisionExpressions = table;
}

describe("AC phase readouts below scalar precision", () => {
  it.each([1, Number.MIN_VALUE])("keeps the defined phase of a divider and connected meters at source RMS %s", (voltage) => {
    const fixture = divider(voltage);
    const { inspector, preview } = phaseRows(fixture);
    expect(inspector).toHaveLength(2);
    expect(preview).toHaveLength(2);
    for (const row of [...inspector, ...preview]) { expect(row.textContent).toContain("37"); }

    for (const id of ["ammeter", "voltmeter"] as const) {
      const display = getMeterDisplay(id, fixture.analysis.parts[id], fixture.analysis.status);
      expect(display?.status).toBe("connected");
      expect(display?.phaseText).toContain("+37°");
      const meter = render(<CircuitMeterReadout kind={id} reading={fixture.analysis.parts[id]} analysisStatus={fixture.analysis.status} />);
      expect(meter.querySelector(".circuit-meter-readout__phase")?.textContent).toContain("+37°");
    }
    if (voltage === Number.MIN_VALUE) {
      expect(fixture.analysis.parts.load!.voltageVolts).toBe(0);
      expect(fixture.analysis.parts.load!.currentAmps).toBe(0);
    }
  });

  it("keeps true-zero phases hidden", () => {
    const fixture = divider(0);
    const { inspector, preview } = phaseRows(fixture);
    expect(inspector).toHaveLength(0);
    expect(preview).toHaveLength(0);
    for (const id of ["ammeter", "voltmeter"] as const) {
      expect(getMeterDisplay(id, fixture.analysis.parts[id], fixture.analysis.status)?.phaseText).toBeUndefined();
    }
  });

  it.each(["stale", "unreadable", "malformed"] as const)("uses zero scalar readings when optional precision is %s", (metadata) => {
    const fixture = divider(3 * Number.MIN_VALUE);
    for (const reading of Object.values(fixture.analysis.parts)) {
      reading.voltageVolts = 0;
      reading.currentAmps = 0;
      for (const field of ["exactVoltage", "exactTerminalCurrents"] as const) {
        if (metadata === "unreadable") {
          Object.defineProperty(reading, field, { get() { throw new Error("Optional precision unavailable"); } });
        }
        if (metadata === "malformed") { Reflect.set(reading, field, false); }
      }
    }
    const { inspector, preview } = phaseRows(fixture);
    expect(inspector).toHaveLength(0);
    expect(preview).toHaveLength(0);
    for (const id of ["ammeter", "voltmeter"] as const) {
      expect(getMeterDisplay(id, fixture.analysis.parts[id], fixture.analysis.status)?.phaseText).toBeUndefined();
    }
  });

  it("passes expression tables through analysis-owning views while standalone readouts keep a scalar fallback", () => {
    const fixture = divider(Number.MIN_VALUE);
    expressionReferences(fixture.analysis);
    expect(phaseRows(fixture).inspector).toHaveLength(0);
    const rows = phaseRows(fixture, fixture.analysis.precisionExpressions);
    expect(rows.inspector).toHaveLength(2);
    expect(rows.preview).toHaveLength(2);
    for (const id of ["ammeter", "voltmeter"] as const) {
      expect(getMeterDisplay(id, fixture.analysis.parts[id], fixture.analysis.status)?.phaseText).toBeUndefined();
      expect(getMeterDisplay(id, fixture.analysis.parts[id], fixture.analysis.status, fixture.analysis.precisionExpressions)?.phaseText).toContain("+37°");
    }
    const board = render(<CircuitBoard document={fixture.circuit} analysis={fixture.analysis} readOnly />);
    for (const id of ["ammeter", "voltmeter"]) {
      expect(board.querySelector(`[data-part-id="${id}"] > title`)?.textContent).toContain("+37°");
    }
  });

  it("does not define a phase for a floating or unconnected meter", () => {
    const { analysis } = divider(Number.MIN_VALUE);
    for (const meterStatus of ["floating", "unconnected"] as const) {
      const reading: CircuitPartReading = { ...analysis.parts.voltmeter!, meterStatus };
      expect(getMeterDisplay("voltmeter", reading, analysis.status)?.phaseText).toBeUndefined();
    }
  });

  it("uses the op-amp output terminal for an underflowed current phase", () => {
    const circuit = createCircuitFromSpecs([
      ["amplifier", "op-amp", ["input", "0", "output"], { openLoopGain: 1 }],
      ["source", "ac-source", ["input", "0"], { voltageVolts: Number.MIN_VALUE, frequencyHz: 1000, phaseDegrees: 0 }],
      ["load", "resistor", ["output", "0"], { resistanceOhms: 2 }],
      ["ground", "ground", ["0"]],
    ], "Op-amp output phase below scalar precision");
    const analysis = analyzeCircuit(circuit, {}, { mode: "ac", frequencyHz: 1000 });
    expect(analysis.parts.amplifier!.currentAmps).toBe(0);
    const rows = phaseRows({ circuit, analysis }, undefined, "amplifier");

    expect(rows.inspector).toHaveLength(2);
    expect(rows.preview).toHaveLength(2);
    expect(rows.inspector[1]?.textContent).toContain("180");
    expect(rows.preview[1]?.textContent).toContain("180");
  });

  it("uses a scalar fallback when an analysis expression table becomes unreadable", () => {
    const fixture = divider(Number.MIN_VALUE);
    expressionReferences(fixture.analysis);
    Object.defineProperty(fixture.analysis, "precisionExpressions", {
      get() { throw new Error("Optional expression table unavailable"); },
    });

    const rows = phaseRows(fixture);
    expect(rows.inspector).toHaveLength(0);
    expect(rows.preview).toHaveLength(0);
    const board = render(<CircuitBoard document={fixture.circuit} analysis={fixture.analysis} readOnly />);
    for (const id of ["ammeter", "voltmeter"]) {
      expect(board.querySelector(`[data-part-id="${id}"] > title`)?.textContent).not.toContain("位相");
    }
  });
});
