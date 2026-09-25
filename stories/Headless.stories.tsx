import { useState } from "react";
import { createPortal } from "react-dom";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CircuitAnalysisPanel } from "../src/ui/CircuitAnalysisPanel.js";
import { CircuitBoard } from "../src/ui/CircuitBoard.js";
import { CircuitEditor } from "../src/ui/CircuitEditor.js";
import { CircuitInspector } from "../src/ui/CircuitInspector.js";
import { CircuitPalette } from "../src/ui/CircuitPalette.js";
import { createExampleCircuit, type CircuitEndpoint } from "../src/circuit-model.js";
import "./headless-story.css";

const meta = {
  title: "Circuit/Headless",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function HeadlessWorkbench() {
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  const [lastChange, setLastChange] = useState("初期状態");

  return (
    <CircuitEditor initialDocument={createExampleCircuit()} onDocumentChange={() => setLastChange(new Date().toLocaleTimeString())}>
      {(editor) => {
        const part = editor.document.parts.find((item) => item.id === editor.selection.parts[0]);
        const wire = editor.document.wires.find((item) => item.id === editor.selection.wires[0]);
        const endpointLabel = (endpoint: CircuitEndpoint) => {
          const item = editor.document.parts.find((candidate) => candidate.id === endpoint.partId);
          return `${item?.label || item?.id || "部品"}の${endpoint.terminal === "a" ? "端子A" : "端子B"}`;
        };
        const wireEndpoints = wire ? { from: endpointLabel(wire.from), to: endpointLabel(wire.to) } : undefined;

        return (
          <main className="headless-workbench">
            <header className="headless-workbench__header">
              <div>
                <p className="headless-workbench__eyebrow">CUSTOM CIRCUIT WORKSPACE</p>
                <h1>{editor.document.title}</h1>
              </div>
              <div className="headless-workbench__actions">
                <button type="button" onClick={editor.undo} disabled={!editor.canUndo}>Undo</button>
                <button type="button" onClick={editor.redo} disabled={!editor.canRedo}>Redo</button>
                <div className="headless-workbench__controls-host" ref={setControlsHost} />
              </div>
            </header>

            <div className="headless-workbench__layout">
              <aside className="headless-workbench__palette-column" aria-label="部品">
                <CircuitPalette
                  className="headless-workbench__palette"
                  onAdd={editor.add}
                  slotProps={{
                    searchInput: { className: "headless-workbench__search" },
                    partItem: { className: "headless-workbench__part-choice" },
                    partIcon: { className: "headless-workbench__part-icon" },
                  }}
                />
                <p className="headless-workbench__hint">端子をドラッグ／順にクリックして配線。導線をクリックすると分岐し、選択した導線は区間をドラッグ／矢印キーで経路を調整したり、両端の丸をドラッグするか端のハンドルから端子をクリックしてつなぎ替えたりできます。端子に吸着し、Escで中断、Undoで戻せます。</p>
              </aside>

              <section className="headless-workbench__canvas-column" aria-label="回路図">
                <CircuitBoard
                  className="headless-workbench__board"
                  document={editor.document}
                  selection={editor.selection}
                  pendingEndpoint={editor.pendingEndpoint}
                  pendingWire={editor.pendingWire}
                  analysis={editor.analysis}
                  onSelectPart={editor.selectPart}
                  onSelectWire={editor.selectWire}
                  onTerminalClick={editor.chooseTerminal}
                  onConnectionStart={editor.startConnection}
                  onReconnectStart={editor.startReconnect}
                  onConnectionCancel={editor.cancelConnection}
                  onBoardClick={editor.choosePoint}
                  onMovePart={editor.movePart}
                  onMoveEnd={editor.endEdit}
                  onMoveCancel={editor.cancelMove}
                  onWireRouteChange={editor.updateWireRoute}
                  onWireRouteCancel={editor.cancelWireRoute}
                  onWireRouteEnd={editor.endEdit}
                  slotProps={{
                    viewport: { style: { height: 460 } },
                    surface: { className: "headless-workbench__surface" },
                    background: { className: "headless-workbench__background" },
                    connectionPreview: { className: "headless-workbench__connection-preview" },
                    connectionTarget: { className: "headless-workbench__connection-target" },
                    selectionRect: { className: "headless-workbench__selection-rect" },
                    wireHit: { className: "headless-workbench__wire-hit" },
                    wireLine: { className: "headless-workbench__wire-line" },
                    wireHandle: { className: "headless-workbench__wire-handle" },
                    wireHandleHit: { className: "headless-workbench__wire-handle-hit" },
                    wireHandleDot: { className: "headless-workbench__wire-handle-dot" },
                    wireSegmentHandle: { className: "headless-workbench__wire-segment-handle" },
                    wireSegmentHit: { className: "headless-workbench__wire-segment-hit" },
                    wireSegmentDot: { className: "headless-workbench__wire-segment-dot" },
                    partHit: { className: "headless-workbench__part-hit" },
                    selectionHalo: { className: "headless-workbench__selection-halo" },
                    partLabel: { className: "headless-workbench__part-label" },
                    partDetail: { className: "headless-workbench__part-detail" },
                    symbol: { className: "headless-workbench__symbol" },
                    partLeads: { className: "headless-workbench__part-leads" },
                    terminalHit: { className: "headless-workbench__terminal-hit" },
                    terminalDot: { className: "headless-workbench__terminal-dot" },
                    terminalRing: { className: "headless-workbench__terminal-ring" },
                    terminalLabel: { className: "headless-workbench__terminal-label" },
                    paper: { className: "headless-workbench__paper" },
                    minorGrid: { className: "headless-workbench__minor-grid" },
                    grid: { className: "headless-workbench__grid" },
                  }}
                  renderControls={(controls) => controlsHost ? createPortal(
                    <nav className="headless-workbench__board-controls" aria-label="基板の表示操作">
                      <button type="button" onClick={controls.zoomOut} disabled={!controls.canZoomOut} aria-label="縮小">−</button>
                      <output>{Math.round(controls.zoom * 100)}%</output>
                      <button type="button" onClick={controls.zoomIn} disabled={!controls.canZoomIn} aria-label="拡大">＋</button>
                      <button type="button" onClick={controls.resetZoom}>100%</button>
                      <button type="button" onClick={controls.fit}>全体表示</button>
                      <button type="button" aria-pressed={controls.showGrid} onClick={() => controls.setShowGrid(!controls.showGrid)}>格子</button>
                    </nav>,
                    controlsHost,
                  ) : null}
                />
                {editor.pendingEndpoint && <p className="headless-workbench__connection" role="status">{editor.pendingWire ? `${editor.pendingWire.end === "from" ? "始点" : "終点"}の接続先を選んでください。Escで中断できます。` : "端子をドラッグするか、接続先を順にクリックしてください。空白を選ぶと接続点を追加します。導線をクリックすると分岐できます。"}</p>}
                {editor.error && <p className="headless-workbench__error" role="alert">{editor.error}</p>}
              </section>

              <aside className="headless-workbench__details" aria-label="部品情報">
                <CircuitInspector
                  className="headless-workbench__inspector"
                  part={part}
                  wire={wire}
                  wireEndpoints={wireEndpoints}
                  reading={part ? editor.analysis.parts[part.id] : undefined}
                  onChange={editor.updatePart}
                  onRotate={editor.rotateSelected}
                  onDelete={editor.removeSelected}
                  onReconnect={wire ? (end) => editor.startReconnect(wire.id, end) : undefined}
                  onResetWireRoute={wire ? () => editor.resetWireRoute(wire.id) : undefined}
                  onBlur={editor.endEdit}
                  slotProps={{
                    fields: { className: "headless-workbench__fields" },
                    wireReconnectActions: { className: "headless-workbench__wire-reconnect" },
                    wireFromReconnectButton: { className: "headless-workbench__wire-reconnect-button" },
                    wireToReconnectButton: { className: "headless-workbench__wire-reconnect-button" },
                    wireReconnectHint: { className: "headless-workbench__wire-reconnect-hint" },
                    wireRouteResetButton: { className: "headless-workbench__wire-route-reset-button" },
                  }}
                />
                <CircuitAnalysisPanel
                  className="headless-workbench__analysis"
                  analysis={editor.analysis}
                  partCount={editor.document.parts.length}
                  wireCount={editor.document.wires.length}
                />
              </aside>
            </div>

            <footer className="headless-workbench__footer">
              <span>部品 {editor.document.parts.length} · 導線 {editor.document.wires.length}</span>
              <span>最終変更 {lastChange}</span>
            </footer>
          </main>
        );
      }}
    </CircuitEditor>
  );
}

export const CustomWorkbench: Story = {
  name: "独自 CSS と任意配置",
  render: () => <HeadlessWorkbench />,
};
