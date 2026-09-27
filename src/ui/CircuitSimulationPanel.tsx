import { useCallback, useId, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import type { CircuitDocument } from "../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis, type CircuitAnalysisOptions } from "../circuit-solver.js";
import { analysisAtTransientFrame, type CircuitTransientFrame } from "../circuit-visualization.js";
import { CircuitEnergyPanel } from "./CircuitEnergyPanel.js";
import { CircuitAcPanel } from "./CircuitAcPanel.js";
import { CircuitComparisonPanel } from "./CircuitComparisonPanel.js";
import { CircuitTransientPanel } from "./CircuitTransientPanel.js";
import { resolveAcFeature, type CircuitLearningFeatures } from "./preview-features.js";
import { Input, NativeSelect } from "./primitives.js";

export type { CircuitLearningFeatures } from "./preview-features.js";

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
  /** Select which learning panels and AC controls are available. AC defaults to auto. */
  learningFeatures?: CircuitLearningFeatures;
  /** Pause transient playback while this panel is hidden in another tab. */
  active?: boolean;
}

function AnalysisSettings({
  analysis,
  options,
  onChange,
  frequency,
  acAvailable,
}: {
  analysis: CircuitAnalysis;
  options: CircuitAnalysisOptions;
  onChange: (options: CircuitAnalysisOptions) => void;
  frequency: number;
  acAvailable: boolean;
}) {
  const id = useId();
  const acAnalysisSelected = analysis.mode === "ac" || options.mode === "ac";
  return <>
    <div className="circuit-panel__heading"><h2>解析の設定</h2></div>
    {acAvailable || !acAnalysisSelected ? <>
      <label htmlFor={`${id}-mode`}>定常解析</label>
      <NativeSelect id={`${id}-mode`} value={options.mode ?? "auto"} onChange={(event) => onChange({ ...options, mode: event.target.value as CircuitAnalysisOptions["mode"] })}>
        <option value="auto">自動（電源に合わせる）</option>
        <option value="dc">直流・動作点</option>
        {acAvailable && <option value="ac">交流・小信号</option>}
      </NativeSelect>
    </> : <p>定常解析：交流・小信号</p>}
    {analysis.mode === "ac" ? <>
      {acAvailable && <>
        <label htmlFor={`${id}-frequency`}>解析周波数 (Hz)</label>
        <Input id={`${id}-frequency`} type="number" min="0" step="any" value={frequency} onValueChange={(nextValue) => {
          const value = Number(nextValue);
          if (Number.isFinite(value) && value > 0) { onChange({ ...options, mode: "ac", frequencyHz: value }); }
        }} />
      </>}
      <p>{acAvailable
        ? "計測値は実効値と位相です。解析周波数と異なる交流電源は、この結果では0 Vとして扱います。別の周波数を確認するには解析周波数を変更してください。半導体は直流動作点まわりの小信号として計算します。"
        : "交流の計測値は実効値と位相です。"}</p>
    </> : <p>コンデンサは開放、コイルは短絡として定常状態を計算します。</p>}
  </>;
}

function LearningPanels({
  document,
  analysis,
  options,
  baselineDocument,
  baselineAnalysis,
  showTransient,
  showEnergy,
  showAc,
  showComparison,
  showAnalysisSettings,
  active,
  frame,
  sampledAnalysis,
  onFrameChange,
}: {
  document: CircuitDocument;
  analysis: CircuitAnalysis;
  options: CircuitAnalysisOptions;
  baselineDocument?: CircuitDocument;
  baselineAnalysis?: CircuitAnalysis;
  showTransient: boolean;
  showEnergy: boolean;
  showAc: boolean;
  showComparison: boolean;
  showAnalysisSettings: boolean;
  active: boolean;
  frame: CircuitTransientFrame | null;
  sampledAnalysis: CircuitAnalysis | null;
  onFrameChange: (frame: CircuitTransientFrame | null) => void;
}) {
  return <>
    {showTransient && <>
      <CircuitTransientPanel document={document} baselineDocument={baselineDocument} onFrameChange={onFrameChange} active={active} defaultOpen={!showAnalysisSettings} />
      {frame && <button className="circuit-button" type="button" onClick={() => onFrameChange(null)}>回路図を定常表示に戻す</button>}
    </>}
    {showEnergy && <details className="circuit-learning-section"><summary>電力とエネルギー</summary><CircuitEnergyPanel document={document} analysis={sampledAnalysis ?? analysis} frame={frame} /></details>}
    {showAc && <details className="circuit-learning-section"><summary>交流の位相・周波数応答</summary><CircuitAcPanel document={document} analysis={analysis} options={options} /></details>}
    {showComparison && <CircuitComparisonPanel document={document} analysis={analysis} baselineDocument={baselineDocument} baselineAnalysis={baselineAnalysis} />}
  </>;
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
  learningFeatures,
  active = true,
  className = "",
  ...props
}: CircuitSimulationPanelProps) {
  const showTransient = showLearningPanels && (learningFeatures?.transient ?? true);
  const showEnergy = showLearningPanels && (learningFeatures?.energy ?? true);
  const showAc = showLearningPanels && resolveAcFeature(learningFeatures?.ac, document, analysis, options);
  const showComparison = showLearningPanels && (learningFeatures?.comparison ?? true);
  const [frameState, setFrameState] = useState<{ document: CircuitDocument; frame: CircuitTransientFrame | null } | null>(null);
  const frame = showTransient && frameState?.document === document ? frameState.frame : null;
  const sampledAnalysis = useMemo(() => frame ? analysisAtTransientFrame(document, frame) : null, [document, frame]);
  const baselineAnalysis = useMemo(() => baselineDocument && showComparison ? analyzeCircuit(baselineDocument, {}, options) : undefined, [baselineDocument, options, showComparison]);
  const changeFrame = useCallback((next: CircuitTransientFrame | null) => {
    setFrameState({ document, frame: next });
    onFrameChange?.(next);
  }, [document, onFrameChange]);
  const frequency = options.frequencyHz ?? document.parts.find((part) => part.kind === "ac-source")?.frequencyHz ?? 1000;
  const ariaLabel = props["aria-label"] ?? (showAnalysisSettings ? "解析の設定" : "解析結果と学習ビュー");
  if (!showAnalysisSettings && !showTransient && !showEnergy && !showAc && !showComparison) { return null; }
  return <section {...props} className={`circuit-panel circuit-simulation ${className}`} aria-label={ariaLabel}>
    {showAnalysisSettings && <AnalysisSettings analysis={analysis} options={options} onChange={onChange} frequency={frequency} acAvailable={resolveAcFeature(learningFeatures?.ac, document, analysis, options)} />}
    {(showTransient || showEnergy || showAc || showComparison) && <LearningPanels
      document={document}
      analysis={analysis}
      options={options}
      baselineDocument={baselineDocument}
      baselineAnalysis={baselineAnalysis}
      showTransient={showTransient}
      showEnergy={showEnergy}
      showAc={showAc}
      showComparison={showComparison}
      showAnalysisSettings={showAnalysisSettings}
      active={active}
      frame={frame}
      sampledAnalysis={sampledAnalysis}
      onFrameChange={changeFrame}
    />}
  </section>;
}
