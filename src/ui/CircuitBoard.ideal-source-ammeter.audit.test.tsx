import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { circuitPartCatalog, type CircuitDocument, type CircuitPartKind, type CircuitTerminal } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { CircuitBoard } from "./CircuitBoard.js";

const part = (id: string, kind: CircuitPartKind) => ({
  id,
  kind,
  label: id,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
});

const wire = (id: string, from: string, fromTerminal: CircuitTerminal, to: string, toTerminal: CircuitTerminal) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

describe("ideal source loop meter readout", () => {
  it("hides an indeterminate ammeter current on the circuit board", () => {
    const document: CircuitDocument = {
      title: "理想電源並列電流計",
      parts: [
        part("source", "ac-source"),
        part("load", "resistor"),
        part("meter", "ammeter"),
        part("battery", "battery"),
      ],
      wires: [
        wire("source-load", "source", "a", "load", "a"),
        wire("load-meter", "load", "b", "meter", "a"),
        wire("meter-source", "meter", "b", "source", "b"),
        wire("battery-a", "battery", "a", "meter", "a"),
        wire("battery-b", "battery", "b", "meter", "b"),
      ],
    };
    const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });

    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.parts.meter.meterStatus).toBe("floating");
    expect(Number.isFinite(analysis.parts.meter.currentAmps)).toBe(true);

    const markup = renderToStaticMarkup(
      <CircuitBoard document={document} analysis={analysis} readOnly renderControls={null} />,
    );
    expect(markup).toContain('data-meter-status="floating"');
    expect(markup).toContain("— A · 値不定");
    expect(markup).not.toContain("A RMS");
  });
});
