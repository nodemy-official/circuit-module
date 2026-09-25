import type { CircuitAnalysis } from "../circuit-solver.js";
import { CircuitIcon } from "./CircuitIcon.js";
import "./editor.css";

export interface CircuitAnalysisPanelProps {
  analysis: CircuitAnalysis;
  partCount?: number;
  wireCount?: number;
  className?: string;
}

const statusLabel: Record<CircuitAnalysis["status"], string> = {
  empty: "空の回路", idle: "電源なし", open: "開回路", closed: "通電中", short: "短絡", invalid: "要確認",
};

const statusReason: Record<CircuitAnalysis["status"], string> = {
  empty: "部品を置くと回路の解析が始まります。",
  idle: "電池を加えると、回路に流れる電流を計算できます。",
  open: "回路がつながっていないため、電流は流れていません。",
  closed: "電池から回路へ電流が流れています。",
  short: "電池を抵抗や電球を通らずにつなぐ経路があります。",
  invalid: "部品の値や端子の接続を確認してください。",
};

/** Read-only simulation summary; analysis can also be used without any UI. */
export function CircuitAnalysisPanel({ analysis, partCount, wireCount, className = "" }: CircuitAnalysisPanelProps) {
  return (
    <section className={`circuit-panel circuit-analysis ${className}`} aria-label="回路解析">
      <div className="circuit-panel__heading"><h2>解析</h2></div>
      <div className={`circuit-analysis__state circuit-analysis__state--${analysis.status}`} role="status" aria-live="polite" aria-atomic="true">
        {analysis.status === "closed" && <CircuitIcon name="check" />}
        <span className="circuit-analysis__state-label">状態</span>
        <strong>{statusLabel[analysis.status]}</strong>
      </div>
      <p className="circuit-analysis__reason">{statusReason[analysis.status]}</p>
      <div className="circuit-analysis__metric">
        <span>電流</span>
        <strong><span>{analysis.currentAmps === null ? "—" : analysis.currentAmps.toFixed(3)}</span><small>A</small></strong>
      </div>
      {(partCount !== undefined || wireCount !== undefined) && (
        <div className="circuit-analysis__counts" aria-label="回路の構成">
          <span><strong>{partCount ?? "—"}</strong>部品</span>
          <span><strong>{wireCount ?? "—"}</strong>導線</span>
        </div>
      )}
      {analysis.issues.length > 0 && <ul className="circuit-analysis__issues">{analysis.issues.map((issue, index) => <li key={`${issue.partId ?? "circuit"}-${index}`} className={`circuit-analysis__issue--${issue.severity}`}>{issue.message}</li>)}</ul>}
    </section>
  );
}
