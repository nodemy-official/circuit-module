import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { circuitPartCatalog, circuitPartKinds, circuitPartNumericFields, type CircuitPart, type CircuitWire } from "../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis, type CircuitPartReading } from "../circuit-solver.js";
import { CircuitAnalysisPanel } from "./CircuitAnalysisPanel.js";
import { CircuitIcon } from "./CircuitIcon.js";
import { CircuitInspector, type CircuitInspectorProps } from "./CircuitInspector.js";
import { CircuitPalette } from "./CircuitPalette.js";
import { CircuitPartIcon } from "./CircuitPalette.js";
import { CircuitPreviewPanel } from "./CircuitPreviewPanel.js";
import { CircuitMeterReadout, getMeterDisplay } from "./CircuitMeterReadout.js";
import { measurementLabels } from "./measurement-labels.js";

const part: CircuitPart = {
  id: "part-1",
  kind: "resistor",
  x: 0,
  y: 0,
  label: "R1",
  resistanceOhms: 10,
};

const wire: CircuitWire = {
  id: "wire-1",
  from: { partId: "part-1", terminal: "a" },
  to: { partId: "part-2", terminal: "b" },
};

const reading: CircuitPartReading = {
  voltageVolts: 5,
  currentAmps: 0.5,
  powerWatts: 2.5,
};

function defaultPart(kind: CircuitPart["kind"], id = `part-${kind}`): CircuitPart {
  return { id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults };
}

describe("headless panel styling contract", () => {
  it("shows an omitted switch state as closed in the Inspector and preview", () => {
    const switchPart: CircuitPart = { id: "switch", kind: "switch", x: 0, y: 0, label: "スイッチ" };
    const document = { title: "既定値のスイッチ", parts: [switchPart], wires: [] };
    const analysis = analyzeCircuit(document);
    const inspector = renderToStaticMarkup(<CircuitInspector part={switchPart} onChange={() => {}} />);
    const preview = renderToStaticMarkup(
      <CircuitPreviewPanel document={document} initialDocument={document} analysis={analysis} onChange={() => {}} onReset={() => {}} />,
    );

    expect(analysis.parts.switch.switchClosed).toBe(true);
    expect(inspector).toContain('aria-checked="true"');
    expect(preview).toContain('aria-checked="true"');
    expect(preview).toContain(">ON</strong>");
  });

  it("uses terminal-aware reading labels and keeps potentiometer current referenced to A", () => {
    expect(measurementLabels("potentiometer")).toEqual({ voltage: "電圧（A−B）", current: "電流（Aへ流入）" });
    expect(measurementLabels("op-amp")).toEqual({ voltage: "出力電圧（対GND）", current: "電流（出力へ流入）" });
  });

  it("labels fallback wire endpoints beyond terminal B", () => {
    const threeTerminalWire: CircuitWire = {
      id: "three-terminal-wire",
      from: { partId: "part-3", terminal: "c" },
      to: { partId: "part-4", terminal: "a" },
    };
    const markup = renderToStaticMarkup(<CircuitInspector wire={threeTerminalWire} />);

    expect(markup).toContain("端子C → 端子A");
  });

  it("keeps palette root attributes and applies root and inner slot overrides", () => {
    const markup = renderToStaticMarkup(
      <CircuitPalette
        id="host-palette"
        title="Host palette"
        aria-label="カスタム部品一覧"
        data-host="palette"
        className="host-palette"
        style={{ color: "green", "--circuit-accent": "crimson" }}
        onClick={() => {}}
        onAdd={() => {}}
        slotProps={{
          root: {
            className: "root-slot",
            style: { "--circuit-accent-strong": "darkred" },
          },
          searchInput: { className: "search-slot", style: { borderColor: "orange" } },
          partItem: { className: "item-slot", style: { outlineColor: "blue" } },
        }}
      />,
    );

    expect(markup).toContain('id="host-palette"');
    expect(markup).toContain('title="Host palette"');
    expect(markup).toContain('aria-label="カスタム部品一覧"');
    expect(markup).toContain('data-host="palette"');
    expect(markup).toContain('class="circuit-panel circuit-palette host-palette root-slot"');
    expect(markup).toMatch(/style="[^"]*color:green/);
    expect(markup).toMatch(/--circuit-accent:crimson/);
    expect(markup).toMatch(/--circuit-accent-strong:darkred/);
    expect(markup).toMatch(/class="circuit-palette__search-input search-slot"[^>]*style="[^"]*border-color:orange/);
    expect(markup).toMatch(/class="circuit-palette__item item-slot"[^>]*style="[^"]*outline-color:blue"[^>]*data-kind="battery"/);
  });

  const inspectorCases: Array<{
    name: string;
    props: Pick<CircuitInspectorProps, "part" | "wire" | "reading">;
    expectedState: "empty" | "wire" | "part";
    expectedKind?: string;
  }> = [
    { name: "empty", props: {}, expectedState: "empty" },
    { name: "wire", props: { wire }, expectedState: "wire" },
    { name: "part", props: { part, reading }, expectedState: "part", expectedKind: "resistor" },
  ];

  it.each(inspectorCases)("preserves root attributes in the Inspector $name branch", ({ name, props, expectedState, expectedKind }) => {
    const markup = renderToStaticMarkup(
      <CircuitInspector
        {...props}
        id={`host-inspector-${name}`}
        title="Host inspector"
        aria-label="Custom inspector"
        data-host="inspector"
        className="host-inspector"
        style={{ color: "purple", "--circuit-accent": "royalblue" }}
        onClick={() => {}}
        slotProps={{
          root: {
            className: "root-slot",
            style: { "--circuit-accent-strong": "navy" },
          },
          headingTitle: { className: "heading-slot", style: { color: "navy" } },
        }}
      />,
    );

    expect(markup).toContain(`id="host-inspector-${name}"`);
    expect(markup).toContain('title="Host inspector"');
    expect(markup).toContain('aria-label="Custom inspector"');
    expect(markup).toContain('data-host="inspector"');
    expect(markup).toContain('class="circuit-panel circuit-inspector host-inspector root-slot"');
    expect(markup).toContain(`data-state="${expectedState}"`);
    if (expectedKind) { expect(markup).toContain(`data-kind="${expectedKind}"`); }
    expect(markup).toMatch(/style="[^"]*color:purple/);
    expect(markup).toMatch(/--circuit-accent:royalblue/);
    expect(markup).toMatch(/--circuit-accent-strong:navy/);
    expect(markup).toMatch(/class="heading-slot" style="color:navy/);
  });

  it("applies AnalysisPanel slots and reports dynamic status and issue attributes", () => {
    const analysis: CircuitAnalysis = {
      status: "invalid",
      currentAmps: null,
      message: "invalid circuit",
      bulbPowerWatts: {},
      parts: {},
      wireCurrents: {},
      issues: [{ severity: "warning", message: "Check the resistor value.", partId: part.id }],
    };
    const markup = renderToStaticMarkup(
      <CircuitAnalysisPanel
        analysis={analysis}
        id="host-analysis"
        data-host="analysis"
        className="host-analysis"
        style={{ color: "teal", "--circuit-accent": "seagreen" }}
        slotProps={{
          state: { className: "state-slot", style: { backgroundColor: "mistyrose" } },
          issue: { className: "issue-slot", style: { fontWeight: "bold" } },
        }}
      />,
    );

    expect(markup).toContain('id="host-analysis"');
    expect(markup).toContain('data-host="analysis"');
    expect(markup).toContain('class="circuit-panel circuit-analysis host-analysis"');
    expect(markup).toMatch(/--circuit-accent:seagreen/);
    expect(markup).toContain('data-status="invalid"');
    expect(markup).toMatch(/class="circuit-analysis__state circuit-analysis__state--invalid state-slot"/);
    expect(markup).toMatch(/style="background-color:mistyrose/);
    expect(markup).toMatch(/class="circuit-analysis__issue--warning issue-slot"[^>]*data-severity="warning"/);
    expect(markup).toMatch(/style="font-weight:bold/);
  });

  it("forwards SVG dimensions, classes, and styles to both icon components", () => {
    const markup = renderToStaticMarkup(
      <>
        <CircuitIcon name="search" width={32} height={24} className="host-icon" style={{ color: "crimson", "--icon-accent": "firebrick" }} data-host="icon" />
        <CircuitPartIcon kind="battery" width="50%" height={30} className="host-part-icon" style={{ color: "darkorange", "--icon-accent": "saddlebrown" }} data-host="part-icon" />
      </>,
    );

    expect(markup).toContain('width="32" height="24"');
    expect(markup).toContain('class="host-icon"');
    expect(markup).toContain('data-host="icon"');
    expect(markup).toMatch(/style="color:crimson/);
    expect(markup).toMatch(/--icon-accent:firebrick/);
    expect(markup).toContain('width="50%" height="30"');
    expect(markup).toContain('class="host-part-icon"');
    expect(markup).toContain('data-host="part-icon"');
    expect(markup).toMatch(/style="color:darkorange/);
    expect(markup).toMatch(/--icon-accent:saddlebrown/);
  });

  it("lists every catalog part and reserves keyboard shortcuts 1 through 7 for the original parts", () => {
    const markup = renderToStaticMarkup(<CircuitPalette onAdd={() => {}} />);
    for (const kind of circuitPartKinds) {
      expect(markup).toContain(`data-kind="${kind}"`);
    }
    expect((markup.match(/<kbd\b/g) ?? [])).toHaveLength(7);
    const acButton = markup.match(/<button\b[^>]*data-kind="ac-source"[^>]*>/)?.[0];
    expect(acButton).toBeDefined();
    expect(acButton).not.toContain("aria-keyshortcuts");
  });

  it("renders metadata-defined properties and AC readings for newly supported parts", () => {
    const acSource = defaultPart("ac-source", "ac-1");
    const markup = renderToStaticMarkup(
      <>
        <CircuitInspector
          part={acSource}
          reading={{ ...reading, voltagePhaseDegrees: 15, currentPhaseDegrees: -20, reactivePowerVars: 0.25 }}
          onChange={() => {}}
        />
        <CircuitInspector part={defaultPart("op-amp", "op-1")} onChange={() => {}} />
      </>,
    );

    for (const { key } of circuitPartNumericFields("ac-source")) {
      expect(markup).toContain(`data-field="${key}"`);
    }
    for (const { key } of circuitPartNumericFields("op-amp")) {
      expect(markup).toContain(`data-field="${key}"`);
    }
    expect(markup).toContain('data-measurement="voltage-phase"');
    expect(markup).toContain('data-measurement="current-phase"');
    expect(markup).toContain('data-measurement="reactive-power"');
  });

  it("labels transient readings with the shared time cursor for parts and meters", () => {
    const ammeter = defaultPart("ammeter", "meter-a");
    const markup = renderToStaticMarkup(
      <>
        <CircuitInspector part={defaultPart("resistor", "resistor-1")} reading={reading} readingTimeSeconds={0.004} />
        <CircuitInspector
          part={defaultPart("ac-source", "ac-source-1")}
          reading={{ ...reading, voltagePhaseDegrees: 15, currentPhaseDegrees: -20 }}
          readingTimeSeconds={0.004}
        />
        <CircuitInspector part={ammeter} reading={reading} analysisStatus="closed" readingTimeSeconds={0.004} />
      </>,
    );

    expect(markup.match(/時間カーソル 0\.004 s の瞬時値です。/g)).toHaveLength(3);
    expect(markup).not.toContain("直流の電圧・電流は端子の向きに対する符号付き値です。");
    expect(markup).not.toContain("交流の電圧・電流は実効値です。");
    expect(markup).toContain("+500 mA");
  });

  it("exposes new component values in preview controls and AC phase measurements", () => {
    const acSource = defaultPart("ac-source", "ac-1");
    const capacitor = defaultPart("capacitor", "c-1");
    const previewAnalysis: CircuitAnalysis = {
      status: "closed",
      currentAmps: null,
      message: "",
      bulbPowerWatts: {},
      parts: {
        [acSource.id]: { ...reading, voltagePhaseDegrees: 15, currentPhaseDegrees: -20, reactivePowerVars: 0.25 },
        [capacitor.id]: reading,
      },
      wireCurrents: {},
      issues: [],
      mode: "ac",
      frequencyHz: 1000,
    };
    const markup = renderToStaticMarkup(
      <CircuitPreviewPanel
        document={{ title: "AC", parts: [acSource, capacitor], wires: [] }}
        initialDocument={{ title: "AC", parts: [acSource, capacitor], wires: [] }}
        analysis={previewAnalysis}
        onChange={() => {}}
        onReset={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="交流電源の周波数"');
    expect(markup).toContain('aria-label="コンデンサの静電容量"');
    expect(markup).toContain('data-measurement="voltage-phase"');
    expect(markup).toContain('data-measurement="current-phase"');
    expect(markup).toContain('data-measurement="reactive-power"');
  });

  it("keeps each component's numeric fields aligned with the shared property metadata", () => {
    const kindsWithProperties = circuitPartKinds.filter((kind) => circuitPartNumericFields(kind).length > 0);
    for (const kind of kindsWithProperties) {
      const markup = renderToStaticMarkup(<CircuitInspector part={defaultPart(kind)} />);
      for (const { key } of circuitPartNumericFields(kind)) {
        expect(markup, `${kind}.${key}`).toContain(`data-field="${key}"`);
      }
    }
  });
});

describe("meter display", () => {
  it("formats signed DC measurements with engineering prefixes and meter orientation", () => {
    const current = getMeterDisplay("ammeter", { ...reading, currentAmps: 0.3 }, "closed");
    const voltage = getMeterDisplay("voltmeter", { ...reading, voltageVolts: -0.000_004_7 }, "closed");

    expect(current).toMatchObject({ status: "connected", text: "+300 mA" });
    expect(current?.note).toContain("直列");
    expect(current?.note).toContain("A端子（＋）");
    expect(voltage).toMatchObject({ status: "connected", text: "−4.7 μV" });
    expect(voltage?.note).toContain("並列");
    expect(voltage?.note).toContain("B端子（−）");
  });

  it("formats AC RMS magnitude and only the phase for the meter's quantity", () => {
    const current = getMeterDisplay("ammeter", {
      ...reading,
      currentAmps: 0.000_25,
      currentPhaseDegrees: -30,
      voltagePhaseDegrees: 75,
    }, "closed");

    expect(current).toMatchObject({
      text: "250 μA（実効値）",
      phaseText: "電流位相 −30°",
    });
    expect(current?.note).toContain("交流は実効値");
  });

  it("does not report a phase for a zero AC meter reading", () => {
    const current = getMeterDisplay("ammeter", {
      ...reading,
      currentAmps: 0,
      currentPhaseDegrees: 0,
    }, "closed");
    const voltage = getMeterDisplay("voltmeter", {
      ...reading,
      voltageVolts: 0,
      voltagePhaseDegrees: 0,
    }, "closed");

    expect(current).toMatchObject({ status: "connected", text: "0 A（実効値）" });
    expect(current?.phaseText).toBeUndefined();
    expect(voltage).toMatchObject({ status: "connected", text: "0 V（実効値）" });
    expect(voltage?.phaseText).toBeUndefined();
  });

  it("distinguishes unconnected, floating, unmeasured, invalid, and short meters", () => {
    const meterReading = (meterStatus: "unconnected" | "floating") => ({
      ...reading,
      meterStatus,
    }) as CircuitPartReading;

    expect(getMeterDisplay("ammeter", meterReading("unconnected"), "closed")?.text).toBe("— A · 未接続");
    expect(getMeterDisplay("ammeter", meterReading("floating"), "closed")).toMatchObject({
      text: "— A · 値不定",
      note: expect.stringContaining("迂回"),
    });
    expect(getMeterDisplay("voltmeter", meterReading("floating"), "closed")).toMatchObject({
      text: "— V · 値不定",
      note: expect.stringContaining("基準"),
    });
    expect(getMeterDisplay("voltmeter", undefined, "idle")?.text).toBe("— V · 未解析");
    expect(getMeterDisplay("ammeter", reading, "invalid")?.text).toBe("— A · 解析不能");
    expect(getMeterDisplay("ammeter", reading, "short")?.text).toBe("— A · 短絡");
    expect(getMeterDisplay("resistor", reading, "closed")).toBeUndefined();
  });

  it("renders a dedicated readout when no analysis has been provided yet", () => {
    const markup = renderToStaticMarkup(<CircuitMeterReadout kind="voltmeter" />);
    expect(markup).toContain('data-status="unmeasured"');
    expect(markup).toContain("— V · 未解析");
    expect(markup).toContain("並列");
  });

  it("uses the dedicated meter readout in the inspector and preview", () => {
    const ammeter = defaultPart("ammeter", "meter-a");
    const voltmeter = defaultPart("voltmeter", "meter-v");
    const analysis: CircuitAnalysis = {
      status: "closed",
      currentAmps: 0.3,
      message: "",
      bulbPowerWatts: {},
      parts: {
        [ammeter.id]: { ...reading, currentAmps: 0.3 },
        [voltmeter.id]: { ...reading, voltageVolts: 12 },
      },
      wireCurrents: {},
      issues: [],
    };
    const markup = renderToStaticMarkup(
      <>
        <CircuitInspector part={ammeter} reading={analysis.parts[ammeter.id]} analysisStatus={analysis.status} />
        <CircuitPreviewPanel
          document={{ title: "計器", parts: [ammeter, voltmeter], wires: [] }}
          analysis={analysis}
          onChange={() => {}}
          onReset={() => {}}
        />
      </>,
    );

    expect(markup).toContain("+300 mA");
    expect(markup).toContain("+12 V");
    expect(markup).toContain('data-meter-kind="ammeter"');
    expect(markup).toContain('data-meter-kind="voltmeter"');
  });
});
