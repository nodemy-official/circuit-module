import { useId, useState } from "react";
import type { CircuitAnalysis } from "../circuit-solver.js";
import type { CircuitDocument, CircuitPart } from "../circuit-model.js";

type ComparisonMetric = "voltageVolts" | "currentAmps" | "powerWatts";
interface Snapshot {
  document: CircuitDocument;
  analysis: CircuitAnalysis;
}
type BaselineOverride = Snapshot | null | undefined;

export interface CircuitComparisonPanelProps {
  document: CircuitDocument;
  analysis: CircuitAnalysis;
  baselineDocument?: CircuitDocument;
  baselineAnalysis?: CircuitAnalysis;
}

const metrics: Array<{ key: ComparisonMetric; label: string; unit: string }> = [
  { key: "voltageVolts", label: "電圧", unit: "V" },
  { key: "currentAmps", label: "電流", unit: "A" },
  { key: "powerWatts", label: "電力", unit: "W" },
];

const sourceKinds = new Set<CircuitPart["kind"]>(["battery", "ac-source", "current-source"]);

function cloneDocument(document: CircuitDocument): CircuitDocument {
  return {
    ...document,
    parts: document.parts.map((part) => ({ ...part })),
    wires: document.wires.map((wire) => ({
      ...wire,
      from: { ...wire.from },
      to: { ...wire.to },
      waypoints: wire.waypoints?.map((point) => ({ ...point })),
    })),
  };
}

function cloneAnalysis(analysis: CircuitAnalysis): CircuitAnalysis {
  return {
    ...analysis,
    bulbPowerWatts: { ...analysis.bulbPowerWatts },
    parts: Object.fromEntries(Object.entries(analysis.parts).map(([id, reading]) => [id, {
      ...reading,
      terminalVoltages: reading.terminalVoltages ? { ...reading.terminalVoltages } : undefined,
      terminalCurrents: reading.terminalCurrents ? { ...reading.terminalCurrents } : undefined,
    }])),
    wireCurrents: { ...analysis.wireCurrents },
    issues: analysis.issues.map((issue) => ({ ...issue })),
  };
}

function snapshot(document: CircuitDocument, analysis: CircuitAnalysis): Snapshot {
  return { document: cloneDocument(document), analysis: cloneAnalysis(analysis) };
}

function isFiniteValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function measurement(analysis: CircuitAnalysis | undefined, partId: string, metric: ComparisonMetric): number | undefined {
  const value = analysis?.parts[partId]?.[metric];
  return isFiniteValue(value) ? value : undefined;
}

function isInstantAnalysis(analysis: CircuitAnalysis): boolean {
  const timeSeconds = (analysis as CircuitAnalysis & { timeSeconds?: number }).timeSeconds;
  return isFiniteValue(timeSeconds);
}

function analysisMode(analysis: CircuitAnalysis): "dc" | "ac" {
  return analysis.mode ?? "dc";
}

function analysisFrequency(document: CircuitDocument, analysis: CircuitAnalysis): number {
  if (isFiniteValue(analysis.frequencyHz)) { return analysis.frequencyHz; }
  const sourceFrequency = document.parts.find((part) => part.kind === "ac-source")?.frequencyHz;
  return isFiniteValue(sourceFrequency) ? sourceFrequency : 1000;
}

function readingsUnavailable(analysis: CircuitAnalysis): boolean {
  return analysis.status === "invalid" || analysis.status === "short" || analysis.status === "empty";
}

function statusDescription(status: CircuitAnalysis["status"]): string {
  switch (status) {
    case "invalid": return "無効";
    case "short": return "短絡";
    case "empty": return "空の回路";
    default: return status;
  }
}

function incompatibilityReason(before: Snapshot, after: Snapshot): string | undefined {
  if (readingsUnavailable(before.analysis)) {
    return `基準側の解析状態が「${statusDescription(before.analysis.status)}」のため、測定値を比較できません。`;
  }
  if (readingsUnavailable(after.analysis)) {
    return `現在の解析状態が「${statusDescription(after.analysis.status)}」のため、測定値を比較できません。`;
  }
  if (isInstantAnalysis(before.analysis) || isInstantAnalysis(after.analysis)) {
    return "瞬時値と定常解析は比較できません。定常解析の結果を指定してください。";
  }
  const beforeMode = analysisMode(before.analysis);
  const afterMode = analysisMode(after.analysis);
  if (beforeMode !== afterMode) {
    return "直流と交流の解析条件が異なるため、差分を表示できません。";
  }
  if (beforeMode === "ac" && analysisFrequency(before.document, before.analysis) !== analysisFrequency(after.document, after.analysis)) {
    return "交流の周波数が異なるため、差分を表示できません。";
  }
  return undefined;
}

function formatNumber(value: number | undefined, signed = false): string {
  if (value === undefined || !Number.isFinite(value)) { return "—"; }
  const rounded = Number(value.toPrecision(4));
  if (rounded === 0) { return "0"; }
  return `${signed && rounded > 0 ? "+" : ""}${rounded}`;
}

function partLabel(part: CircuitPart | undefined): string {
  return part ? `${part.label}（${part.id}）` : "部品";
}

function comparisonRows(baseline: Snapshot, current: Snapshot, canCompare: boolean, metric: ComparisonMetric) {
  const beforeById = new Map(baseline.document.parts.map((part) => [part.id, part]));
  const afterById = new Map(current.document.parts.map((part) => [part.id, part]));
  const ids = [
    ...current.document.parts.map((part) => part.id),
    ...baseline.document.parts.map((part) => part.id).filter((id) => !afterById.has(id)),
  ];
  const rows = ids.map((id) => {
    const beforePart = beforeById.get(id);
    const afterPart = afterById.get(id);
    const status = !beforePart ? "added" : !afterPart ? "removed" : beforePart.kind !== afterPart.kind ? "kind-changed" : "matched";
    const sameKind = status === "matched";
    const beforeValues = Object.fromEntries(metrics.map(({ key }) => [
      key,
      beforePart && !readingsUnavailable(baseline.analysis) ? measurement(baseline.analysis, id, key) : undefined,
    ])) as Record<ComparisonMetric, number | undefined>;
    const afterValues = Object.fromEntries(metrics.map(({ key }) => [
      key,
      afterPart && !readingsUnavailable(current.analysis) ? measurement(current.analysis, id, key) : undefined,
    ])) as Record<ComparisonMetric, number | undefined>;
    const deltas = Object.fromEntries(metrics.map(({ key }) => {
      const before = beforeValues[key];
      const after = afterValues[key];
      const delta = before !== undefined && after !== undefined ? after - before : undefined;
      return [key, canCompare && sameKind && isFiniteValue(delta) ? delta : undefined];
    })) as Record<ComparisonMetric, number | undefined>;
    const changed = canCompare && sameKind && metrics.some(({ key }) => deltas[key] !== undefined && deltas[key] !== 0);
    return { id, beforePart, afterPart, status, sameKind, beforeValues, afterValues, deltas, changed };
  });
  const maxAbsDelta = Math.max(0, ...rows.map((row) => Math.abs(row.deltas[metric] ?? 0)));
  return { rows, maxAbsDelta };
}

function baselineLabel(baseline: Snapshot): string {
  const mode = analysisMode(baseline.analysis);
  if (mode === "ac") {
    return `${baseline.document.title}・交流 ${formatNumber(analysisFrequency(baseline.document, baseline.analysis))} Hz`;
  }
  return `${baseline.document.title}・直流`;
}

function powerSignLabel(beforePart: CircuitPart | undefined, afterPart: CircuitPart | undefined): string {
  const beforeRole = beforePart && sourceKinds.has(beforePart.kind) ? "供給（＋）" : beforePart ? "吸収（＋）" : undefined;
  const afterRole = afterPart && sourceKinds.has(afterPart.kind) ? "供給（＋）" : afterPart ? "吸収（＋）" : undefined;
  if (beforeRole && afterRole && beforeRole !== afterRole) {
    return `基準: ${beforeRole} / 現在: ${afterRole}`;
  }
  if (afterRole) { return afterRole; }
  if (beforeRole) { return `基準側: ${beforeRole}`; }
  return "—";
}

function partStatusLabel(status: string): string {
  switch (status) {
    case "added": return "追加";
    case "removed": return "削除";
    case "kind-changed": return "部品の種類が変更";
    default: return "";
  }
}

function partDisplayLabel(beforePart: CircuitPart | undefined, afterPart: CircuitPart | undefined, id: string): string {
  if (beforePart && afterPart && beforePart.label !== afterPart.label) {
    return `${beforePart.label} → ${afterPart.label}（${id}）`;
  }
  return partLabel(afterPart ?? beforePart);
}

function comparisonDeltaLabel(row: ReturnType<typeof comparisonRows>["rows"][number], reason: string | undefined, metric: ComparisonMetric): string {
  if (row.status !== "matched") { return "差分対象外"; }
  if (reason) { return "比較不可"; }
  return formatNumber(row.deltas[metric], true);
}

function ComparisonRow({
  row,
  metric,
  reason,
  canCompare,
  maxAbsDelta,
}: {
  row: ReturnType<typeof comparisonRows>["rows"][number];
  metric: ComparisonMetric;
  reason?: string;
  canCompare: boolean;
  maxAbsDelta: number;
}) {
  const delta = row.deltas[metric];
  const deltaPercent = delta === undefined || maxAbsDelta === 0 ? 0 : Math.abs(delta) / maxAbsDelta * 50;
  const statusLabel = partStatusLabel(row.status);
  return (
    <tr data-part-id={row.id} data-row-status={row.status} data-changed={row.changed}>
      <th scope="row">
        <span>{partDisplayLabel(row.beforePart, row.afterPart, row.id)}</span>
        {statusLabel && <small>{statusLabel}</small>}
        {row.changed && <small className="circuit-comparison__changed">計測値に変化</small>}
      </th>
      <td>{formatNumber(row.beforeValues[metric])}</td>
      <td>{formatNumber(row.afterValues[metric])}</td>
      <td>
        <span className="circuit-comparison__delta-value">{comparisonDeltaLabel(row, reason, metric)}</span>
        {delta !== undefined && canCompare && (
          <span className="circuit-comparison__bar" aria-hidden="true" data-direction={delta < 0 ? "decrease" : delta > 0 ? "increase" : "unchanged"}>
            <span className="circuit-comparison__bar-center" />
            <span
              className="circuit-comparison__bar-fill"
              style={{ width: `${deltaPercent}%` }}
              data-bar-percent={deltaPercent}
            />
          </span>
        )}
      </td>
      {metric === "powerWatts" && <td>{powerSignLabel(row.beforePart, row.afterPart)}</td>}
    </tr>
  );
}

function ComparisonTable({
  rows,
  metric,
  reason,
  canCompare,
  maxAbsDelta,
}: {
  rows: ReturnType<typeof comparisonRows>["rows"];
  metric: ComparisonMetric;
  reason?: string;
  canCompare: boolean;
  maxAbsDelta: number;
}) {
  return (
    <div className="circuit-comparison__table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">部品</th>
            <th scope="col">基準</th>
            <th scope="col">現在</th>
            <th scope="col">差分（現在 − 基準）</th>
            {metric === "powerWatts" && <th scope="col">符号</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <ComparisonRow
              key={row.id}
              row={row}
              metric={metric}
              reason={reason}
              canCompare={canCompare}
              maxAbsDelta={maxAbsDelta}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Compares steady-state readings against a supplied baseline or a local snapshot. */
export function CircuitComparisonPanel({
  document,
  analysis,
  baselineDocument,
  baselineAnalysis,
}: CircuitComparisonPanelProps) {
  const id = useId();
  const [baselineOverride, setBaselineOverride] = useState<BaselineOverride>(undefined);
  const externalBaseline = baselineDocument && baselineAnalysis
    ? { document: baselineDocument, analysis: baselineAnalysis }
    : undefined;
  const baseline = baselineOverride === undefined ? externalBaseline : baselineOverride ?? undefined;
  const current = { document, analysis };
  const currentMode = analysisMode(analysis);
  const instant = isInstantAnalysis(analysis);
  const [selectedMetric, setSelectedMetric] = useState<ComparisonMetric>("voltageVolts");
  const reason = baseline ? incompatibilityReason(baseline, current) : undefined;
  const canCompare = Boolean(baseline) && !reason;
  const { rows, maxAbsDelta } = baseline
    ? comparisonRows(baseline, current, canCompare, selectedMetric)
    : { rows: [], maxAbsDelta: 0 };

  return (
    <details className="circuit-comparison" data-comparison-state={!baseline ? "no-baseline" : reason ? "unavailable" : "ready"}>
      <summary>部品値変更の影響を比較</summary>
      <div className="circuit-comparison__content">
        {!baseline ? (
          <div className="circuit-comparison__empty">
            <p>変更前の回路と解析を基準として保存すると、部品ごとの差分を表示できます。</p>
            <button type="button" onClick={() => setBaselineOverride(snapshot(document, analysis))}>
              現在を比較の基準にする
            </button>
          </div>
        ) : (
          <>
            <div className="circuit-comparison__toolbar">
              <p className="circuit-comparison__baseline">基準: {baselineLabel(baseline)}</p>
              <div className="circuit-comparison__actions">
                <button type="button" onClick={() => setBaselineOverride(snapshot(document, analysis))}>
                  基準を現在に更新
                </button>
                <button type="button" onClick={() => setBaselineOverride(null)}>
                  基準を解除
                </button>
              </div>
            </div>
            {reason && <p className="circuit-comparison__notice" role="status">{reason}</p>}
            {!reason && (
              <p className="circuit-comparison__note">
                {currentMode === "ac"
                  ? "交流は電圧・電流を実効値（RMS）、電力を平均電力で表示します。"
                  : "差分は現在の値 − 基準の値です。電圧・電流・電力の読み取り値を比較します。"}
                {instant && " 表示値は瞬時値です。"}
              </p>
            )}
            <fieldset className="circuit-comparison__metric">
              <legend>比較する量</legend>
              {metrics.map(({ key, label, unit }) => (
                <label key={key} htmlFor={`${id}-${key}`}>
                  <input
                    id={`${id}-${key}`}
                    type="radio"
                    name={`${id}-metric`}
                    value={key}
                    checked={selectedMetric === key}
                    onChange={() => setSelectedMetric(key)}
                  />
                  {label}（{instant ? `瞬時値 ${unit}` : key === "powerWatts" && currentMode === "ac" ? `平均電力 ${unit}` : `${unit}${key !== "powerWatts" && currentMode === "ac" ? " RMS" : ""}`}）
                </label>
              ))}
            </fieldset>
            {selectedMetric === "powerWatts" && (
              <p className="circuit-comparison__power-note">符号の意味: 電源は供給（＋）、その他の部品は吸収（＋）です。</p>
            )}
            {rows.length === 0 ? (
              <p className="circuit-comparison__notice">比較できる部品がありません。</p>
            ) : (
              <ComparisonTable
                rows={rows}
                metric={selectedMetric}
                reason={reason}
                canCompare={canCompare}
                maxAbsDelta={maxAbsDelta}
              />
            )}
          </>
        )}
      </div>
    </details>
  );
}
