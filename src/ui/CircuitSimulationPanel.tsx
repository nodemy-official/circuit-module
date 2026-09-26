import { useCallback, useId, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import type { CircuitDocument } from "../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis, type CircuitAnalysisOptions } from "../circuit-solver.js";
import { analysisAtTransientFrame, type CircuitTransientFrame } from "../circuit-visualization.js";
import { CircuitEnergyPanel } from "./CircuitEnergyPanel.js";
import { CircuitAcPanel } from "./CircuitAcPanel.js";
import { CircuitComparisonPanel } from "./CircuitComparisonPanel.js";
import { CircuitTransientPanel } from "./CircuitTransientPanel.js";
import { Input, NativeSelect } from "./primitives.js";

export interface CircuitSimulationPanelProps extends Omit<ComponentPropsWithoutRef<"section">, "onChange"> {
  document: CircuitDocument;
  analysis: CircuitAnalysis;
  options: CircuitAnalysisOptions;
  onChange: (options: CircuitAnalysisOptions) => void;
  baselineDocument?: CircuitDocument;
  onFrameChange?: (frame: CircuitTransientFrame | null) => void;
  /** Omit learning panels when the host displays them beside the board elsewhere. */
  showLearningPanels?: boolean;
  /** Hide steady-state analysis settings when this panel is used for learning results only. */
  showAnalysisSettings?: boolean;
  /** Pause transient playback while this panel is hidden in another tab. */
  active?: boolean;
}

/** Analysis settings are session state; changing them does not alter the circuit. */
export function CircuitSimulationPanel({
  document,
  analysis,
  options,
  onChange,
  baselineDocument,
  onFrameChange,
  showLearningPanels = true,
  showAnalysisSettings = true,
  active = true,
  className = "",
  ...props
}: CircuitSimulationPanelProps) {
  const id = useId();
  const [frameState, setFrameState] = useState<{ document: CircuitDocument; frame: CircuitTransientFrame | null } | null>(null);
  const frame = frameState?.document === document ? frameState.frame : null;
  const sampledAnalysis = useMemo(() => frame ? analysisAtTransientFrame(document, frame) : null, [document, frame]);
  const baselineAnalysis = useMemo(() => baselineDocument ? analyzeCircuit(baselineDocument, {}, options) : undefined, [baselineDocument, options]);
  const changeFrame = useCallback((next: CircuitTransientFrame | null) => {
    setFrameState({ document, frame: next });
    onFrameChange?.(next);
  }, [document, onFrameChange]);
  const frequency = options.frequencyHz ?? document.parts.find((part) => part.kind === "ac-source")?.frequencyHz ?? 1000;
  const ariaLabel = props["aria-label"] ?? (showAnalysisSettings ? "解析の設定" : "解析結果と学習ビュー");
  return <section {...props} className={`circuit-panel circuit-simulation ${className}`} aria-label={ariaLabel}>
    {showAnalysisSettings && <>
      <div className="circuit-panel__heading"><h2>解析の設定</h2></div>
      <label htmlFor={`${id}-mode`}>定常解析</label>
      <NativeSelect id={`${id}-mode`} value={options.mode ?? "auto"} onChange={(event) => onChange({ ...options, mode: event.target.value as CircuitAnalysisOptions["mode"] })}>
        <option value="auto">自動（電源に合わせる）</option>
        <option value="dc">直流・動作点</option>
        <option value="ac">交流・小信号</option>
      </NativeSelect>
      {analysis.mode === "ac" && <>
        <label htmlFor={`${id}-frequency`}>解析周波数 (Hz)</label>
        <Input id={`${id}-frequency`} type="number" min="0" step="any" value={frequency} onValueChange={(nextValue) => {
          const value = Number(nextValue);
          if (Number.isFinite(value) && value > 0) { onChange({ ...options, mode: "ac", frequencyHz: value }); }
        }} />
        <p>計測値は実効値と位相です。異なる周波数の電源は個別に解析します。半導体は直流動作点まわりの小信号として計算します。</p>
      </>}
      {analysis.mode !== "ac" && <p>コンデンサは開放、コイルは短絡として定常状態を計算します。</p>}
    </>}
    {showLearningPanels && <>
      <CircuitTransientPanel document={document} baselineDocument={baselineDocument} onFrameChange={changeFrame} active={active} defaultOpen={!showAnalysisSettings} />
      {frame && <button className="circuit-button" type="button" onClick={() => changeFrame(null)}>回路図を定常表示に戻す</button>}
      <details className="circuit-learning-section"><summary>電力とエネルギー</summary><CircuitEnergyPanel document={document} analysis={sampledAnalysis ?? analysis} frame={frame} /></details>
      <details className="circuit-learning-section"><summary>交流の位相・周波数応答</summary><CircuitAcPanel document={document} analysis={analysis} options={options} /></details>
      <CircuitComparisonPanel document={document} analysis={analysis} baselineDocument={baselineDocument} baselineAnalysis={baselineAnalysis} />
    </>}
  </section>;
}
