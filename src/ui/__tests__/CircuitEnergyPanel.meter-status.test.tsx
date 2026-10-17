import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis, type CircuitPartReading } from "../../circuit-solver.js";
import { CircuitEnergyPanel } from "../CircuitEnergyPanel.js";

it("excludes a bypassed legacy ammeter's nonunique power while retaining valid load power", () => {
  const document = createCircuitFromSpecs([
    ["source", "battery", ["positive", "return"], { voltageVolts: 9 }],
    ["load", "resistor", ["positive", "meter-a"], { resistanceOhms: 10 }],
    ["meter", "ammeter", ["meter-a", "return"]],
  ]);
  const connected = analyzeCircuit(document);
  expect(connected.status).toBe("closed");
  expect(connected.parts.meter!.meterStatus).toBe("connected");
  const connectedMarkup = renderToStaticMarkup(<CircuitEnergyPanel document={document} analysis={connected} />);
  expect(connectedMarkup).toContain('data-part-id="meter" data-watts=');

  document.wires.push({ id: "bypass", from: { partId: "meter", terminal: "a" }, to: { partId: "meter", terminal: "b" } });
  const bypassed = analyzeCircuit(document);
  expect(bypassed.status).toBe("closed");
  expect(bypassed.parts.meter!.meterStatus).toBe("floating");
  expect(bypassed.parts.meter!.powerWatts).toBeGreaterThan(0);
  const markup = renderToStaticMarkup(<CircuitEnergyPanel document={document} analysis={bypassed} />);
  expect(markup).not.toContain('data-part-id="meter"');
  expect(markup).toContain('data-part-id="load" data-watts=');
});

const modes = ["dc", "ac", "transient"] as const;
const meterDocument: CircuitDocument = {
  title: "計器の電力表示",
  parts: [{ id: "meter", kind: "ammeter", label: "電流計", x: 0, y: 0 }],
  wires: [],
};

function meterMarkup(mode: typeof modes[number], meterStatus: NonNullable<CircuitPartReading["meterStatus"]>, powerWatts: number) {
  const reading = { voltageVolts: 0, currentAmps: 1, powerWatts, meterStatus };
  const analysis: CircuitAnalysis = {
    status: "closed", mode: mode === "ac" ? "ac" : "dc", frequencyHz: mode === "ac" ? 1000 : undefined,
    message: "解析完了", currentAmps: null, bulbPowerWatts: {}, parts: { meter: reading }, wireCurrents: {}, issues: [],
  };
  const frame = mode === "transient" ? {
    analysis: { status: "valid" as const, message: "過渡解析完了", issues: [], samples: [{ timeSeconds: 0, parts: { meter: reading } }] },
    sampleIndex: 0,
  } : undefined;
  return renderToStaticMarkup(<CircuitEnergyPanel document={meterDocument} analysis={analysis} frame={frame} />);
}

it.each(modes.flatMap((mode) => (["floating", "unconnected"] as const).map((meterStatus) => ({ mode, meterStatus }))))(
  "does not present $meterStatus meter power in $mode results",
  ({ mode, meterStatus }) => {
    const markup = meterMarkup(mode, meterStatus, 7);
    expect(markup).not.toContain('data-part-id="meter"');
    expect(markup).toContain("部品の電力データがありません。");
  },
);

it.each(modes)("keeps a connected meter's exact zero power available in %s results", (mode) => {
  const markup = meterMarkup(mode, "connected", 0);
  expect(markup).toContain("表示対象の電力はすべて 0 W です。");
  expect(markup).not.toContain("部品の電力データがありません。");
});
