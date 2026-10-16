import { describe, expect, it } from "vitest";

import { circuitPartCatalog, type CircuitPart, type CircuitPartKind, type CircuitPartNumericKey } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { analysisAtTransientFrame, circuitNodes, circuitPotential } from "../../circuit-visualization.js";
import { simulateTransient } from "../../transient-solver.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

function withNumericGetOverride(part: CircuitPart, key: CircuitPartNumericKey, value: number) {
  return new Proxy(part, {
    get(target, property, receiver) {
      return property === key ? value : Reflect.get(target, property, receiver);
    },
  });
}

describe("transient frame own part values", () => {
  it.each([
    { kind: "bulb", key: "ratedPowerWatts", current: 1, rating: 1, proxyRating: 4 },
    { kind: "led", key: "ratedCurrentAmps", current: 0.01, rating: 0.01, proxyRating: 0.04 },
  ] as const)("uses the own $kind rating and notices edits behind a stable Proxy", ({ kind, key, current, rating, proxyRating }) => {
    const document = createCircuitFromSpecs([
      ["source", "current-source", ["positive", "negative"], { currentAmps: -current }],
      ["light", kind, ["positive", "negative"], { resistanceOhms: 1 }],
      ["ground", "ground", ["negative"]],
    ], "Own transient light ratings");
    const light = document.parts[1]!;
    Object.defineProperty(light, key, { value: rating, writable: true, configurable: true, enumerable: false });
    document.parts[1] = withNumericGetOverride(light, key, proxyRating);
    const analysis = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
    expect(analysis.status, analysis.message).toBe("valid");
    expect(analysis.samples[0]!.parts.light!.currentAmps).toBeCloseTo(current, 14);
    if (kind === "bulb") { expect(analysis.samples[0]!.parts.light!.powerWatts).toBe(1); }

    for (const sampled of [analysis, structuredClone(analysis), JSON.parse(JSON.stringify(analysis)) as typeof analysis]) {
      light[key] = rating;
      expect(analysisAtTransientFrame(document, { analysis: sampled, sampleIndex: 0 })?.parts.light?.brightness).toBeCloseTo(1, 12);
      light[key] = rating * 2;
      expect(analysisAtTransientFrame(document, { analysis: sampled, sampleIndex: 0 })?.parts.light?.brightness).toBeCloseTo(0.5, 12);
      Reflect.deleteProperty(light, key);
      const defaultRating = circuitPartCatalog[kind].defaults[key]!;
      // The bulb dissipates 1 W; the independent current source sets the LED's
      // 0.01 A current up to the nonlinear solver's convergence tolerance.
      expect(analysisAtTransientFrame(document, { analysis: sampled, sampleIndex: 0 })?.parts.light?.brightness)
        .toBeCloseTo((kind === "bulb" ? 1 : 0.01) / defaultRating, 12);
      Object.defineProperty(light, key, { value: rating, writable: true, configurable: true, enumerable: false });
    }
  });

  it.each([
    { kind: "battery", key: "voltageVolts" },
    { kind: "ac-source", key: "voltageVolts" },
    { kind: "ac-source", key: "offsetVolts" },
    { kind: "current-source", key: "currentAmps" },
  ] satisfies { kind: CircuitPartKind; key: CircuitPartNumericKey }[])("keeps an excited $kind loop closed using its own $key", ({ kind, key }) => {
    const document = createCircuitFromSpecs([
      ["source", kind, ["positive", "negative"], { ...(key === "offsetVolts" ? { voltageVolts: 0 } : {}) }],
      ["load", "resistor", ["positive", "negative"], { resistanceOhms: 1 }],
      ["ground", "ground", ["negative"]],
    ], "Own transient source excitation");
    const source = document.parts[0]!;
    if (key === "offsetVolts") { source.offsetVolts = 1; }
    else { Reflect.deleteProperty(source, key); }
    document.parts[0] = withNumericGetOverride(source, key, 0);
    const analysis = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });

    expect(analysis.status, analysis.message).toBe("valid");
    expect(Math.abs(analysis.samples[0]!.parts.load!.currentAmps)).toBeGreaterThan(0);
    expect(analysisAtTransientFrame(document, { analysis, sampleIndex: 0 })?.status).toBe("closed");
  });

  it("uses the own default switch state when transported readings omit switchClosed", () => {
    const document = createCircuitFromSpecs([
      ["source", "battery", ["positive", "negative"], { voltageVolts: 1 }],
      ["switch", "switch", ["positive", "load"]],
      ["load", "resistor", ["load", "negative"], { resistanceOhms: 1 }],
      ["floating", "switch", ["first", "second"]],
      ["meter", "voltmeter", ["first", "second"]],
      ["ground", "ground", ["negative"]],
    ], "Own switch fallback");
    for (const index of [1, 3]) {
      const part = document.parts[index]!;
      Reflect.deleteProperty(part, "initiallyClosed");
      document.parts[index] = new Proxy(part, {
        get(target, key, receiver) {
          return key === "initiallyClosed" ? false : Reflect.get(target, key, receiver);
        },
      });
    }
    const analysis = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1 });
    expect(analysis.status, analysis.message).toBe("valid");
    for (const sample of analysis.samples) {
      for (const id of ["switch", "floating"]) { Reflect.deleteProperty(sample.parts[id]!, "switchClosed"); }
    }

    const frame = analysisAtTransientFrame(document, { analysis, sampleIndex: 0 })!;
    expect(frame.status).toBe("closed");
    const nodes = circuitNodes(document, frame);
    const first = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "floating" && endpoint.terminal === "a"))!;
    const second = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "floating" && endpoint.terminal === "b"))!;
    expect(first.referenceGroup).toBe(second.referenceGroup);
    expect(circuitPotential(first, second, false)?.volts).toBe(0);
  });
});

describe("potential own numeric values", () => {
  it.each([
    { key: "wiperPosition", proxyValue: 0.25 },
    { key: "resistanceOhms", proxyValue: 2 },
  ] as const)("uses the own potentiometer $key and invalidates a reused path after edits", ({ key, proxyValue }) => {
    const document = createCircuitFromSpecs([
      ["source", "battery", ["positive", "negative"], { voltageVolts: 1 }],
      ["pot", "potentiometer", ["positive", "negative", "wiper"], { resistanceOhms: 4, wiperPosition: 0.5 }],
      ["probe", "resistor", ["wiper", "open"], { resistanceOhms: 1 }],
      ["ground", "ground", ["negative"]],
    ], "Own potentiometer potential");
    const pot = document.parts[1]!;
    document.parts[1] = withNumericGetOverride(pot, key, proxyValue);
    const analysis = analyzeCircuit(document);
    expect(analysis.status, analysis.message).toBe("closed");
    // Local differences are optional. The fallback must reconstruct each
    // segment from its current and the current own resistance/position.
    Reflect.deleteProperty(analysis.parts.pot!, "terminalVoltageDifferences");
    const nodes = circuitNodes(document, analysis);
    const first = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "pot" && endpoint.terminal === "a"))!;
    const second = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "probe" && endpoint.terminal === "b"))!;
    const context = { document, analysis, nodes };
    expect(analysis.parts.pot!.terminalCurrents!.a).toBe(0.25);
    expect(circuitPotential(first, second, false, context)?.volts).toBe(0.5);

    // Reuse the same current snapshot and path context while editing the
    // segment parameter: I=1/4 A and R_ac=3 ohms give 3/4 V.
    if (key === "wiperPosition") { pot.wiperPosition = 0.75; }
    else { pot.resistanceOhms = 6; }
    expect(circuitPotential(first, second, false, context)?.volts).toBe(0.75);
  });

  it.each([
    { kind: "capacitor", key: "capacitanceFarads" },
    { kind: "inductor", key: "inductanceHenries" },
  ] as const)("keeps an AC $kind reference connected through its own coefficient", ({ kind, key }) => {
    const document = createCircuitFromSpecs([
      ["source", "ac-source", ["positive", "negative"], { voltageVolts: 1, frequencyHz: 1 }],
      ["reactive", kind, ["first", "second"], { [key]: 1 }],
      ["meter", "voltmeter", ["first", "second"]],
      ["ground", "ground", ["negative"]],
    ], "Own AC reactive reference");
    document.parts[1] = withNumericGetOverride(document.parts[1]!, key, kind === "capacitor" ? 0 : Number.POSITIVE_INFINITY);
    const analysis = analyzeCircuit(document);
    expect(analysis.status, analysis.message).toBe("open");
    expect(analysis.parts.meter!.meterStatus).toBe("connected");
    const nodes = circuitNodes(document, analysis);
    const first = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "reactive" && endpoint.terminal === "a"))!;
    const second = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "reactive" && endpoint.terminal === "b"))!;
    expect(first.referenceGroup).toBe(second.referenceGroup);
    expect(circuitPotential(first, second, true, { document, analysis, nodes })?.volts).toBe(0);
  });

  it.each([undefined, 1])("uses the own source frequency or default (%s) when AC readings omit frequencyHz", (frequencyHz) => {
    const document = createCircuitFromSpecs([
      ["source", "ac-source", ["positive", "negative"], { voltageVolts: 1 }],
      ["reactive", "capacitor", ["first", "second"], { capacitanceFarads: 1 }],
      ["meter", "voltmeter", ["first", "second"]],
      ["ground", "ground", ["negative"]],
    ], "Own AC fallback frequency");
    const source = document.parts[0]!;
    if (frequencyHz === undefined) { Reflect.deleteProperty(source, "frequencyHz"); }
    else { source.frequencyHz = frequencyHz; }
    document.parts[0] = withNumericGetOverride(source, "frequencyHz", 0);
    const analysis = analyzeCircuit(document);
    expect(analysis.status, analysis.message).toBe("open");
    expect(analysis.frequencyHz).toBe(frequencyHz ?? 1000);
    Reflect.deleteProperty(analysis, "frequencyHz");

    const nodes = circuitNodes(document, analysis);
    const first = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "reactive" && endpoint.terminal === "a"))!;
    const second = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "reactive" && endpoint.terminal === "b"))!;
    expect(first.referenceGroup).toBe(second.referenceGroup);
  });
});
