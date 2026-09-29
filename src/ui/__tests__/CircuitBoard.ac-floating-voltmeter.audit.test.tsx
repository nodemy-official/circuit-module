import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind, type CircuitTerminal } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { CircuitBoard } from "../CircuitBoard.js";

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  label: id,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (
  id: string,
  fromPart: string,
  fromTerminal: CircuitTerminal,
  toPart: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: fromPart, terminal: fromTerminal },
  to: { partId: toPart, terminal: toTerminal },
});

it("hides an AC voltmeter value when a zero-slope diode leaves its reference floating", () => {
  const document: CircuitDocument = {
    title: "Floating AC voltmeter",
    parts: [
      part("diode", "diode", {
        saturationCurrentAmps: Number.MIN_VALUE,
        emissionCoefficient: Number.MAX_VALUE,
      }),
      part("left-load", "resistor", { resistanceOhms: 1000 }),
      part("right-load", "resistor", { resistanceOhms: 2000 }),
      part("meter", "voltmeter"),
    ],
    wires: [
      wire("left-diode", "diode", "a", "left-load", "a"),
      wire("right-diode", "diode", "b", "right-load", "a"),
      wire("meter-left", "meter", "a", "diode", "a"),
      wire("meter-right", "meter", "b", "diode", "b"),
    ],
  };
  const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });
  const markup = renderToStaticMarkup(
    <CircuitBoard document={document} analysis={analysis} readOnly renderControls={null} />,
  );

  expect(analysis.parts.meter.meterStatus).toBe("floating");
  expect(markup).toContain('data-meter-status="floating"');
  expect(markup).toContain("— V · 値不定");
  expect(markup).not.toContain("V RMS");
});
