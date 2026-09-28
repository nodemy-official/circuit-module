import type { ComponentPropsWithoutRef } from "react";
import { formatCircuitNumber } from "../number-format.js";
import { formatCircuitQuantity } from "../circuit-visualization.js";
import type { CircuitAnalysis } from "../circuit-solver.js";
import { circuitSlot, type CircuitStyleProps } from "./style-props.js";
import { CircuitIcon } from "./CircuitIcon.js";

export type CircuitAnalysisPanelSlot =
  | "root"
  | "heading"
  | "headingTitle"
  | "state"
  | "stateIcon"
  | "stateLabel"
  | "stateValue"
  | "reason"
  | "metric"
  | "metricLabel"
  | "metricValue"
  | "metricNumber"
  | "metricUnit"
  | "counts"
  | "partCount"
  | "wireCount"
  | "issues"
  | "issue";

export interface CircuitAnalysisPanelProps extends Omit<ComponentPropsWithoutRef<"section">, "children" | "style"> {
  analysis: CircuitAnalysis;
  partCount?: number;
  wireCount?: number;
  showReason?: boolean;
  style?: CircuitStyleProps["style"];
  slotProps?: Partial<Record<CircuitAnalysisPanelSlot, CircuitStyleProps>>;
}

const statusLabel: Record<CircuitAnalysis["status"], string> = {
  empty: "空の回路", idle: "電源なし", open: "開回路", closed: "通電中", short: "短絡", invalid: "要確認",
};

const statusReason: Record<CircuitAnalysis["status"], string> = {
  empty: "部品を置くと回路の解析が始まります。",
  idle: "電源を加えると、回路に流れる電流を計算できます。",
  open: "回路がつながっていないため、電流は流れていません。",
  closed: "電池から回路へ電流が流れています。",
  short: "電池を抵抗や電球を通らずにつなぐ経路があります。",
  invalid: "部品の値や端子の接続を確認してください。",
};

function currentDisplay(value: number | null) {
  if (value === null) { return { value: "—", unit: "A" }; }
  const formatted = formatCircuitQuantity(value, "A");
  const separator = formatted.lastIndexOf(" ");
  return separator < 0
    ? { value: formatted, unit: "A" }
    : { value: formatted.slice(0, separator), unit: formatted.slice(separator + 1) };
}

/** Read-only simulation summary; analysis can also be used without any UI. */
export function CircuitAnalysisPanel({
  analysis,
  partCount,
  wireCount,
  showReason = true,
  className,
  style,
  slotProps,
  "aria-label": ariaLabel,
  ...sectionProps
}: CircuitAnalysisPanelProps) {
  const displayedCurrent = currentDisplay(analysis.currentAmps);
  const rootProps = circuitSlot("circuit-panel circuit-analysis", {
    className: [className, slotProps?.root?.className].filter(Boolean).join(" "),
    style: style || slotProps?.root?.style ? { ...style, ...slotProps?.root?.style } : undefined,
  });

  return (
    <section {...sectionProps} {...rootProps} aria-label={ariaLabel ?? "回路解析"} data-status={analysis.status}>
      <div {...circuitSlot("circuit-panel__heading", slotProps?.heading)}>
        <h2 {...circuitSlot(undefined, slotProps?.headingTitle)}>解析</h2>
      </div>
      <div {...circuitSlot(`circuit-analysis__state circuit-analysis__state--${analysis.status}`, slotProps?.state)} role="status" aria-live="polite" aria-atomic="true" data-status={analysis.status}>
        {analysis.status === "closed" && <CircuitIcon name="check" {...circuitSlot(undefined, slotProps?.stateIcon)} />}
        <span {...circuitSlot("circuit-analysis__state-label", slotProps?.stateLabel)}>状態</span>
        <strong {...circuitSlot(undefined, slotProps?.stateValue)}>{analysis.mode && analysis.status === "closed" ? "解析完了" : statusLabel[analysis.status]}</strong>
      </div>
      {analysis.mode === "ac" && <p className="circuit-analysis__mode">交流 {analysis.frequencyHz} Hz · 電圧・電流は実効値</p>}
      {analysis.timeSeconds !== undefined && <p className="circuit-analysis__mode">過渡 {formatCircuitNumber(analysis.timeSeconds)} s · 瞬時値</p>}
      {showReason && <p {...circuitSlot("circuit-analysis__reason", slotProps?.reason)}>{analysis.mode ? analysis.message : statusReason[analysis.status]}</p>}
      <div {...circuitSlot("circuit-analysis__metric", slotProps?.metric)}>
        <span {...circuitSlot(undefined, slotProps?.metricLabel)}>{analysis.mode === "ac" ? "電源電流（実効値）" : analysis.mode ? "電源電流" : "電流"}</span>
        <strong {...circuitSlot(undefined, slotProps?.metricValue)}><span {...circuitSlot(undefined, slotProps?.metricNumber)}>{displayedCurrent.value}</span><small {...circuitSlot(undefined, slotProps?.metricUnit)}>{displayedCurrent.unit}</small></strong>
      </div>
      {(partCount !== undefined || wireCount !== undefined) && (
        <div {...circuitSlot("circuit-analysis__counts", slotProps?.counts)} role="group" aria-label="回路の構成">
          <span {...circuitSlot(undefined, slotProps?.partCount)} data-count="parts"><strong>{partCount ?? "—"}</strong>部品</span>
          <span {...circuitSlot(undefined, slotProps?.wireCount)} data-count="wires"><strong>{wireCount ?? "—"}</strong>導線</span>
        </div>
      )}
      {analysis.issues.length > 0 && <ul {...circuitSlot("circuit-analysis__issues", slotProps?.issues)}>{analysis.issues.map((issue, index) => (
        <li {...circuitSlot(`circuit-analysis__issue--${issue.severity}`, slotProps?.issue)} key={`${issue.partId ?? "circuit"}-${index}`} data-severity={issue.severity}>{issue.message}</li>
      ))}</ul>}
    </section>
  );
}
