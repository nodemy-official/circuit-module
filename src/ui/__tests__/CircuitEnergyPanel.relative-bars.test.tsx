// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { analyzeCircuit } from "../../circuit-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../../__tests__/helpers/circuit-fixture.js";
import { assertCorrectRounding, multiplyRational, rational, rationalFromNumber } from "../../__tests__/helpers/numeric-oracle.js";
import { CircuitEnergyPanel } from "../CircuitEnergyPanel.js";

function powerWidth(container: ParentNode, partId: string) {
  return Number.parseFloat(container.querySelector<HTMLElement>(`.circuit-energy__power-row[data-part-id="${partId}"] .circuit-energy__bar-fill`)?.style.width ?? "NaN");
}

function quantityWidth(container: ParentNode, partId: string, attribute: string) {
  return Number.parseFloat(container.querySelector<HTMLElement>(`[data-part-id="${partId}"][${attribute}] .circuit-energy__quantity-bar-fill`)?.style.width ?? "NaN");
}

it.each((["dc", "ac"] as const).flatMap((mode) => [0, -537].flatMap((exponent) =>
  [false, true].map((parallel) => ({ mode, exponent, parallel })),
)))("preserves $mode power ratios at scale 2^$exponent (parallel=$parallel)", ({ mode, exponent, parallel }) => {
  const circuit = createCircuitFromSpecs([
    ["source", mode === "ac" ? "ac-source" : "battery", ["a", "0"], { voltageVolts: 2 ** exponent, frequencyHz: 1, phaseDegrees: 45 }],
    ["upper", "resistor", ["a", parallel ? "0" : "b"], { resistanceOhms: 2 }],
    ["lower", "resistor", [parallel ? "a" : "b", "0"], { resistanceOhms: 1 }],
    ["ground", "ground", ["0"]],
  ], "power ratio below scalar precision");
  const analysis = analyzeCircuit(circuit, {}, { mode });
  expect(analysis.status, analysis.message).toBe("closed");
  for (const transported of [analysis, structuredClone(analysis), JSON.parse(JSON.stringify(analysis)) as typeof analysis]) {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<CircuitEnergyPanel document={circuit} analysis={transported} />);
    // In series the powers are 2V²/9 and V²/9; in parallel they are V²/2 and V².
    assertCorrectRounding(powerWidth(container, "upper"), rational(parallel ? 50n : 100n, 3n), "upper relative power");
    assertCorrectRounding(powerWidth(container, "lower"), rational(parallel ? 100n : 50n, 3n), "lower relative power");
  }
});

it("retains an absorbing source's negative direction when its scalar power rounds to zero", () => {
  const scale = 2 ** -540;
  const circuit = createCircuitFromSpecs([
    ["supply", "battery", ["a", "0"], { voltageVolts: scale * 2 }],
    ["absorbing", "battery", ["a", "b"], { voltageVolts: scale }],
    ["load", "resistor", ["b", "0"], { resistanceOhms: 1 }],
    ["ground", "ground", ["0"]],
  ], "underflowing source absorption");
  const analysis = analyzeCircuit(circuit);
  expect(analysis.status, analysis.message).toBe("closed");
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<CircuitEnergyPanel document={circuit} analysis={analysis} />);
  const row = container.querySelector('[data-part-id="absorbing"][data-watts]');
  expect(row?.getAttribute("data-sign")).toBe("negative");
  expect(powerWidth(container, "absorbing")).toBe(25);
  expect(row?.querySelector<HTMLElement>(".circuit-energy__bar-fill")?.style.left).toBe("25%");
});

it("retains an op-amp's negative component power when the scalar power rounds to zero", () => {
  const circuit = createCircuitFromSpecs([
    ["input", "battery", ["input", "0"], { voltageVolts: 2 ** -540 }],
    ["amplifier", "op-amp", ["input", "0", "out"], { openLoopGain: 1 }],
    ["load", "resistor", ["out", "0"], { resistanceOhms: 1 }],
    ["ground", "ground", ["0"]],
  ], "underflowing op-amp output power");
  const analysis = analyzeCircuit(circuit);
  expect(analysis.status, analysis.message).toBe("closed");
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<CircuitEnergyPanel document={circuit} analysis={analysis} />);
  expect(container.querySelector('[data-part-id="amplifier"][data-watts]')?.getAttribute("data-sign")).toBe("negative");
  expect(powerWidth(container, "amplifier")).toBe(50);
  expect(powerWidth(container, "load")).toBe(50);
});

it("retains relative stored energy after all scalar joule values underflow", () => {
  const circuit = createCircuitFromSpecs([
    ["small", "capacitor", ["a", "b"], { capacitanceFarads: 1, initialVoltageVolts: 2 ** -540 }],
    ["large", "capacitor", ["c", "d"], { capacitanceFarads: 2, initialVoltageVolts: 2 ** -540 }],
  ], "underflowing stored energy");
  const transient = simulateTransient(circuit, { durationSeconds: 1, timeStepSeconds: 1 });
  expect(transient.status, transient.message).toBe("valid");
  for (const transported of [transient, structuredClone(transient), JSON.parse(JSON.stringify(transient)) as typeof transient]) {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<CircuitEnergyPanel document={circuit} analysis={analyzeCircuit(circuit)} frame={{ analysis: transported, sampleIndex: 0 }} />);
    expect(quantityWidth(container, "small", "data-energy-joules")).toBe(50);
    expect(quantityWidth(container, "large", "data-energy-joules")).toBe(100);
  }
});

it("retains relative dissipated energy after all scalar joule values underflow", () => {
  const circuit = createCircuitFromSpecs([
    ["source", "battery", ["a", "0"], { voltageVolts: 2 ** -540 }],
    ["small", "resistor", ["a", "0"], { resistanceOhms: 2 }],
    ["large", "resistor", ["a", "0"], { resistanceOhms: 1 }],
    ["ground", "ground", ["0"]],
  ], "underflowing dissipated energy");
  const transient = simulateTransient(circuit, { durationSeconds: 1, timeStepSeconds: 0.5 });
  expect(transient.status, transient.message).toBe("valid");
  for (const transported of [transient, structuredClone(transient), JSON.parse(JSON.stringify(transient)) as typeof transient]) {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<CircuitEnergyPanel document={circuit} analysis={analyzeCircuit(circuit)} frame={{ analysis: transported, sampleIndex: 2 }} />);
    expect(quantityWidth(container, "small", "data-dissipated-joules")).toBe(50);
    expect(quantityWidth(container, "large", "data-dissipated-joules")).toBe(100);
  }
});

it.each(["override", "stale", "unreadable", "malformed"] as const)("keeps scalar power authoritative after %s optional precision", (change) => {
  const circuit = createCircuitFromSpecs([
    ["source", "battery", ["a", "0"], { voltageVolts: 1 }],
    ["upper", "resistor", ["a", "b"], { resistanceOhms: 2 }],
    ["lower", "resistor", ["b", "0"], { resistanceOhms: 1 }],
    ["ground", "ground", ["0"]],
  ], "scalar power authority");
  const analysis = analyzeCircuit(circuit);
  const lower = analysis.parts.lower!;
  if (change === "override") { lower.powerWatts = 0.25; }
  if (change === "stale") { lower.currentAmps = 0.5; }
  if (change === "unreadable") { Object.defineProperty(lower, "exactVoltage", { get() { throw new Error("optional metadata"); } }); }
  if (change === "malformed") { lower.exactVoltage!.real = { numerator: "invalid", denominator: "1" }; }
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<CircuitEnergyPanel document={circuit} analysis={analysis} />);
  assertCorrectRounding(powerWidth(container, "lower"), multiplyRational(rationalFromNumber(lower.powerWatts)!, rational(150n)), "scalar relative power");
});

it("preserves multi-terminal power after equivalent voltage differences are reversed", () => {
  const circuit = createCircuitFromSpecs([
    ["source", "battery", ["a", "0"], { voltageVolts: 2 ** -537 }],
    ["pot", "potentiometer", ["a", "0", "wiper"], { resistanceOhms: 3, wiperPosition: 1 / 3 }],
    ["ground", "ground", ["0"]],
  ], "reversed local voltage differences");
  const analysis = analyzeCircuit(circuit);
  expect(analysis.status, analysis.message).toBe("closed");
  for (const difference of analysis.parts.pot!.terminalVoltageDifferences!) {
    [difference.fromTerminal, difference.toTerminal] = [difference.toTerminal, difference.fromTerminal];
    difference.voltageVolts = -difference.voltageVolts;
    const metadata = difference.exactVoltage;
    if (!metadata) { continue; }
    if (!("numerator" in metadata.real)) { throw new Error("Expected a literal exact DC voltage"); }
    metadata.real.numerator = metadata.real.numerator.startsWith("-") ? metadata.real.numerator.slice(1) : `-${metadata.real.numerator}`;
    if (metadata.projection) { metadata.projection.real = -metadata.projection.real; }
  }
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<CircuitEnergyPanel document={circuit} analysis={analysis} />);
  expect(powerWidth(container, "pot")).toBe(50);
});

it.each(["negative", "imaginary", "unreadable", "deep-edit", "numerator-getter", "denominator-getter", "expression-getter"] as const)("invalidates cached relative energies after %s metadata changes", (change) => {
  const circuit = createCircuitFromSpecs([
    ["small", "capacitor", ["a", "b"], { capacitanceFarads: 1, initialVoltageVolts: 2 ** -540 }],
    ["large", "capacitor", ["c", "d"], { capacitanceFarads: 2, initialVoltageVolts: 2 ** -540 }],
  ], "edited energy metadata");
  const transient = simulateTransient(circuit, { durationSeconds: 1, timeStepSeconds: 1 });
  const analysis = analyzeCircuit(circuit);
  const render = () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<CircuitEnergyPanel document={circuit} analysis={analysis} frame={{ analysis: transient, sampleIndex: 0 }} />);
    return container;
  };
  expect(quantityWidth(render(), "small", "data-energy-joules")).toBe(50);
  const cached = transient.energyReadings!.small!.samples[0]!;
  if (change === "unreadable") { Object.defineProperty(cached, "exactStoredJoules", { get() { throw new Error("optional energy"); } }); }
  else {
    const magnitude = { numerator: "1", denominator: `0x${(2n ** 1081n).toString(16)}` };
    Reflect.set(cached, "exactStoredJoules", change === "imaginary" ? { real: magnitude, imaginary: magnitude }
      : change === "negative" ? { ...magnitude, numerator: "-1" } : magnitude);
    if (change === "deep-edit") { Reflect.set(cached.exactStoredJoules!, "numerator", "0"); }
    if (change.endsWith("-getter")) {
      Object.defineProperty(cached.exactStoredJoules!, change.slice(0, -7), { get() { throw new Error("optional exact component"); } });
    }
  }
  expect(quantityWidth(render(), "small", "data-energy-joules")).toBe(0);
});
