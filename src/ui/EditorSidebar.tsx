import { useRef } from "react";
import type { CircuitPart } from "../circuit-model.js";
import { endpointName } from "../circuit-model.js";
import type { CircuitAnalysis } from "../circuit-solver.js";
import { formatCircuitQuantity, type CircuitTransientFrame } from "../circuit-visualization.js";
import { CircuitAnalysisPanel, type CircuitAnalysisPanelProps } from "./CircuitAnalysisPanel.js";
import { CircuitDiagnosticsPanel } from "./CircuitDiagnosticsPanel.js";
import { CircuitIcon } from "./CircuitIcon.js";
import { CircuitInspector, type CircuitInspectorProps } from "./CircuitInspector.js";
import { CircuitPartIcon } from "./CircuitPalette.js";
import { CircuitSimulationPanel } from "./CircuitSimulationPanel.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./primitives.js";
import type { CircuitEditorController } from "./useCircuitEditor.js";

export type EditorSidebarTab = "properties" | "analysis" | "waveforms";

const analysisLabels: Record<CircuitAnalysis["status"], string> = {
  empty: "空の回路", idle: "電源なし", open: "開回路", closed: "通電中", short: "短絡", invalid: "要確認",
};

export function EditorAnalysisStatus({ analysis, diagnosticCount, onOpen }: {
  analysis: CircuitAnalysis;
  diagnosticCount: number;
  onOpen: () => void;
}) {
  const label = analysis.mode && analysis.status === "closed" ? "解析完了" : analysisLabels[analysis.status];
  return <button type="button" className="circuit-editor__analysis-status" data-status={analysis.status} onClick={onOpen} aria-label={`解析を表示: ${label}${diagnosticCount ? `、確認 ${diagnosticCount} 件` : ""}`} title="解析結果と接続チェックを表示">
    <span className="circuit-editor__status-dot" aria-hidden="true" />
    <span role="status">{label}</span>
    {analysis.currentAmps !== null && <strong>{formatCircuitQuantity(analysis.currentAmps, "A")}</strong>}
    {diagnosticCount > 0 && <span className="circuit-editor__status-issues">確認 {diagnosticCount}</span>}
    <CircuitIcon name="arrowRight" size={13} />
  </button>;
}

function EditorProperties({ editor, part, wire, analysis, inspectorProps }: {
  editor: CircuitEditorController;
  part: CircuitPart | undefined;
  wire: CircuitEditorController["document"]["wires"][number] | undefined;
  analysis: CircuitAnalysis;
  inspectorProps?: Partial<CircuitInspectorProps>;
}) {
  const multipleSelected = editor.selection.parts.length + editor.selection.wires.length > 1;
  const endpointLabel = (endpoint: NonNullable<typeof wire>["from"]) => {
    const endpointPart = editor.document.parts.find((item) => item.id === endpoint.partId);
    return endpointPart ? endpointName(endpointPart, endpoint.terminal) : "接続先なし";
  };
  return <>
    {multipleSelected ? <section className="circuit-editor__multi-selection" aria-label="複数選択">
      <h2>複数選択</h2><p>部品 {editor.selection.parts.length} 個・導線 {editor.selection.wires.length} 本</p>
      <p>ドラッグでまとめて移動できます。Shiftを押しながらクリックすると選択を切り替えます。</p>
      <button type="button" className="circuit-button" onClick={editor.clearSelection}>選択を解除</button>
    </section> : <CircuitInspector
      part={part}
      wire={wire}
      wireLabel={wire ? `${endpointLabel(wire.from)} → ${endpointLabel(wire.to)}` : undefined}
      wireEndpoints={wire ? { from: endpointLabel(wire.from), to: endpointLabel(wire.to) } : undefined}
      onReconnect={wire ? (end) => editor.startReconnect(wire.id, end) : undefined}
      onResetWireRoute={wire ? () => editor.resetWireRoute(wire.id) : undefined}
      onChange={editor.updatePart}
      onRotate={editor.rotateSelected}
      onDelete={editor.removeSelected}
      {...inspectorProps}
      reading={part ? analysis.parts[part.id] : undefined}
      readingTimeSeconds={analysis.timeSeconds}
      analysisStatus={analysis.status}
    />}
    {editor.document.parts.length > 0 && <section className="circuit-editor__outline" aria-label="回路内の部品">
      <h2>回路内の部品<span>{editor.document.parts.length}</span></h2>
      <div>{editor.document.parts.map((item) => <button type="button" key={item.id} aria-pressed={editor.selection.parts.includes(item.id)} onClick={() => editor.selectPart(item.id)}>
        <CircuitPartIcon kind={item.kind} /><span>{item.label}</span><CircuitIcon name="chevron" size={14} />
      </button>)}</div>
    </section>}
  </>;
}

export function EditorSidebar({ id, editor, tab, onTabChange, onClose, inspectorProps, analysisProps, sampledAnalysis, onFrameChange }: {
  id: string;
  editor: CircuitEditorController;
  tab: EditorSidebarTab;
  onTabChange: (tab: EditorSidebarTab) => void;
  onClose: () => void;
  inspectorProps?: Partial<CircuitInspectorProps>;
  analysisProps?: Partial<CircuitAnalysisPanelProps>;
  sampledAnalysis: CircuitAnalysis | null;
  onFrameChange: (frame: CircuitTransientFrame | null) => void;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const part = editor.document.parts.find((item) => item.id === editor.selection.parts[0]);
  const wire = editor.document.wires.find((item) => item.id === editor.selection.wires[0]);
  const selected = editor.selection.parts.length + editor.selection.wires.length > 0;
  const analysis = sampledAnalysis ?? editor.analysis;
  return <aside className="circuit-editor__right" id={`${id}-properties`} aria-label="回路の詳細">
    <div className="circuit-editor__sidebar-heading">
      <h2>回路の詳細</h2>
      <button type="button" className="circuit-editor__panel-close circuit-icon-button" aria-label="詳細パネルを閉じる" onClick={onClose}><CircuitIcon name="close" /></button>
    </div>
    <Tabs ref={tabsRef} className="circuit-editor__sidebar-tabs" value={tab} onValueChange={(value) => {
      if (value === "properties" || value === "analysis" || value === "waveforms") { onTabChange(value); }
    }}>
      <TabsList className="circuit-editor__sidebar-tab-list" aria-label="詳細パネル">
        <TabsTrigger value="properties" data-sidebar-tab="properties" className="circuit-editor__sidebar-tab"><CircuitIcon name="sliders" size={16} />プロパティ{selected && <span className="circuit-editor__tab-selection" aria-hidden="true" />}</TabsTrigger>
        <TabsTrigger value="analysis" data-sidebar-tab="analysis" className="circuit-editor__sidebar-tab"><CircuitIcon name="activity" size={16} />解析{editor.diagnostics.length > 0 && <span className="circuit-editor__tab-count" aria-hidden="true" title={`接続チェック ${editor.diagnostics.length} 件`}>{editor.diagnostics.length}</span>}</TabsTrigger>
        <TabsTrigger value="waveforms" data-sidebar-tab="waveforms" className="circuit-editor__sidebar-tab"><CircuitIcon name="waveform" size={16} />波形</TabsTrigger>
      </TabsList>
      <TabsContent value="properties" className="circuit-editor__sidebar-content">
        <EditorProperties editor={editor} part={part} wire={wire} analysis={analysis} inspectorProps={inspectorProps} />
      </TabsContent>
      <TabsContent value="analysis" className="circuit-editor__sidebar-content">
        <CircuitAnalysisPanel analysis={analysis} partCount={editor.document.parts.length} wireCount={editor.document.wires.length} {...analysisProps} />
        <CircuitSimulationPanel document={editor.document} analysis={editor.analysis} options={editor.analysisOptions} onChange={editor.setAnalysisOptions} showLearningPanels={false} />
        <CircuitDiagnosticsPanel diagnostics={editor.diagnostics} onSelect={(selection) => {
          editor.selectRange(selection);
          onTabChange("properties");
          requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLElement>('[data-sidebar-tab="properties"]')?.focus({ preventScroll: true }));
        }} />
      </TabsContent>
      <TabsContent value="waveforms" className="circuit-editor__sidebar-content">
        <div className="circuit-editor__sidebar-intro"><h2>波形と学習</h2><p>時間による変化や、部品ごとの応答を調べます。</p></div>
        <CircuitSimulationPanel document={editor.document} analysis={editor.analysis} options={editor.analysisOptions} onChange={editor.setAnalysisOptions} onFrameChange={onFrameChange} showAnalysisSettings={false} active={tab === "waveforms"} />
      </TabsContent>
    </Tabs>
  </aside>;
}
