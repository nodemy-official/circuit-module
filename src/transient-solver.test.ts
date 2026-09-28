import { describe, expect, it } from "vitest";

import type { CircuitDocument, CircuitPart, CircuitPartKind, CircuitWire } from "./circuit-model.js";
import { analyzeCircuit } from "./circuit-solver.js";
import {
  MAX_TRANSIENT_STEPS,
  simulateTransient,
} from "./transient-solver.js";

function part(
  id: string,
  kind: CircuitPartKind,
  properties: Partial<CircuitPart> = {},
): CircuitPart {
  return { id, kind, x: 0, y: 0, label: id, ...properties };
}

function wire(id: string, fromPart: string, fromTerminal: "a" | "b", toPart: string, toTerminal: "a" | "b") {
  return {
    id,
    from: { partId: fromPart, terminal: fromTerminal },
    to: { partId: toPart, terminal: toTerminal },
  } satisfies CircuitWire;
}

function rcCircuit(initialVoltageVolts = 0): CircuitDocument {
  return {
    title: "RC charging",
    parts: [
      part("source", "battery", { voltageVolts: 1, internalResistanceOhms: 0 }),
      part("resistor", "resistor", { resistanceOhms: 1000 }),
      part("capacitor", "capacitor", { capacitanceFarads: 1e-3, initialVoltageVolts }),
      part("ground", "ground"),
    ],
    wires: [
      wire("wire-source-r", "source", "a", "resistor", "a"),
      wire("wire-r-c", "resistor", "b", "capacitor", "a"),
      wire("wire-c-ground", "capacitor", "b", "ground", "a"),
      wire("wire-source-ground", "source", "b", "ground", "a"),
    ],
  };
}

function parallelCapacitorsCircuit(linkKind: "switch" | "ammeter"): CircuitDocument {
  const link = linkKind === "switch"
    ? part("link", "switch", { initiallyClosed: true })
    : part("link", "ammeter");
  return {
    title: "Parallel capacitors through an ideal link",
    parts: [
      part("source", "battery", { voltageVolts: 1 }),
      part("resistor", "resistor", { resistanceOhms: 1000 }),
      part("capacitor-1", "capacitor", { capacitanceFarads: 1e-3, initialVoltageVolts: 0 }),
      link,
      part("capacitor-2", "capacitor", { capacitanceFarads: 1e-3, initialVoltageVolts: 0 }),
      part("ground", "ground"),
    ],
    wires: [
      wire("wire-source-r", "source", "a", "resistor", "a"),
      wire("wire-r-c1", "resistor", "b", "capacitor-1", "a"),
      wire("wire-c1-link", "capacitor-1", "a", "link", "a"),
      wire("wire-link-c2", "link", "b", "capacitor-2", "a"),
      wire("wire-c1-ground", "capacitor-1", "b", "ground", "a"),
      wire("wire-c2-ground", "capacitor-2", "b", "ground", "a"),
      wire("wire-source-ground", "source", "b", "ground", "a"),
    ],
  };
}

describe("simulateTransient", () => {
  it("charges an RC circuit with backward Euler and includes both endpoints", () => {
    const document = rcCircuit();
    const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(101);
    expect(result.samples[0]?.timeSeconds).toBe(0);
    expect(result.samples.at(-1)?.timeSeconds).toBe(1);
    expect(result.samples[1]?.parts.capacitor?.currentAmps).toBeCloseTo(0.000_990_1, 6);
    expect(result.samples.at(-1)?.parts.capacitor?.voltageVolts).toBeCloseTo(0.6303, 3);
  });

  it("accepts equal initial voltages on parallel capacitors without duplicate ideal sources", () => {
    const document = rcCircuit();
    document.parts.push(part("capacitor-2", "capacitor", { capacitanceFarads: 1e-3, initialVoltageVolts: 0 }));
    document.wires.push(
      wire("wire-parallel-a", "capacitor", "a", "capacitor-2", "a"),
      wire("wire-parallel-b", "capacitor", "b", "capacitor-2", "b"),
    );
    const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.capacitor?.voltageVolts).toBe(0);
    expect(result.samples[0]?.parts["capacitor-2"]?.voltageVolts).toBe(0);
    expect(result.samples[0]?.parts.capacitor?.currentAmps).toBeCloseTo(
      result.samples[0]?.parts["capacitor-2"]?.currentAmps ?? Number.NaN,
      8,
    );
    expect(result.samples.at(-1)?.parts.capacitor?.voltageVolts).toBeCloseTo(0.3927, 4);
    expect(result.samples.at(-1)?.parts["capacitor-2"]?.voltageVolts).toBeCloseTo(0.3927, 4);
  });

  it("matches reversed parallel capacitor polarities and shares their initial branch current", () => {
    const document = rcCircuit(2);
    document.parts.push(part("capacitor-2", "capacitor", {
      capacitanceFarads: 3e-3,
      initialVoltageVolts: -2,
    }));
    document.wires.push(
      wire("wire-reversed-a", "capacitor", "a", "capacitor-2", "b"),
      wire("wire-reversed-b", "capacitor", "b", "capacitor-2", "a"),
    );
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.capacitor?.voltageVolts).toBe(2);
    expect(result.samples[0]?.parts["capacitor-2"]?.voltageVolts).toBe(-2);
    expect(result.samples[0]?.parts.capacitor?.currentAmps).toBeCloseTo(-0.000_25, 8);
    expect(result.samples[0]?.parts["capacitor-2"]?.currentAmps).toBeCloseTo(0.000_75, 8);
  });

  it("accepts a zero-initial-voltage capacitor whose terminals are shorted", () => {
    const document: CircuitDocument = {
      title: "Shorted capacitor",
      parts: [part("capacitor", "capacitor", { capacitanceFarads: 1e-6 })],
      wires: [wire("wire-short", "capacitor", "a", "capacitor", "b")],
    };
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.capacitor).toMatchObject({ voltageVolts: 0, currentAmps: 0, powerWatts: 0, terminalVoltages: { a: 0, b: 0 }, terminalCurrents: { a: 0, b: 0 } });
  });

  it("satisfies capacitor initial voltage exactly at t=0", () => {
    const document = rcCircuit(2);
    const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.01 });

    expect(result.status).toBe("valid");
    expect(result.samples[0]?.parts.capacitor?.voltageVolts).toBe(2);
    expect(result.samples[0]?.parts.capacitor?.currentAmps).toBeCloseTo(-0.001, 8);
  });

  it("splits parallel capacitor initial current by capacitance and satisfies node KCL", () => {
    const document = rcCircuit(2);
    document.parts.push(part("capacitor-2", "capacitor", {
      capacitanceFarads: 3e-3,
      initialVoltageVolts: 2,
    }));
    document.wires.push(
      wire("wire-parallel-a", "capacitor", "a", "capacitor-2", "a"),
      wire("wire-parallel-b", "capacitor", "b", "capacitor-2", "b"),
    );
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });
    const initial = result.samples[0]?.parts;
    const firstCurrent = initial?.capacitor?.currentAmps ?? Number.NaN;
    const secondCurrent = initial?.["capacitor-2"]?.currentAmps ?? Number.NaN;

    expect(result.status, result.message).toBe("valid");
    expect(firstCurrent).toBeCloseTo(-0.000_25, 10);
    expect(secondCurrent).toBeCloseTo(3 * firstCurrent, 10);
    expect(
      (initial?.resistor?.terminalCurrents?.b ?? Number.NaN) +
        (initial?.capacitor?.terminalCurrents?.a ?? Number.NaN) +
        (initial?.["capacitor-2"]?.terminalCurrents?.a ?? Number.NaN),
    ).toBeCloseTo(0, 10);
  });

  it("keeps split initial capacitor currents finite when current and capacitance are large", () => {
    const document = parallelCapacitorsCircuit("switch");
    Object.assign(document.parts.find(({ id }) => id === "source"), { voltageVolts: 1e150 });
    Object.assign(document.parts.find(({ id }) => id === "resistor"), { resistanceOhms: 1 });
    Object.assign(document.parts.find(({ id }) => id === "capacitor-1"), { capacitanceFarads: 1e200 });
    Object.assign(document.parts.find(({ id }) => id === "capacitor-2"), { capacitanceFarads: 1e200 });

    const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.1 });
    const firstCurrent = result.samples[0]?.parts["capacitor-1"]?.currentAmps ?? Number.NaN;
    const secondCurrent = result.samples[0]?.parts["capacitor-2"]?.currentAmps ?? Number.NaN;

    expect(result.status, result.message).toBe("valid");
    expect(Number.isFinite(firstCurrent)).toBe(true);
    expect(Number.isFinite(secondCurrent)).toBe(true);
    expect(firstCurrent / 1e150).toBeCloseTo(0.5, 12);
    expect(secondCurrent / 1e150).toBeCloseTo(0.5, 12);
  });

  it("satisfies inductor initial current exactly at t=0", () => {
    const document: CircuitDocument = {
      title: "Inductor initial current",
      parts: [
        part("inductor", "inductor", { inductanceHenries: 1, initialCurrentAmps: 0.25 }),
        part("resistor", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("wire-a", "inductor", "a", "resistor", "a"),
        wire("wire-b", "inductor", "b", "resistor", "b"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.001 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.inductor?.currentAmps).toBe(0.25);
  });

  it("simulates an RL step and carries inductor branch current between steps", () => {
    const document: CircuitDocument = {
      title: "RL step",
      parts: [
        part("source", "battery", { voltageVolts: 1, internalResistanceOhms: 0 }),
        part("resistor", "resistor", { resistanceOhms: 100 }),
        part("inductor", "inductor", { inductanceHenries: 1, initialCurrentAmps: 0 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-r", "source", "a", "resistor", "a"),
        wire("wire-r-l", "resistor", "b", "inductor", "a"),
        wire("wire-l-ground", "inductor", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.001 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[1]?.parts.inductor?.currentAmps).toBeCloseTo(1 / 1100, 7);
    expect(result.samples.at(-1)?.parts.inductor?.currentAmps).toBeCloseTo(0.01, 5);
  });

  it("follows backward-Euler KVL and KCL in a series RLC circuit", () => {
    const resistance = 10;
    const inductance = 0.2;
    const capacitance = 0.01;
    const sourceVoltage = 3;
    const timeStep = 0.01;
    const steps = 8;
    const document: CircuitDocument = {
      title: "Series RLC",
      parts: [
        part("source", "battery", { voltageVolts: sourceVoltage }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
        part("inductor", "inductor", { inductanceHenries: inductance, initialCurrentAmps: 0 }),
        part("capacitor", "capacitor", { capacitanceFarads: capacitance, initialVoltageVolts: 0 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-r", "source", "a", "resistor", "a"),
        wire("wire-r-l", "resistor", "b", "inductor", "a"),
        wire("wire-l-c", "inductor", "b", "capacitor", "a"),
        wire("wire-c-ground", "capacitor", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, {
      durationSeconds: steps * timeStep,
      timeStepSeconds: timeStep,
    });

    expect(result.status, result.message).toBe("valid");
    let previousCurrent = 0;
    let capacitorVoltage = 0;
    for (let index = 1; index <= steps; index += 1) {
      const inductiveResistance = inductance / timeStep;
      const capacitiveResistance = timeStep / capacitance;
      const expectedCurrent = (sourceVoltage - capacitorVoltage + inductiveResistance * previousCurrent) /
        (resistance + inductiveResistance + capacitiveResistance);
      capacitorVoltage += expectedCurrent * capacitiveResistance;
      const sample = result.samples[index];

      expect(sample?.parts.resistor?.currentAmps).toBeCloseTo(expectedCurrent, 10);
      expect(sample?.parts.inductor?.currentAmps).toBeCloseTo(expectedCurrent, 10);
      expect(sample?.parts.capacitor?.currentAmps).toBeCloseTo(expectedCurrent, 10);
      expect(sample?.parts.resistor?.voltageVolts).toBeCloseTo(resistance * expectedCurrent, 10);
      expect(sample?.parts.capacitor?.voltageVolts).toBeCloseTo(capacitorVoltage, 10);
      expect(sample?.parts.inductor?.voltageVolts).toBeCloseTo(
        inductance / timeStep * (expectedCurrent - previousCurrent),
        10,
      );
      expect(
        sourceVoltage - (sample?.parts.resistor?.voltageVolts ?? 0) -
          (sample?.parts.inductor?.voltageVolts ?? 0) - (sample?.parts.capacitor?.voltageVolts ?? 0),
      ).toBeCloseTo(0, 10);
      previousCurrent = expectedCurrent;
    }
  });

  it("uses the actual shorter final time step for the capacitor state update", () => {
    const result = simulateTransient(rcCircuit(), { durationSeconds: 0.025, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    const first = 1 / 101;
    const second = (first + 0.01) / 1.01;
    const final = (second + 0.005) / 1.005;
    expect(result.samples.at(-1)?.parts.capacitor?.voltageVolts).toBeCloseTo(final, 12);
    expect(result.samples.at(-1)?.parts.capacitor?.currentAmps).toBeCloseTo(
      0.001 / 0.005 * (final - second),
      12,
    );
  });

  it("uses the actual shorter final time step for the inductor state update", () => {
    const resistance = 8;
    const inductance = 2;
    const initialCurrent = 0.5;
    const document: CircuitDocument = {
      title: "RL final short step",
      parts: [
        part("inductor", "inductor", { inductanceHenries: inductance, initialCurrentAmps: initialCurrent }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
      ],
      wires: [
        wire("wire-a", "inductor", "a", "resistor", "a"),
        wire("wire-b", "inductor", "b", "resistor", "b"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.1 });
    const first = initialCurrent / (1 + resistance * 0.1 / inductance);
    const second = first / (1 + resistance * 0.1 / inductance);
    const final = second / (1 + resistance * 0.05 / inductance);

    expect(result.status, result.message).toBe("valid");
    expect(result.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, 0.1, 0.2, 0.25]);
    expect(result.samples.at(-1)?.parts.inductor?.currentAmps).toBeCloseTo(final, 12);
  });

  it("lets a switch stop and resume RC charging according to the supplied state", () => {
    const document: CircuitDocument = {
      title: "Switched RC",
      parts: [
        part("source", "battery", { voltageVolts: 1 }),
        part("switch", "switch"),
        part("resistor", "resistor", { resistanceOhms: 100 }),
        part("capacitor", "capacitor", { capacitanceFarads: 0.01, initialVoltageVolts: 0 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-switch", "source", "a", "switch", "a"),
        wire("wire-switch-r", "switch", "b", "resistor", "a"),
        wire("wire-r-c", "resistor", "b", "capacitor", "a"),
        wire("wire-c-ground", "capacitor", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const closed = simulateTransient(document, {
      durationSeconds: 0.1,
      timeStepSeconds: 0.1,
      switchStates: { switch: true },
    });
    const open = simulateTransient(document, {
      durationSeconds: 0.1,
      timeStepSeconds: 0.1,
      switchStates: { switch: false },
    });

    expect(closed.status, closed.message).toBe("valid");
    expect(closed.samples[0]?.parts.switch?.switchClosed).toBe(true);
    expect(closed.samples[1]?.parts.capacitor?.voltageVolts).toBeCloseTo(1 / 11, 10);
    expect(open.status, open.message).toBe("valid");
    expect(open.samples[0]?.parts.switch?.switchClosed).toBe(false);
    expect(open.samples[1]?.parts.switch?.switchClosed).toBe(false);
    expect(open.samples[1]?.parts.capacitor?.voltageVolts).toBeCloseTo(0, 12);
    expect(open.samples[1]?.parts.resistor?.currentAmps).toBeCloseTo(0, 12);
  });

  it("rejects malformed switch states instead of treating truthy values as closed", () => {
    const result = simulateTransient(parallelCapacitorsCircuit("switch"), {
      durationSeconds: 0.01,
      timeStepSeconds: 0.01,
      switchStates: { link: "false" } as unknown as Record<string, boolean>,
    });

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("スイッチ状態");
    expect(result.samples).toHaveLength(0);
  });

  it("rejects a non-object switch state map", () => {
    const result = simulateTransient(parallelCapacitorsCircuit("switch"), {
      durationSeconds: 0.01,
      timeStepSeconds: 0.01,
      switchStates: null as unknown as Record<string, boolean>,
    });

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("スイッチ状態");
    expect(result.samples).toHaveLength(0);
  });

  it("rejects a Map used as the switch state map", () => {
    const result = simulateTransient(parallelCapacitorsCircuit("switch"), {
      durationSeconds: 0.01,
      timeStepSeconds: 0.01,
      switchStates: new Map([["link", false]]) as unknown as Record<string, boolean>,
    });

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("スイッチ状態");
    expect(result.samples).toHaveLength(0);
  });

  it.each([
    ["missing", "スイッチ部品ではありません"],
    ["source", "スイッチ部品ではありません"],
  ])("rejects switch overrides for %s", (partId, expectedMessage) => {
    const result = simulateTransient(parallelCapacitorsCircuit("switch"), {
      durationSeconds: 0.01,
      timeStepSeconds: 0.01,
      switchStates: { [partId]: true },
    });

    expect(result.status).toBe("invalid");
    expect(result.message).toContain(expectedMessage);
    expect(result.samples).toHaveLength(0);
  });

  it("shares the initial current of equal-voltage capacitors connected by a closed switch", () => {
    const document = parallelCapacitorsCircuit("switch");
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });
    const initial = result.samples[0]?.parts;
    const currentAt = (partId: string, terminal: "a" | "b") =>
      initial?.[partId]?.terminalCurrents?.[terminal] ?? Number.NaN;

    expect(result.status, result.message).toBe("valid");
    expect(initial?.["capacitor-1"]?.currentAmps).toBeCloseTo(0.0005, 9);
    expect(initial?.["capacitor-2"]?.currentAmps).toBeCloseTo(0.0005, 9);
    expect(initial?.link?.currentAmps).toBeCloseTo(0.0005, 9);
    expect(currentAt("resistor", "b") + currentAt("capacitor-1", "a") + currentAt("link", "a"))
      .toBeCloseTo(0, 10);
    expect(currentAt("link", "b") + currentAt("capacitor-2", "a")).toBeCloseTo(0, 10);
  });

  it("shares initial capacitor current through a connected ammeter and preserves terminal KCL", () => {
    const result = simulateTransient(parallelCapacitorsCircuit("ammeter"), {
      durationSeconds: 0.01,
      timeStepSeconds: 0.01,
    });
    const initial = result.samples[0]?.parts;
    const currentAt = (partId: string, terminal: "a" | "b") =>
      initial?.[partId]?.terminalCurrents?.[terminal] ?? Number.NaN;

    expect(result.status, result.message).toBe("valid");
    expect(initial?.link?.meterStatus).toBe("connected");
    expect(initial?.["capacitor-1"]?.currentAmps).toBeCloseTo(0.0005, 9);
    expect(initial?.["capacitor-2"]?.currentAmps).toBeCloseTo(0.0005, 9);
    expect(initial?.link?.currentAmps).toBeCloseTo(0.0005, 9);
    expect(currentAt("resistor", "b") + currentAt("capacitor-1", "a") + currentAt("link", "a"))
      .toBeCloseTo(0, 10);
    expect(currentAt("link", "b") + currentAt("capacitor-2", "a")).toBeCloseTo(0, 10);
  });

  it("respects an open switch override when grouping initial capacitor constraints", () => {
    const document = parallelCapacitorsCircuit("switch");
    const result = simulateTransient(document, {
      durationSeconds: 0.01,
      timeStepSeconds: 0.01,
      switchStates: { link: false },
    });
    const initial = result.samples[0]?.parts;

    expect(result.status, result.message).toBe("valid");
    expect(initial?.["capacitor-1"]?.currentAmps).toBeCloseTo(0.001, 9);
    expect(initial?.["capacitor-2"]?.currentAmps).toBeCloseTo(0, 12);
    expect(initial?.link?.currentAmps).toBeCloseTo(0, 12);
    expect(initial?.link?.voltageVolts).toBeCloseTo(0, 12);
  });

  it("keeps a wire-bypassed ammeter marked floating at the initial sample", () => {
    const document: CircuitDocument = {
      title: "Wire-bypassed ammeter during transient analysis",
      parts: [
        part("source", "battery", { voltageVolts: 1 }),
        part("resistor", "resistor", { resistanceOhms: 1000 }),
        part("capacitor", "capacitor", { capacitanceFarads: 1e-3, initialVoltageVolts: 0 }),
        part("ammeter", "ammeter"),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-r", "source", "a", "resistor", "a"),
        wire("wire-r-c", "resistor", "b", "capacitor", "a"),
        wire("wire-c-ground", "capacitor", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
        wire("wire-meter-a", "ammeter", "a", "resistor", "b"),
        wire("wire-meter-b", "ammeter", "b", "resistor", "b"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.ammeter?.meterStatus).toBe("floating");
  });

  it("reports a parallel ammeter as connected when the inductor initial current determines its branch current", () => {
    const document: CircuitDocument = {
      title: "Inductor initial current through a parallel ammeter",
      parts: [
        part("inductor", "inductor", { inductanceHenries: 1, initialCurrentAmps: 2 }),
        part("ammeter", "ammeter"),
      ],
      wires: [
        wire("wire-meter-a", "inductor", "a", "ammeter", "a"),
        wire("wire-meter-b", "inductor", "b", "ammeter", "b"),
      ],
    };
    const dc = analyzeCircuit(document);
    const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.1 });
    const operatingPointStart = simulateTransient(document, {
      durationSeconds: 0.1,
      timeStepSeconds: 0.1,
      startFromOperatingPoint: true,
    });

    expect(dc.parts.ammeter.meterStatus).toBe("floating");
    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.ammeter?.meterStatus).toBe("connected");
    expect(result.samples[0]?.parts.ammeter?.currentAmps).toBe(-2);
    expect(result.samples[1]?.parts.ammeter?.meterStatus).toBe("connected");
    expect(result.samples[1]?.parts.ammeter?.currentAmps).toBe(-2);
    expect(operatingPointStart.status, operatingPointStart.message).toBe("valid");
    expect(operatingPointStart.samples[0]?.parts.ammeter?.meterStatus).toBe("floating");
  });

  it("preserves a defined inductor voltage probe at the initial sample", () => {
    const document: CircuitDocument = {
      title: "Initial inductor voltage follows the current derivative constraint",
      parts: [
        part("source", "current-source", { currentAmps: 2 }),
        part("inductor", "inductor", { inductanceHenries: 1, initialCurrentAmps: 2 }),
        part("voltmeter", "voltmeter"),
      ],
      wires: [
        wire("wire-source-inductor", "source", "b", "inductor", "a"),
        wire("wire-inductor-source", "inductor", "b", "source", "a"),
        wire("wire-meter-a", "voltmeter", "a", "inductor", "a"),
        wire("wire-meter-b", "voltmeter", "b", "inductor", "b"),
      ],
    };
    const dc = analyzeCircuit(document);
    const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.1 });

    expect(dc.parts.voltmeter.meterStatus).toBe("connected");
    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.voltmeter?.meterStatus).toBe("connected");
    expect(result.samples[0]?.parts.voltmeter?.voltageVolts).toBe(0);
    expect(result.samples[1]?.parts.voltmeter?.meterStatus).toBe("connected");
    expect(result.samples[1]?.parts.voltmeter?.voltageVolts).toBe(0);
  });

  it("keeps a voltmeter across a capacitor connected at the initialized transient sample", () => {
    const document: CircuitDocument = {
      title: "Initial capacitor voltage probe",
      parts: [
        part("capacitor", "capacitor", { capacitanceFarads: 1e-3, initialVoltageVolts: 2 }),
        part("voltmeter", "voltmeter"),
      ],
      wires: [
        wire("wire-meter-a", "voltmeter", "a", "capacitor", "a"),
        wire("wire-meter-b", "voltmeter", "b", "capacitor", "b"),
      ],
    };
    const dc = analyzeCircuit(document);
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });

    expect(dc.parts.voltmeter.meterStatus).toBe("floating");
    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.voltmeter?.meterStatus).toBe("connected");
    expect(result.samples[0]?.parts.voltmeter?.voltageVolts).toBe(2);
  });

  it("preserves op-amp load current through a closed switch in the initial sample", () => {
    const document: CircuitDocument = {
      title: "Op-amp load through a switch",
      parts: [
        part("input", "battery", { voltageVolts: 5 }),
        part("opamp", "op-amp"),
        part("resistor", "resistor", { resistanceOhms: 1000 }),
        part("switch", "switch", { initiallyClosed: true }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-input-positive", "input", "a", "opamp", "a"),
        wire("wire-input-ground", "input", "b", "ground", "a"),
        wire("wire-opamp-load", "opamp", "c", "resistor", "a"),
        wire("wire-load-switch", "resistor", "b", "switch", "a"),
        wire("wire-switch-ground", "switch", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.switch?.currentAmps).toBeCloseTo(15 / 1020, 8);
  });

  it.each(["constructor", "toString", "__proto__"])(
    "does not treat inherited switch state properties as a closed switch for id %s",
    (switchId) => {
      const document: CircuitDocument = {
        title: "Switch with prototype-like id",
        parts: [
          part("source", "battery", { voltageVolts: 1 }),
          part(switchId, "switch", { initiallyClosed: false }),
          part("resistor", "resistor", { resistanceOhms: 100 }),
          part("capacitor", "capacitor", { capacitanceFarads: 0.01, initialVoltageVolts: 0 }),
          part("ground", "ground"),
        ],
        wires: [
          wire("wire-source-switch", "source", "a", switchId, "a"),
          wire("wire-switch-r", switchId, "b", "resistor", "a"),
          wire("wire-r-c", "resistor", "b", "capacitor", "a"),
          wire("wire-c-ground", "capacitor", "b", "ground", "a"),
          wire("wire-source-ground", "source", "b", "ground", "a"),
        ],
      };
      const result = simulateTransient(document, {
        durationSeconds: 0.1,
        timeStepSeconds: 0.1,
        switchStates: {},
      });

      expect(result.status, result.message).toBe("valid");
      expect(result.samples[1]?.parts.capacitor?.voltageVolts).toBeCloseTo(0, 12);
      expect(result.samples[1]?.parts.resistor?.currentAmps).toBeCloseTo(0, 12);
    },
  );

  it("keeps generated history-source ids unique when an existing wire uses the generated id", () => {
    const document = rcCircuit();
    document.wires[0] = { ...document.wires[0]!, id: "__transient_capacitor_history" };
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[1]?.parts.capacitor?.voltageVolts).toBeCloseTo(1 / 101, 10);
  });

  it("retains inductor history when its id is a prototype property name", () => {
    const prototypeId = "__proto__";
    const document: CircuitDocument = {
      title: "Prototype-like inductor id",
      parts: [
        part("source", "battery", { voltageVolts: 3 }),
        part("resistor", "resistor", { resistanceOhms: 5 }),
        part(prototypeId, "inductor", { inductanceHenries: 0.2, initialCurrentAmps: 0.2 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-r", "source", "a", "resistor", "a"),
        wire("wire-r-l", "resistor", "b", prototypeId, "a"),
        wire("wire-l-ground", prototypeId, "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.1 });
    const expectedCurrent = (3 + 0.2 / 0.1 * 0.2) / (5 + 0.2 / 0.1);

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[1]?.parts[prototypeId]?.currentAmps).toBeCloseTo(expectedCurrent, 10);
  });

  it("decays an initial inductor current by the backward-Euler RL factor", () => {
    const resistance = 8;
    const inductance = 2;
    const timeStep = 0.1;
    const initialCurrent = 0.5;
    const document: CircuitDocument = {
      title: "RL natural response",
      parts: [
        part("inductor", "inductor", { inductanceHenries: inductance, initialCurrentAmps: initialCurrent }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
      ],
      wires: [
        wire("wire-a", "inductor", "a", "resistor", "a"),
        wire("wire-b", "inductor", "b", "resistor", "b"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.4, timeStepSeconds: timeStep });

    expect(result.status, result.message).toBe("valid");
    let expectedCurrent = initialCurrent;
    for (let index = 1; index <= 4; index += 1) {
      expectedCurrent /= 1 + resistance * timeStep / inductance;
      expect(result.samples[index]?.parts.inductor?.currentAmps).toBeCloseTo(expectedCurrent, 11);
      expect(result.samples[index]?.parts.resistor?.currentAmps).toBeCloseTo(-expectedCurrent, 11);
      expect(result.samples[index]?.parts.inductor?.voltageVolts).toBeCloseTo(
        inductance / timeStep * (expectedCurrent - (result.samples[index - 1]?.parts.inductor?.currentAmps ?? 0)),
        10,
      );
    }
  });

  it("starts from the DC operating point when requested", () => {
    const result = simulateTransient(rcCircuit(), {
      durationSeconds: 0.1,
      timeStepSeconds: 0.01,
      startFromOperatingPoint: true,
    });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.capacitor?.voltageVolts).toBeCloseTo(1, 8);
    expect(result.samples.at(-1)?.parts.capacitor?.voltageVolts).toBeCloseTo(1, 8);
    expect(result.samples.at(-1)?.parts.capacitor?.currentAmps).toBeCloseTo(0, 9);
  });

  it("includes an exact final sample when the duration is not divisible by the step", () => {
    const result = simulateTransient(rcCircuit(), { durationSeconds: 0.025, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, 0.01, 0.02, 0.025]);
  });

  it("keeps one final sample when the positive duration is smaller than the requested step", () => {
    const durationSeconds = Number.MIN_VALUE;
    const document: CircuitDocument = {
      title: "Duration shorter than one step",
      parts: [
        part("source", "battery", { voltageVolts: 1 }),
        part("load", "resistor", { resistanceOhms: 1 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-load", "source", "a", "load", "a"),
        wire("wire-load-ground", "load", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, {
      durationSeconds,
      timeStepSeconds: Number.MAX_VALUE,
    });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([0, durationSeconds]);
  });

  it("uses the AC source RMS setting as a peak-valued time waveform", () => {
    const document: CircuitDocument = {
      title: "AC input",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, frequencyHz: 50, phaseDegrees: 0, offsetVolts: 0 }),
        part("load", "resistor", { resistanceOhms: 100 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-load", "source", "a", "load", "a"),
        wire("wire-load-ground", "load", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.02, timeStepSeconds: 0.0001 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.source?.voltageVolts).toBeCloseTo(Math.SQRT2 * 5, 8);
    expect(result.samples[50]?.parts.source?.voltageVolts).toBeCloseTo(0, 8);
    expect(result.samples[100]?.parts.source?.voltageVolts).toBeCloseTo(-Math.SQRT2 * 5, 8);
  });

  it("uses a finite waveform for an AC source with a very large phase angle", () => {
    const phaseDegrees = 1e308;
    const document: CircuitDocument = {
      title: "Large finite AC phase",
      parts: [
        part("source", "ac-source", { voltageVolts: 2, frequencyHz: 50, phaseDegrees }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("wire-source-load", "source", "a", "load", "a"),
        wire("wire-load-source", "load", "b", "source", "b"),
      ],
    };

    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.01 });

    expect(result.status, result.message).toBe("valid");
    const expected = Math.SQRT2 * 2 * Math.cos((phaseDegrees % 360) * Math.PI / 180);
    expect(result.samples[0]?.parts.source?.voltageVolts).toBeCloseTo(expected, 8);
    expect(result.samples[0]?.parts.load?.voltageVolts).toBeCloseTo(expected, 8);
  });

  it("keeps the AC phase finite when the frequency-time product is representable", () => {
    const frequencyHz = 1e308;
    const durationSeconds = 1e-308;
    const document: CircuitDocument = {
      title: "Finite high-frequency AC sample",
      parts: [
        part("source", "ac-source", { voltageVolts: 2, frequencyHz }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("wire-source-load", "source", "a", "load", "a"),
        wire("wire-load-source", "load", "b", "source", "b"),
      ],
    };
    const steady = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    const result = simulateTransient(document, {
      durationSeconds,
      timeStepSeconds: durationSeconds,
    });

    expect(steady.status, steady.message).toBe("closed");
    expect(steady.parts.load.voltageVolts).toBeCloseTo(2, 8);
    expect(result.status, result.message).toBe("valid");
    expect(result.samples.at(-1)?.parts.source?.voltageVolts).toBeCloseTo(Math.SQRT2 * 2, 8);
    expect(result.samples.at(-1)?.parts.load?.voltageVolts).toBeCloseTo(Math.SQRT2 * 2, 8);
  });

  it("applies AC phase and offset at every sample and reports the corresponding load power", () => {
    const rmsVoltage = 2;
    const frequency = 50;
    const phaseDegrees = 90;
    const offsetVolts = 1.25;
    const resistance = 20;
    const document: CircuitDocument = {
      title: "Offset AC input",
      parts: [
        part("source", "ac-source", {
          voltageVolts: rmsVoltage,
          frequencyHz: frequency,
          phaseDegrees,
          offsetVolts,
        }),
        part("load", "resistor", { resistanceOhms: resistance }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-load", "source", "a", "load", "a"),
        wire("wire-load-ground", "load", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.0025 });

    expect(result.status, result.message).toBe("valid");
    for (const sample of result.samples) {
      const angle = 2 * Math.PI * frequency * sample.timeSeconds + phaseDegrees * Math.PI / 180;
      const expectedVoltage = offsetVolts + Math.SQRT2 * rmsVoltage * Math.cos(angle);
      expect(sample.parts.source.voltageVolts).toBeCloseTo(expectedVoltage, 9);
      expect(sample.parts.load.currentAmps).toBeCloseTo(expectedVoltage / resistance, 9);
      expect(sample.parts.load.powerWatts).toBeCloseTo(expectedVoltage ** 2 / resistance, 9);
    }
  });

  it("rectifies the AC waveform with a nonlinear diode", () => {
    const document: CircuitDocument = {
      title: "Half-wave rectifier",
      parts: [
        part("source", "ac-source", { voltageVolts: 3, frequencyHz: 50 }),
        part("diode", "diode"),
        part("load", "resistor", { resistanceOhms: 1000 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-diode", "source", "a", "diode", "a"),
        wire("wire-diode-load", "diode", "b", "load", "a"),
        wire("wire-load-ground", "load", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.02, timeStepSeconds: 0.0001 });

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.load?.voltageVolts).toBeGreaterThan(3);
    expect(Math.abs(result.samples[100]?.parts.load?.voltageVolts ?? 1)).toBeLessThan(1e-5);
  });

  it("reports incompatible capacitor initial constraints instead of hiding them", () => {
    const document: CircuitDocument = {
      title: "Conflicting initial state",
      parts: [
        part("c1", "capacitor", { capacitanceFarads: 1e-6, initialVoltageVolts: 1 }),
        part("c2", "capacitor", { capacitanceFarads: 1e-6, initialVoltageVolts: 2 }),
      ],
      wires: [
        wire("wire-a", "c1", "a", "c2", "a"),
        wire("wire-b", "c1", "b", "c2", "b"),
      ],
    };
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.001 });

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("初期電圧");
  });

  it("rejects even a tiny initial-voltage mismatch between parallel capacitors", () => {
    const document = rcCircuit();
    document.parts.push(part("capacitor-2", "capacitor", {
      capacitanceFarads: 1e-6,
      initialVoltageVolts: 1e-9,
    }));
    document.wires.push(
      wire("wire-parallel-a", "capacitor", "a", "capacitor-2", "a"),
      wire("wire-parallel-b", "capacitor", "b", "capacitor-2", "b"),
    );
    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.001 });

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("初期電圧");
    expect(result.samples).toHaveLength(0);
  });

  it("returns invalid for malformed input documents instead of throwing", () => {
    const duplicateIds = rcCircuit();
    duplicateIds.parts[1] = { ...duplicateIds.parts[1]!, id: "source" };
    expect(simulateTransient(duplicateIds, { durationSeconds: 0.1, timeStepSeconds: 0.01 }).status).toBe("invalid");

    const unknownKind = rcCircuit();
    unknownKind.parts[0] = { ...unknownKind.parts[0]!, kind: "mystery" as CircuitPartKind };
    expect(simulateTransient(unknownKind, { durationSeconds: 0.1, timeStepSeconds: 0.01 }).status).toBe("invalid");

    const duplicateWireIds = rcCircuit();
    duplicateWireIds.wires[1] = { ...duplicateWireIds.wires[1]!, id: duplicateWireIds.wires[0]!.id };
    expect(simulateTransient(duplicateWireIds, { durationSeconds: 0.1, timeStepSeconds: 0.01 }).status)
      .toBe("invalid");
  });

  it.each([
    ["capacitor", { capacitanceFarads: 0 }],
    ["inductor", { inductanceHenries: 0 }],
  ] as const)("does not hide an invalid original %s value during equivalent conversion", (kind, value) => {
    const document = kind === "capacitor" ? rcCircuit() : {
      title: "Invalid inductor",
      parts: [
        part("source", "battery", { voltageVolts: 1 }),
        part("inductor", "inductor", { inductanceHenries: 1e-3 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("wire-source-l", "source", "a", "inductor", "a"),
        wire("wire-l-ground", "inductor", "b", "ground", "a"),
        wire("wire-source-ground", "source", "b", "ground", "a"),
      ],
    };
    const target = kind === "capacitor" ? document.parts.find(({ kind: itemKind }) => itemKind === "capacitor")
      : document.parts.find(({ kind: itemKind }) => itemKind === "inductor");
    if (!target) { throw new Error(`Missing ${kind}`); }
    Object.assign(target, value);

    const result = simulateTransient(document, { durationSeconds: 0.01, timeStepSeconds: 0.001 });
    expect(result.status).toBe("invalid");

    if (kind === "capacitor") {
      const explicitNull = rcCircuit();
      const capacitor = explicitNull.parts.find(({ kind: itemKind }) => itemKind === "capacitor");
      if (!capacitor) { throw new Error("Missing capacitor"); }
      Object.assign(capacitor, { capacitanceFarads: null });
      expect(simulateTransient(explicitNull, { durationSeconds: 0.01, timeStepSeconds: 0.001 }).status)
        .toBe("invalid");
    }
  });

  it("rejects invalid source values before transient source overrides can mask them", () => {
    const invalidBattery = rcCircuit();
    Object.assign(invalidBattery.parts[0], { voltageVolts: 0 });
    expect(simulateTransient(invalidBattery, { durationSeconds: 0.01, timeStepSeconds: 0.01 }).status)
      .toBe("invalid");

    const invalidAcSource = rcCircuit();
    Object.assign(invalidAcSource.parts[0], {
      kind: "ac-source",
      frequencyHz: 50,
      voltageVolts: Number.NaN,
    });
    expect(simulateTransient(invalidAcSource, { durationSeconds: 0.01, timeStepSeconds: 0.01 }).status)
      .toBe("invalid");
  });

  it("keeps the RC charging current when the time step is subnormal", () => {
    const result = simulateTransient(rcCircuit(), {
      durationSeconds: Number.MIN_VALUE,
      timeStepSeconds: Number.MIN_VALUE,
    });
    const sample = result.samples[1];
    const companionResistance = Number.MIN_VALUE / 1e-3;
    const expectedCurrent = 1 / (1000 + companionResistance);
    const expectedVoltage = expectedCurrent * companionResistance;

    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(2);
    expect(sample?.timeSeconds).toBe(Number.MIN_VALUE);
    expect(expectedVoltage).toBe(Number.MIN_VALUE);
    expect(sample?.parts.capacitor?.voltageVolts).toBe(expectedVoltage);
    expect(sample?.parts.capacitor?.currentAmps).toBeCloseTo(expectedCurrent, 12);
    expect(sample?.parts.resistor?.currentAmps).toBeCloseTo(expectedCurrent, 12);
  });

  it("rejects a time step when the capacitor companion resistance underflows to zero", () => {
    const document = rcCircuit();
    const capacitor = document.parts.find(({ kind }) => kind === "capacitor");
    if (capacitor?.kind !== "capacitor") { throw new Error("Missing capacitor"); }
    capacitor.capacitanceFarads = Number.MAX_VALUE;
    const result = simulateTransient(document, {
      durationSeconds: Number.MIN_VALUE,
      timeStepSeconds: Number.MIN_VALUE,
    });

    expect(result.status).toBe("invalid");
    expect(result.samples).toHaveLength(1);
  });

  it("counts both potentiometer segment currents when bounding solver work", () => {
    const document: CircuitDocument = {
      title: "可変抵抗の過渡計算量",
      parts: Array.from({ length: 16 }, (_, index) => part(`pot-${index}`, "potentiometer")),
      wires: [],
    };
    const result = simulateTransient(document, { durationSeconds: 1.6, timeStepSeconds: 0.001 });

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("演算量");
    expect(result.samples).toEqual([]);
  });

  it("rejects invalid, oversized, and excessively expensive analyses before solving", () => {
    const document = rcCircuit();
    expect(simulateTransient(document, { durationSeconds: 0, timeStepSeconds: 0.01 }).status).toBe("invalid");
    expect(simulateTransient(document, { durationSeconds: 10, timeStepSeconds: 0.001 }).message)
      .toContain(`${MAX_TRANSIENT_STEPS}以下`);

    const tooManyPins: CircuitDocument = {
      title: "Too many terminals",
      parts: Array.from({ length: 257 }, (_, index) => part(`r${index}`, "resistor")),
      wires: [],
    };
    expect(simulateTransient(tooManyPins, { durationSeconds: 0.01, timeStepSeconds: 0.01 }).message)
      .toContain("端子数");

    const tooMuchWork: CircuitDocument = {
      title: "Too much transient solver work",
      parts: Array.from({ length: 100 }, (_, index) => part(`r${index}`, "resistor")),
      wires: [],
    };
    expect(simulateTransient(tooMuchWork, { durationSeconds: 2, timeStepSeconds: 0.001 }).message)
      .toContain("演算量");
  });
});
