import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "./circuit-model.js";
import { analyzeAnalogCircuit, solveAnalogStep } from "./analog-solver.js";
import { meterStatuses } from "./meter-status.js";

const part = (
  id: string,
  kind: CircuitPartKind,
  extra: Partial<CircuitPart> = {},
): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...extra,
});

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

describe("analyzeAnalogCircuit", () => {
  it("solves an ideal DC voltage source exactly with its series resistance", () => {
    const document: CircuitDocument = {
      title: "電池と抵抗",
      parts: [
        part("battery", "battery", { voltageVolts: 10, internalResistanceOhms: 10 }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("w1", "battery", "a", "load", "a"),
        wire("w2", "load", "b", "battery", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document);

    expect(result.status).toBe("valid");
    expect(result.parts.load.current.real).toBeCloseTo(10 / 110, 8);
    expect(result.parts.battery.current.real).toBeCloseTo(-10 / 110, 8);
    expect(result.parts.battery.voltage.real).toBeCloseTo(10 * 100 / 110, 8);
    expect(result.parts.battery.power.real).toBeLessThan(0);
  });

  it("reads a series ammeter and an open-circuit voltmeter without loading the circuit", () => {
    const document: CircuitDocument = {
      title: "直列電流計と並列電圧計",
      parts: [
        part("source", "battery", { voltageVolts: 9 }),
        part("ammeter", "ammeter"),
        part("load", "resistor", { resistanceOhms: 9 }),
        part("voltmeter", "voltmeter"),
      ],
      wires: [
        wire("w1", "source", "a", "ammeter", "a"),
        wire("w2", "ammeter", "b", "load", "a"),
        wire("w3", "load", "b", "source", "b"),
        wire("w4", "voltmeter", "a", "load", "a"),
        wire("w5", "voltmeter", "b", "load", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document);

    expect(result.status).toBe("valid");
    expect(result.parts.ammeter.current.real).toBeCloseTo(1, 8);
    expect(result.parts.ammeter.meterStatus).toBe("connected");
    expect(result.parts.voltmeter.voltage.real).toBeCloseTo(9, 8);
    expect(result.parts.voltmeter.current.real).toBe(0);
    expect(result.parts.voltmeter.meterStatus).toBe("connected");
  });

  it("marks a wire-bypassed ammeter as floating instead of claiming its current is zero", () => {
    const document: CircuitDocument = {
      title: "電流計の導線バイパス",
      parts: [
        part("source", "battery", { voltageVolts: 9 }),
        part("load", "resistor", { resistanceOhms: 9 }),
        part("ammeter", "ammeter"),
      ],
      wires: [
        wire("w1", "source", "a", "load", "a"),
        wire("w2", "load", "b", "source", "b"),
        wire("w3", "ammeter", "a", "source", "a"),
        wire("w4", "ammeter", "b", "source", "a"),
      ],
    };

    const result = analyzeAnalogCircuit(document);

    expect(result.status).toBe("valid");
    expect(result.parts.ammeter.meterStatus).toBe("floating");
  });

  it("reads zero current through an open switch and the source voltage across it", () => {
    const document: CircuitDocument = {
      title: "開閉スイッチと計器",
      parts: [
        part("source", "battery", { voltageVolts: 9 }),
        part("ammeter", "ammeter"),
        part("switch", "switch", { initiallyClosed: false }),
        part("load", "resistor", { resistanceOhms: 10 }),
        part("voltmeter", "voltmeter"),
      ],
      wires: [
        wire("w1", "source", "a", "ammeter", "a"),
        wire("w2", "ammeter", "b", "switch", "a"),
        wire("w3", "switch", "b", "load", "a"),
        wire("w4", "load", "b", "source", "b"),
        wire("w5", "voltmeter", "a", "switch", "a"),
        wire("w6", "voltmeter", "b", "switch", "b"),
      ],
    };

    const open = analyzeAnalogCircuit(document, { mode: "dc", switchStates: { switch: false } });
    const closed = analyzeAnalogCircuit(document, { mode: "dc", switchStates: { switch: true } });

    expect(open.status).toBe("valid");
    expect(open.parts.ammeter.current.real).toBeCloseTo(0, 8);
    expect(open.parts.ammeter.meterStatus).toBe("connected");
    expect(open.parts.voltmeter.voltage.real).toBeCloseTo(9, 8);
    expect(open.parts.voltmeter.meterStatus).toBe("connected");
    expect(closed.status).toBe("valid");
    expect(closed.parts.ammeter.current.real).toBeCloseTo(0.9, 8);
    expect(closed.parts.voltmeter.voltage.real).toBeCloseTo(0, 8);
  });

  it("distinguishes a DC-open capacitor from its AC impedance for voltmeter references", () => {
    const document: CircuitDocument = {
      title: "コンデンサーをまたぐ電圧計",
      parts: [part("capacitor", "capacitor"), part("voltmeter", "voltmeter")],
      wires: [
        wire("w1", "voltmeter", "a", "capacitor", "a"),
        wire("w2", "voltmeter", "b", "capacitor", "b"),
      ],
    };

    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });

    expect(dc.status).toBe("valid");
    expect(dc.parts.voltmeter.meterStatus).toBe("floating");
    expect(ac.status).toBe("valid");
    expect(ac.parts.voltmeter.meterStatus).toBe("connected");
  });

  it("does not invent a voltage between separate floating circuits", () => {
    const document: CircuitDocument = {
      title: "別々の浮遊回路をまたぐ電圧計",
      parts: [
        part("source1", "battery", { voltageVolts: 9 }),
        part("load1", "resistor", { resistanceOhms: 9 }),
        part("source2", "battery", { voltageVolts: 3 }),
        part("load2", "resistor", { resistanceOhms: 3 }),
        part("voltmeter", "voltmeter"),
      ],
      wires: [
        wire("w1", "source1", "a", "load1", "a"),
        wire("w2", "load1", "b", "source1", "b"),
        wire("w3", "source2", "a", "load2", "a"),
        wire("w4", "load2", "b", "source2", "b"),
        wire("w5", "voltmeter", "a", "source1", "a"),
        wire("w6", "voltmeter", "b", "source2", "a"),
      ],
    };

    const result = analyzeAnalogCircuit(document);

    expect(result.status).toBe("valid");
    expect(result.parts.voltmeter.meterStatus).toBe("floating");
  });

  it("marks missing leads and shares the analog solver's implicit reference", () => {
    const unconnected: CircuitDocument = {
      title: "未接続の計器",
      parts: [part("ammeter", "ammeter"), part("voltmeter", "voltmeter")],
      wires: [],
    };
    const opAmpOutputProbe: CircuitDocument = {
      title: "オペアンプ基準点",
      parts: [part("opamp", "op-amp"), part("voltmeter", "voltmeter")],
      wires: [
        wire("w1", "voltmeter", "a", "opamp", "a"),
        wire("w2", "voltmeter", "b", "opamp", "c"),
      ],
    };

    const unconnectedReadings = analyzeAnalogCircuit(unconnected);
    const opAmpReadings = analyzeAnalogCircuit(opAmpOutputProbe);

    expect(unconnectedReadings.parts.ammeter.meterStatus).toBe("unconnected");
    expect(unconnectedReadings.parts.voltmeter.meterStatus).toBe("unconnected");
    expect(opAmpReadings.parts.voltmeter.meterStatus).toBe("connected");
  });

  it("treats closed ideal paths as ammeter bypasses and DC inductors as shorts", () => {
    const switchBypass: CircuitDocument = {
      title: "スイッチによる電流計バイパス",
      parts: [part("ammeter", "ammeter"), part("switch", "switch", { initiallyClosed: false })],
      wires: [
        wire("w1", "ammeter", "a", "switch", "a"),
        wire("w2", "ammeter", "b", "switch", "b"),
      ],
    };
    const inductorBypass: CircuitDocument = {
      title: "コイルによる電流計バイパス",
      parts: [part("ammeter", "ammeter"), part("inductor", "inductor")],
      wires: [
        wire("w1", "ammeter", "a", "inductor", "a"),
        wire("w2", "ammeter", "b", "inductor", "b"),
      ],
    };

    expect(meterStatuses(switchBypass, { mode: "dc" }).ammeter).toBe("connected");
    expect(meterStatuses(switchBypass, { mode: "dc", switchStates: { switch: true } }).ammeter).toBe("floating");
    expect(meterStatuses(inductorBypass, { mode: "dc" }).ammeter).toBe("floating");
    expect(meterStatuses(inductorBypass, { mode: "ac" }).ammeter).toBe("connected");
  });

  it("joins every ground symbol into the same reference node", () => {
    const document: CircuitDocument = {
      title: "共通GND",
      parts: [
        part("battery", "battery", { voltageVolts: 9 }),
        part("load", "resistor", { resistanceOhms: 1000 }),
        part("ground1", "ground"),
        part("ground2", "ground"),
      ],
      wires: [
        wire("w1", "battery", "a", "load", "a"),
        wire("w2", "battery", "b", "ground1", "a"),
        wire("w3", "load", "b", "ground2", "a"),
      ],
    };

    const result = analyzeAnalogCircuit(document);

    expect(result.status).toBe("valid");
    expect(result.parts.load.voltage.real).toBeCloseTo(9, 8);
    expect(result.parts.load.current.real).toBeCloseTo(0.009, 8);
    expect(result.parts.ground1.terminalVoltages.a.real).toBe(0);
    expect(result.parts.ground2.terminalVoltages.a.real).toBe(0);
  });

  it("uses the switch state override in the DC network", () => {
    const document: CircuitDocument = {
      title: "スイッチ",
      parts: [
        part("battery", "battery"),
        part("switch", "switch", { initiallyClosed: true }),
        part("load", "resistor", { resistanceOhms: 10 }),
      ],
      wires: [
        wire("w1", "battery", "a", "switch", "a"),
        wire("w2", "switch", "b", "load", "a"),
        wire("w3", "load", "b", "battery", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "dc", switchStates: { switch: false } });

    expect(result.status).toBe("valid");
    expect(result.parts.load.current.real).toBeCloseTo(0, 8);
    expect(result.parts.switch.voltage.real).toBeCloseTo(9, 8);
  });

  it("solves a series RC network as an RMS complex phasor", () => {
    const document: CircuitDocument = {
      title: "RCローパス",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, frequencyHz: 1000 }),
        part("resistor", "resistor", { resistanceOhms: 1000 }),
        part("capacitor", "capacitor", { capacitanceFarads: 1e-6 }),
      ],
      wires: [
        wire("w1", "source", "a", "resistor", "a"),
        wire("w2", "resistor", "b", "capacitor", "a"),
        wire("w3", "capacitor", "b", "source", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });
    const capacitorVoltage = result.parts.capacitor.voltage;
    const expectedMagnitude = 5 / Math.sqrt(1 + (2 * Math.PI) ** 2);

    expect(result.status).toBe("valid");
    expect(result.frequencyHz).toBe(1000);
    expect(Math.hypot(capacitorVoltage.real, capacitorVoltage.imaginary)).toBeCloseTo(
      expectedMagnitude,
      8,
    );
    expect(Math.atan2(capacitorVoltage.imaginary, capacitorVoltage.real)).toBeCloseTo(
      -Math.atan(2 * Math.PI),
      8,
    );
    expect(result.parts.source.voltage.real).toBeCloseTo(5, 8);
  });

  it("uses the RMS source phase and computes reactive element current", () => {
    const document: CircuitDocument = {
      title: "交流電源とコイル",
      parts: [
        part("source", "ac-source", {
          voltageVolts: 2,
          frequencyHz: 50,
          phaseDegrees: 90,
        }),
        part("inductor", "inductor", { inductanceHenries: 1 / (2 * Math.PI * 50) }),
      ],
      wires: [
        wire("w1", "source", "a", "inductor", "a"),
        wire("w2", "inductor", "b", "source", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 50 });

    expect(result.status).toBe("valid");
    expect(result.parts.source.voltage.real).toBeCloseTo(0, 8);
    expect(result.parts.source.voltage.imaginary).toBeCloseTo(2, 8);
    expect(result.parts.inductor.current.real).toBeCloseTo(2, 8);
    expect(result.parts.inductor.current.imaginary).toBeCloseTo(0, 8);
    expect(result.parts.inductor.power.imaginary).toBeGreaterThan(0);
  });

  it("solves a DC current source and rejects one with no return path", () => {
    const closedLoop: CircuitDocument = {
      title: "電流源",
      parts: [
        part("source", "current-source", { currentAmps: 0.002 }),
        part("load", "resistor", { resistanceOhms: 1000 }),
      ],
      wires: [
        wire("w1", "source", "a", "load", "a"),
        wire("w2", "source", "b", "load", "b"),
      ],
    };
    const open: CircuitDocument = {
      title: "開放電流源",
      parts: [part("source", "current-source", { currentAmps: 0.002 })],
      wires: [],
    };

    const result = analyzeAnalogCircuit(closedLoop);

    expect(result.status).toBe("valid");
    expect(result.parts.load.current.real).toBeCloseTo(-0.002, 8);
    expect(analyzeAnalogCircuit(open).status).toBe("invalid");
    expect(analyzeAnalogCircuit(open).message).toContain("戻り道");
  });

  it("rejects current supplied only through an open capacitor or reverse-biased semiconductor", () => {
    const capacitorOnlyReturn: CircuitDocument = {
      title: "直流では開放のコンデンサー",
      parts: [part("source", "current-source"), part("capacitor", "capacitor")],
      wires: [
        wire("w1", "source", "a", "capacitor", "a"),
        wire("w2", "source", "b", "capacitor", "b"),
      ],
    };
    const reverseDiodeReturn: CircuitDocument = {
      title: "逆バイアスダイオードだけの戻り道",
      parts: [part("source", "current-source"), part("diode", "diode")],
      wires: [
        wire("w1", "source", "a", "diode", "a"),
        wire("w2", "source", "b", "diode", "b"),
      ],
    };
    const offMosReturn: CircuitDocument = {
      title: "遮断中MOSFETだけの戻り道",
      parts: [part("source", "current-source"), part("mos", "nmos")],
      wires: [
        wire("w1", "source", "a", "mos", "c"),
        wire("w2", "source", "b", "mos", "a"),
        wire("w3", "mos", "b", "mos", "c"),
      ],
    };

    const capacitorResult = analyzeAnalogCircuit(capacitorOnlyReturn);
    expect(capacitorResult.status).toBe("invalid");
    expect(capacitorResult.message).toContain("戻り道");

    for (const document of [reverseDiodeReturn, offMosReturn]) {
      const result = analyzeAnalogCircuit(document);
      expect(result.status, document.title).toBe("invalid");
      expect(result.message, document.title).toContain("微小コンダクタンス");
    }
  });

  it("converges to a diode operating point with the Shockley model", () => {
    const document: CircuitDocument = {
      title: "ダイオード",
      parts: [
        part("battery", "battery", { voltageVolts: 5 }),
        part("resistor", "resistor", { resistanceOhms: 1000 }),
        part("diode", "diode"),
      ],
      wires: [
        wire("w1", "battery", "a", "resistor", "a"),
        wire("w2", "resistor", "b", "diode", "a"),
        wire("w3", "diode", "b", "battery", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document);

    expect(result.status).toBe("valid");
    expect(result.parts.diode.voltage.real).toBeGreaterThan(0.5);
    expect(result.parts.diode.voltage.real).toBeLessThan(0.9);
    expect(result.parts.diode.current.real).toBeGreaterThan(0.004);
    expect(result.parts.diode.current.real).toBeLessThan(0.005);
  });

  it("uses a DC voltage override for a transient source sample", () => {
    const document: CircuitDocument = {
      title: "上書き電圧",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, frequencyHz: 60, offsetVolts: -2 }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("w1", "source", "a", "load", "a"),
        wire("w2", "load", "b", "source", "b"),
      ],
    };

    const result = solveAnalogStep(document, { mode: "dc", voltageOverrides: { source: 3 } });

    expect(result.status).toBe("valid");
    expect(result.parts.load.voltage.real).toBeCloseTo(3, 8);
    expect(result.parts.load.current.real).toBeCloseTo(0.03, 8);
  });

  it("reports an ideal voltage source short instead of approximating it", () => {
    const document: CircuitDocument = {
      title: "電源短絡",
      parts: [part("battery", "battery")],
      wires: [wire("short", "battery", "a", "battery", "b")],
    };

    const result = analyzeAnalogCircuit(document);

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("短絡");
    expect(result.issues[0]).toMatchObject({ severity: "error", partId: "battery" });
  });

  it("solves linear circuits above the old Newton step size and rejects non-finite values", () => {
    const highVoltage: CircuitDocument = {
      title: "高電圧の線形回路",
      parts: [
        part("source", "battery", { voltageVolts: 100 }),
        part("load", "resistor", { resistanceOhms: 1000 }),
      ],
      wires: [
        wire("w1", "source", "a", "load", "a"),
        wire("w2", "load", "b", "source", "b"),
      ],
    };
    const invalidFrequency: CircuitDocument = {
      title: "無効な周波数",
      parts: [part("source", "ac-source", { frequencyHz: Number.POSITIVE_INFINITY })],
      wires: [],
    };
    const invalidResistance: CircuitDocument = {
      title: "無効な抵抗",
      parts: [part("load", "resistor", { resistanceOhms: Number.NaN })],
      wires: [],
    };

    const highVoltageResult = analyzeAnalogCircuit(highVoltage);
    expect(highVoltageResult.status).toBe("valid");
    expect(highVoltageResult.parts.load.current.real).toBeCloseTo(0.1, 8);
    expect(analyzeAnalogCircuit(invalidFrequency, { mode: "ac" }).status).toBe("invalid");
    expect(analyzeAnalogCircuit(invalidResistance).status).toBe("invalid");
  });

  it("keeps nonlinear devices' small-signal AC response around their DC bias", () => {
    const document: CircuitDocument = {
      title: "ダイオード小信号応答",
      parts: [
        part("source", "ac-source", {
          voltageVolts: 0.01,
          frequencyHz: 1000,
          offsetVolts: 5,
        }),
        part("resistor", "resistor", { resistanceOhms: 1000 }),
        part("diode", "diode"),
      ],
      wires: [
        wire("w1", "source", "a", "resistor", "a"),
        wire("w2", "resistor", "b", "diode", "a"),
        wire("w3", "diode", "b", "source", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });

    expect(result.status).toBe("valid");
    expect(Math.hypot(result.parts.diode.voltage.real, result.parts.diode.voltage.imaginary)).toBeGreaterThan(0);
    expect(Math.hypot(result.parts.diode.voltage.real, result.parts.diode.voltage.imaginary)).toBeLessThan(0.0001);
    expect(result.issues.some((issue) => issue.message.includes("微分コンダクタンス"))).toBe(true);
  });

  it("checks potentiometer polarity and rail-limited op-amp output", () => {
    const potCircuit: CircuitDocument = {
      title: "可変抵抗の分圧",
      parts: [
        part("source", "battery", { voltageVolts: 10 }),
        part("pot", "potentiometer", { resistanceOhms: 1000, wiperPosition: 0.25 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("w1", "source", "a", "pot", "a"),
        wire("w2", "source", "b", "ground", "a"),
        wire("w3", "pot", "b", "ground", "a"),
      ],
    };
    const saturatedOpAmp: CircuitDocument = {
      title: "オペアンプ正側飽和",
      parts: [
        part("input", "battery", { voltageVolts: 5 }),
        part("opamp", "op-amp"),
        part("load", "resistor", { resistanceOhms: 1000 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("w1", "input", "a", "opamp", "a"),
        wire("w2", "input", "b", "ground", "a"),
        wire("w3", "opamp", "c", "load", "a"),
        wire("w4", "load", "b", "ground", "a"),
      ],
    };

    const potResult = analyzeAnalogCircuit(potCircuit);
    const opAmpResult = analyzeAnalogCircuit(saturatedOpAmp);

    expect(potResult.status).toBe("valid");
    expect(potResult.parts.pot.terminalVoltages.c.real).toBeCloseTo(7.5, 8);
    expect(opAmpResult.status).toBe("valid");
    expect(opAmpResult.parts.opamp.terminalVoltages.c.real).toBeCloseTo(15 * (1000 / 1020), 6);
  });

  it("respects PNP and PMOS high-side current polarities", () => {
    const pnpCircuit: CircuitDocument = {
      title: "PNPハイサイド",
      parts: [
        part("supply", "battery", { voltageVolts: 5 }),
        part("transistor", "pnp-transistor"),
        part("load", "resistor", { resistanceOhms: 1000 }),
        part("basePullDown", "resistor", { resistanceOhms: 100_000 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("w1", "supply", "a", "transistor", "c"),
        wire("w2", "supply", "b", "ground", "a"),
        wire("w3", "transistor", "a", "load", "a"),
        wire("w4", "load", "b", "ground", "a"),
        wire("w5", "transistor", "b", "basePullDown", "a"),
        wire("w6", "basePullDown", "b", "ground", "a"),
      ],
    };
    const pmosCircuit: CircuitDocument = {
      title: "PMOSハイサイド",
      parts: [
        part("supply", "battery", { voltageVolts: 5 }),
        part("transistor", "pmos"),
        part("load", "resistor", { resistanceOhms: 1000 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("w1", "supply", "a", "transistor", "c"),
        wire("w2", "supply", "b", "ground", "a"),
        wire("w3", "transistor", "a", "load", "a"),
        wire("w4", "load", "b", "ground", "a"),
        wire("w5", "transistor", "b", "ground", "a"),
      ],
    };

    const pnpResult = analyzeAnalogCircuit(pnpCircuit);
    const pmosResult = analyzeAnalogCircuit(pmosCircuit);

    expect(pnpResult.status, pnpResult.message).toBe("valid");
    expect(pnpResult.parts.load.current.real).toBeGreaterThan(0);
    expect(pnpResult.parts.transistor.terminalCurrents.a.real).toBeLessThan(0);
    expect(pmosResult.status, pmosResult.message).toBe("valid");
    expect(pmosResult.parts.load.current.real).toBeGreaterThan(0);
    expect(pmosResult.parts.transistor.terminalCurrents.a.real).toBeLessThan(0);
    expect(pmosResult.parts.transistor.terminalCurrents.c.real).toBeGreaterThan(0);
  });
});
