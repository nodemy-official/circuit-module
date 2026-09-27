import type { CircuitPartKind } from "../circuit-model.js";
import type { CircuitAnalysis, CircuitPartReading } from "../circuit-solver.js";
import type { ComponentPropsWithoutRef } from "react";

export type CircuitMeterStatus = "connected" | "unconnected" | "floating" | "unmeasured" | "invalid" | "short";

export interface CircuitMeterDisplay {
  text: string;
  /** Stable state token suitable for styling and accessibility metadata. */
  status: CircuitMeterStatus;
  note: string;
  phaseText?: string;
}

const engineeringPrefixes: readonly [number, string][] = [
  [1e-15, "f"],
  [1e-12, "p"],
  [1e-9, "n"],
  [1e-6, "μ"],
  [1e-3, "m"],
  [1, ""],
  [1e3, "k"],
  [1e6, "M"],
  [1e9, "G"],
  [1e12, "T"],
];

function formatEngineering(value: number, unit: "A" | "V", signed: boolean) {
  if (value === 0) { return `0 ${unit}`; }
  const absolute = Math.abs(value);
  const prefix = engineeringPrefixes.find(([candidateScale]) => absolute < candidateScale * 1000) ?? engineeringPrefixes.at(-1)!;
  const [scale, symbol] = prefix;
  const number = Number((absolute / scale).toPrecision(4)).toString();
  const sign = signed && value !== 0 ? value < 0 ? "−" : "+" : "";
  return `${sign}${number} ${symbol}${unit}`;
}

function isMeter(kind: CircuitPartKind): kind is "ammeter" | "voltmeter" {
  return kind === "ammeter" || kind === "voltmeter";
}

function statusLabel(status: CircuitMeterStatus) {
  switch (status) {
    case "unconnected": return "未接続";
    case "floating": return "値不定";
    case "unmeasured": return "未解析";
    case "invalid": return "解析不能";
    case "short": return "短絡";
    case "connected": return "接続中";
  }
}

function resolveStatus(
  reading: CircuitPartReading | undefined,
  measurement: number | undefined,
  analysisStatus: CircuitAnalysis["status"] | undefined,
): CircuitMeterStatus {
  if (analysisStatus === "invalid") { return "invalid"; }
  if (analysisStatus === "short") { return "short"; }
  if (reading?.meterStatus === "unconnected") { return "unconnected"; }
  if (reading?.meterStatus === "floating") { return "floating"; }
  if (!reading || measurement === undefined || !Number.isFinite(measurement)) { return "unmeasured"; }
  return "connected";
}

function orientationNote(kind: "ammeter" | "voltmeter") {
  return kind === "ammeter"
    ? "直列につなぎます。A端子（＋）へ流れ込む向きを正として表示します。"
    : "並列につなぎます。A端子（＋）とB端子（−）の電位差を表示します。";
}

function statusNote(status: CircuitMeterStatus, kind: "ammeter" | "voltmeter", isAc: boolean) {
  const orientation = orientationNote(kind);
  switch (status) {
    case "unconnected": return `${orientation}両端子を回路に接続してください。`;
    case "floating": return kind === "ammeter"
      ? `${orientation}導線などで迂回され、計器を流れる電流が定まりません。`
      : `${orientation}電位の基準が定まらず、測定できません。GNDなどの基準点を接続してください。`;
    case "invalid": return `${orientation}回路を解析できません。診断内容を確認してください。`;
    case "short": return `${orientation}短絡があるため数値を表示できません。回路の接続を確認してください。`;
    case "unmeasured": return `${orientation}解析値はまだありません。`;
    case "connected": return isAc
      ? `${orientation}交流は実効値で表示します。`
      : `${orientation}計測値は符号付きです。`;
  }
}

function phaseLabel(kind: "ammeter" | "voltmeter", phase: number) {
  const value = Number(Math.abs(phase).toPrecision(4)).toString();
  const sign = phase === 0 ? "" : phase < 0 ? "−" : "+";
  return `${kind === "ammeter" ? "電流" : "電圧"}位相 ${sign}${value}°`;
}

/** Creates the display shared by the circuit board and the editor's meter panels. */
export function getMeterDisplay(
  kind: CircuitPartKind,
  reading?: CircuitPartReading,
  analysisStatus?: CircuitAnalysis["status"],
): CircuitMeterDisplay | undefined {
  if (!isMeter(kind)) { return undefined; }

  const meterKind = kind;
  const unit = kind === "ammeter" ? "A" : "V";
  const measurement = kind === "ammeter" ? reading?.currentAmps : reading?.voltageVolts;
  const phase = kind === "ammeter" ? reading?.currentPhaseDegrees : reading?.voltagePhaseDegrees;
  const isAc = phase !== undefined && Number.isFinite(phase);
  const status = resolveStatus(reading, measurement, analysisStatus);
  const note = statusNote(status, meterKind, isAc);

  const text = status === "connected" && measurement !== undefined
    ? `${formatEngineering(measurement, unit, !isAc)}${isAc ? "（実効値）" : ""}`
    : `— ${unit} · ${statusLabel(status)}`;
  const phaseText = status === "connected" && isAc && phase !== undefined && measurement !== 0
    ? phaseLabel(meterKind, phase)
    : undefined;

  return { text, status, note, ...(phaseText ? { phaseText } : {}) };
}

export interface CircuitMeterReadoutProps extends Omit<ComponentPropsWithoutRef<"section">, "children" | "kind"> {
  kind: CircuitPartKind;
  reading?: CircuitPartReading;
  analysisStatus?: CircuitAnalysis["status"];
}

/** Large, instrument-specific readout for a selected or previewed meter. */
export function CircuitMeterReadout({
  kind,
  reading,
  analysisStatus,
  className = "",
  style,
  "aria-label": ariaLabel,
  ...sectionProps
}: CircuitMeterReadoutProps) {
  const display = getMeterDisplay(kind, reading, analysisStatus);
  if (!display) { return null; }

  const quantity = kind === "ammeter" ? "計測電流" : "計測電圧";
  return (
    <section
      {...sectionProps}
      className={["circuit-meter-readout", className].filter(Boolean).join(" ")}
      style={style}
      data-meter-kind={kind}
      data-status={display.status}
      aria-label={ariaLabel ?? (kind === "ammeter" ? "電流計の計測結果" : "電圧計の計測結果")}
    >
      <div className="circuit-meter-readout__primary" data-measurement={kind === "ammeter" ? "current" : "voltage"}>
        <span className="circuit-meter-readout__quantity">{quantity}</span>
        <strong className="circuit-meter-readout__value">{display.text}</strong>
      </div>
      {display.phaseText && <p className="circuit-meter-readout__phase">{display.phaseText}</p>}
      <p className="circuit-meter-readout__note">{display.note}</p>
    </section>
  );
}
