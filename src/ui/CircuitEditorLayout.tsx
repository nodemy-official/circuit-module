import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { circuitPartCatalog, circuitPartKinds, endpointName, type CircuitDocument, type CircuitPart, type CircuitPartKind } from "../circuit-model.js";
import type { Point } from "../circuit-geometry.js";
import { circuitExampleCatalog, type CircuitExampleKind } from "../circuit-examples.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { analysisAtTransientFrame, type CircuitTransientFrame } from "../circuit-visualization.js";
import { CircuitAnalysisPanel } from "./CircuitAnalysisPanel.js";
import { CircuitSimulationPanel } from "./CircuitSimulationPanel.js";
import { measurementLabels } from "./measurement-labels.js";
import { CircuitDiagnosticsPanel } from "./CircuitDiagnosticsPanel.js";
import { useCircuitFiles } from "./editor-files.js";
import type { CircuitAnalysisPanelProps } from "./CircuitAnalysisPanel.js";
import { CircuitBoard } from "./CircuitBoard.js";
import type { CircuitBoardProps } from "./CircuitBoard.js";
import { CircuitIcon } from "./CircuitIcon.js";
import { CircuitMeterReadout, getMeterDisplay } from "./CircuitMeterReadout.js";
import { CircuitInspector } from "./CircuitInspector.js";
import type { CircuitInspectorProps } from "./CircuitInspector.js";
import { CircuitPalette, CircuitPartIcon } from "./CircuitPalette.js";
import type { CircuitPaletteProps } from "./CircuitPalette.js";
import { CircuitPreviewDialog } from "./circuit-preview-dialog.js";
import { Button } from "./primitives.js";
import { useCircuitEditorContext } from "./CircuitEditor.js";
import type { CircuitStyleProps } from "./style-props.js";

export interface CircuitEditorLayoutProps extends Omit<HTMLAttributes<HTMLElement>, "children" | "style"> {
  style?: CircuitStyleProps["style"];
  /** Render an inline preview for a document block, without editor navigation. */
  previewOnly?: boolean;
  /** Reserved for the preset's mobile panel state. Build a custom root with the headless provider to control this attribute. */
  "data-panel"?: never;
  "data-preview-panel"?: never;
  boardProps?: Partial<CircuitBoardProps>;
  paletteProps?: Partial<CircuitPaletteProps>;
  inspectorProps?: Partial<CircuitInspectorProps>;
  analysisProps?: Partial<CircuitAnalysisPanelProps>;
}

type EditorContext = ReturnType<typeof useCircuitEditorContext>;

function isEditorTextInput(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function handleModalKeyDown(
  event: KeyboardEvent<HTMLElement>,
  preview: boolean,
  resetDialogRef: RefObject<HTMLDialogElement | null>,
  helpDialogRef: RefObject<HTMLDialogElement | null>,
  stopPreview: () => void,
) {
  if (resetDialogRef.current?.open || helpDialogRef.current?.open) { return true; }
  if (!preview) { return false; }
  if (event.key === "Escape") {
    event.preventDefault();
    stopPreview();
  }
  return true;
}

function handleEscapeKeyDown(
  event: KeyboardEvent<HTMLElement>,
  panel: "parts" | "properties" | null,
  editor: EditorContext,
  setTool: (tool: "select" | "pan") => void,
  setPanel: (panel: "parts" | "properties" | null) => void,
) {
  if (event.key !== "Escape") { return false; }
  event.preventDefault();
  if (panel) {
    setPanel(null);
    return true;
  }
  editor.cancelConnection();
  editor.clearSelection();
  setTool("select");
  setPanel(null);
  return true;
}

function handleFileKeyDown(event: KeyboardEvent<HTMLElement>, files: ReturnType<typeof useCircuitFiles>) {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) { return false; }
  const key = event.key.toLowerCase();
  if (key !== "s" && key !== "o") { return false; }
  event.preventDefault();
  if (!event.repeat) {
    if (key === "s") { files.save(); }
    else { files.open(); }
  }
  return true;
}

function handleCommandKeyDown(event: KeyboardEvent<HTMLElement>, editor: EditorContext) {
  if (!event.ctrlKey && !event.metaKey) { return false; }
  if (event.altKey || event.repeat) { return true; }
  const key = event.key.toLowerCase();
  const commands: Record<string, () => void> = {
    a: editor.selectAll,
    c: editor.copySelected,
    x: editor.cutSelected,
    v: editor.paste,
    d: editor.duplicateSelected,
    z: event.shiftKey ? editor.redo : editor.undo,
    y: editor.redo,
  };
  const command = commands[key];
  if (command) {
    event.preventDefault();
    command();
  }
  return true;
}

function handleEditorShortcut(
  event: KeyboardEvent<HTMLElement>,
  selected: boolean,
  part: CircuitPart | undefined,
  editor: EditorContext,
  addPart: (kind: CircuitPartKind) => void,
  selectTool: (tool: "select" | "pan") => void,
  helpDialogRef: RefObject<HTMLDialogElement | null>,
) {
  if (event.altKey || event.repeat) { return; }
  if ((event.key === "Delete" || event.key === "Backspace") && selected) {
    event.preventDefault();
    editor.removeSelected();
    return;
  }
  const kind = circuitPartKinds.find((partKind) => circuitPartCatalog[partKind].shortcut === event.key);
  if (kind) {
    event.preventDefault();
    addPart(kind);
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "r" && (part || editor.canCopy)) {
    event.preventDefault();
    editor.rotateSelected();
  } else if (key === "v") {
    selectTool("select");
  } else if (key === "h") {
    selectTool("pan");
  } else if (event.key === "?") {
    helpDialogRef.current?.showModal();
  }
}

type EditorPanel = "parts" | "properties" | null;
type EditorTool = "select" | "pan";

function runFileAction(event: MouseEvent<HTMLButtonElement>, action: () => void) {
  event.currentTarget.closest("details")?.removeAttribute("open");
  action();
}

function EditorHeader({
  title,
  preview,
  previewOnly,
  previewPanelOpen,
  previewToggleRef,
  onTitleChange,
  onTogglePreview,
  onOpenPreviewPanel,
  onOpenSample,
  files,
}: {
  title: string;
  preview: boolean;
  previewOnly: boolean;
  previewPanelOpen: boolean;
  previewToggleRef: RefObject<HTMLButtonElement | null>;
  onTitleChange: (title: string) => void;
  onTogglePreview: () => void;
  onOpenPreviewPanel: () => void;
  onOpenSample: () => void;
  files: ReturnType<typeof useCircuitFiles>;
}) {
  const fileMenuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const closeFileMenuOnOutsidePointerDown = (event: PointerEvent) => {
      const fileMenu = fileMenuRef.current;
      if (fileMenu?.open && event.target instanceof Node && !fileMenu.contains(event.target)) {
        fileMenu.open = false;
      }
    };

    document.addEventListener("pointerdown", closeFileMenuOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", closeFileMenuOnOutsidePointerDown, true);
  }, []);

  return (
    <header className="circuit-editor__header">
      {!preview && <div className="circuit-editor__identity">
        <span className="circuit-editor__mark"><CircuitIcon name="circuit" size={22} /></span>
        <span className="circuit-editor__brand">回路エディター</span>
      </div>}
      {!preview && <span className="circuit-editor__header-divider" aria-hidden="true" />}
      <div className="circuit-editor__document-name">
        {preview ? <span>{title || "名称未設定の回路"}</span> : <input aria-label="回路名" title="クリックして回路名を変更" value={title} onChange={(event) => onTitleChange(event.target.value)} placeholder="名称未設定の回路" />}
      </div>
      <div className="circuit-editor__header-actions">
        {preview && <Button variant="outline" className="circuit-editor__preview-panel-toggle" aria-haspopup="dialog" aria-expanded={previewPanelOpen} onClick={onOpenPreviewPanel}><CircuitIcon name="sliders" size={16} />解析・部品</Button>}
        {!preview && <details ref={fileMenuRef} className="circuit-editor__file-menu">
          <summary className="circuit-button">ファイル</summary>
          <div className="circuit-editor__file-actions">
            <button type="button" className="circuit-button" disabled={files.loading} onClick={(event) => runFileAction(event, files.newDocument)}>新しい回路</button>
            <button type="button" className="circuit-button" disabled={files.loading} onClick={(event) => runFileAction(event, files.open)}>JSONを開く</button>
            <button type="button" className="circuit-button" onClick={(event) => runFileAction(event, files.save)}><CircuitIcon name="download" />JSONを保存</button>
            <p>読み込み・新規作成は「元に戻す」で復元できます。</p>
          </div>
        </details>}
        <input ref={files.inputRef} type="file" accept=".json,application/json" aria-label="回路ファイルを開く" hidden disabled={preview || files.loading} onChange={files.readFile} />
        {!previewOnly && <button ref={previewToggleRef} type="button" className="circuit-button circuit-editor__preview-toggle" aria-pressed={preview} onClick={onTogglePreview} title={preview ? "編集に戻る (Esc)" : "回路をプレビュー"}>
          {preview && <CircuitIcon name="arrowLeft" size={16} />}{preview ? "編集に戻る" : "プレビュー"}{preview && <kbd>Esc</kbd>}
        </button>}
        {!preview && <button type="button" className="circuit-button" onClick={onOpenSample} title="サンプルを開く" aria-label="サンプルを開く"><CircuitIcon name="sample" /><span>サンプルを開く</span></button>}
      </div>
    </header>
  );
}

function EditorToolbar({
  editor,
  tool,
  part,
  selected,
  selectTool,
  helpDialogRef,
}: {
  editor: EditorContext;
  tool: EditorTool;
  part: CircuitPart | undefined;
  selected: boolean;
  selectTool: (tool: EditorTool) => void;
  helpDialogRef: RefObject<HTMLDialogElement | null>;
}) {
  return (
    <div className="circuit-editor__toolbar" role="toolbar" aria-label="回路の編集">
        <div className="circuit-editor__tool-group" role="group" aria-label="編集ツール">
          <button type="button" className={`circuit-icon-button${tool === "select" ? " is-active" : ""}`} aria-label="選択ツール" aria-pressed={tool === "select"} title="選択ツール (V)" onClick={() => selectTool("select")}><CircuitIcon name="cursor" /></button>
          <button type="button" className={`circuit-icon-button${tool === "pan" ? " is-active" : ""}`} aria-label="移動ツール" aria-pressed={tool === "pan"} title="移動ツール (H)" onClick={() => selectTool("pan")}><CircuitIcon name="hand" /></button>
        </div>
        <span className="circuit-editor__tool-divider" />
        <div className="circuit-editor__tool-group">
          <button type="button" className="circuit-icon-button" onClick={editor.undo} disabled={!editor.canUndo} aria-label="元に戻す" title="元に戻す (⌘ / Ctrl + Z)"><CircuitIcon name="undo" /></button>
          <button type="button" className="circuit-icon-button" onClick={editor.redo} disabled={!editor.canRedo} aria-label="やり直す" title="やり直す (⌘ / Ctrl + Shift + Z)"><CircuitIcon name="redo" /></button>
        </div>
        <span className="circuit-editor__tool-divider" />
        <div className="circuit-editor__tool-group">
          <button type="button" className="circuit-icon-button" onClick={editor.rotateSelected} disabled={!editor.canCopy || (editor.selection.parts.length === 1 && part?.kind === "junction")} aria-label="選択した部品を回転" title="90° 回転 (R)"><CircuitIcon name="rotate" /></button>
          <button type="button" className="circuit-icon-button" onClick={editor.removeSelected} disabled={!selected} aria-label="選択した部品または導線を削除" title="削除 (Delete)"><CircuitIcon name="trash" /></button>
        </div>
        <span className="circuit-editor__tool-divider" />
        <div className="circuit-editor__tool-group" role="group" aria-label="選択とコピー">
          <button type="button" className="circuit-icon-button" onClick={editor.selectAll} disabled={editor.document.parts.length === 0} aria-label="すべて選択" title="すべて選択 (⌘ / Ctrl + A)"><CircuitIcon name="selectAll" /></button>
          <button type="button" className="circuit-icon-button" onClick={editor.copySelected} disabled={!editor.canCopy} aria-label="選択をコピー" title="コピー (⌘ / Ctrl + C)"><CircuitIcon name="copy" /></button>
          <button type="button" className="circuit-icon-button" onClick={editor.cutSelected} disabled={!editor.canCut} aria-label="選択を切り取り" title="切り取り (⌘ / Ctrl + X)。導線は両端の部品も選択してください"><CircuitIcon name="cut" /></button>
          <button type="button" className="circuit-icon-button" onClick={editor.paste} disabled={!editor.canPaste} aria-label="貼り付け" title="貼り付け (⌘ / Ctrl + V)"><CircuitIcon name="paste" /></button>
          <button type="button" className="circuit-icon-button" onClick={editor.duplicateSelected} disabled={!editor.canCopy} aria-label="選択を複製" title="複製 (⌘ / Ctrl + D)"><CircuitIcon name="duplicate" /></button>
        </div>
        <span className="circuit-editor__toolbar-caption">回路図</span>
        <button type="button" className="circuit-icon-button circuit-editor__toolbar-help" title="操作ガイド (?)" aria-label="操作ガイド" onClick={() => helpDialogRef.current?.showModal()}><CircuitIcon name="help" /></button>
    </div>
  );
}

function EditorLeftSidebar({
  paletteProps,
  onAdd,
  onClose,
  onOpenHelp,
}: {
  paletteProps?: Partial<CircuitPaletteProps>;
  onAdd: (kind: CircuitPartKind) => void;
  onClose: () => void;
  onOpenHelp: () => void;
}) {
  return (
    <aside className="circuit-editor__left" aria-label="部品ライブラリ">
      <button type="button" className="circuit-editor__panel-close circuit-icon-button" aria-label="部品パネルを閉じる" onClick={onClose}><CircuitIcon name="close" /></button>
      <CircuitPalette onAdd={onAdd} {...paletteProps} />
      <div className="circuit-editor__sidebar-footer">
        <p>クリックで追加。<br />端子同士を選んでつなげます。</p>
        <button type="button" className="circuit-editor__help" onClick={onOpenHelp}><CircuitIcon name="help" /><span>操作ガイド</span><kbd>?</kbd></button>
      </div>
    </aside>
  );
}

function EditorFloatingResults({
  id,
  editor,
  part,
  preview,
  previewDocument,
  previewAnalysis,
  resultsMinimized,
  setResultsMinimized,
  analysisProps,
  formatReading,
}: {
  id: string;
  editor: EditorContext;
  part: CircuitPart | undefined;
  preview: boolean;
  previewDocument: CircuitDocument | null;
  previewAnalysis: ReturnType<typeof analyzeCircuit> | null;
  resultsMinimized: boolean;
  setResultsMinimized: (minimized: boolean | ((current: boolean) => boolean)) => void;
  analysisProps?: Partial<CircuitAnalysisPanelProps>;
  formatReading: (value: number | undefined, unit: string) => string;
}) {
  const document = previewDocument ?? editor.document;
  const analysis = previewAnalysis ?? editor.analysis;
  const readingParts = preview ? document.parts.filter((item) => item.kind !== "junction" && item.kind !== "ground") : [];
  const selectedReading = !preview && part ? analysis.parts[part.id] : undefined;
  const selectedMeter = !preview && part ? getMeterDisplay(part.kind, selectedReading, analysis.status) : undefined;
  const selectedLabels = measurementLabels(part?.kind ?? "resistor");
  const resultsRef = useRef<HTMLDivElement>(null);
  const [readingCorner, setReadingCorner] = useState<"top" | "bottom">("bottom");

  useLayoutEffect(() => {
    if (preview || !part) { return; }
    const canvas = resultsRef.current?.closest<HTMLElement>(".circuit-editor__canvas");
    const board = canvas?.querySelector<SVGSVGElement>(".circuit-board__surface");
    if (!canvas || !board) { return; }
    const measure = () => {
      const node = Array.from(canvas.querySelectorAll<SVGGraphicsElement>(".circuit-board__part[data-part-id]"))
        .find((element) => element.dataset.partId === part.id);
      if (!node) { return; }
      const canvasRect = canvas.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      if (canvasRect.height === 0 || nodeRect.height === 0) { return; }
      setReadingCorner(nodeRect.top + nodeRect.height / 2 < canvasRect.top + canvasRect.height / 2 ? "bottom" : "top");
    };
    measure();
    const mutations = new MutationObserver(measure);
    mutations.observe(board, { attributes: true, subtree: true, attributeFilter: ["viewBox", "transform"] });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(canvas);
    return () => { mutations.disconnect(); resize?.disconnect(); };
  }, [preview, part?.id]);

  return (
    <>
    <div ref={resultsRef} className="circuit-editor__floating-results" data-minimized={resultsMinimized}>
      <button type="button" className="circuit-editor__results-toggle" aria-label={resultsMinimized ? "解析パネルを展開" : "解析パネルを最小化"} aria-expanded={!resultsMinimized} aria-controls={`${id}-floating-results`} onClick={() => setResultsMinimized((value) => !value)}>
        <span>解析</span><CircuitIcon name="chevron" size={15} />
      </button>
      <div id={`${id}-floating-results`} className="circuit-editor__results-content" hidden={resultsMinimized}>
        <CircuitAnalysisPanel analysis={analysis} partCount={document.parts.length} wireCount={document.wires.length} {...analysisProps} showReason={false} />
        {readingParts.map((readingPart) => {
          const reading = analysis.parts[readingPart.id];
          const labels = measurementLabels(readingPart.kind);
          const meter = getMeterDisplay(readingPart.kind, reading, analysis.status);
          if (!reading && !meter) { return null; }
          return (
            <section className="circuit-editor__floating-readings" aria-label="選択部品の計測値" key={readingPart.id}>
              <h2>{readingPart.label}の計測値</h2>
              {meter
                ? <CircuitMeterReadout kind={readingPart.kind} reading={reading} analysisStatus={analysis.status} />
                : reading && <dl className="circuit-editor__floating-reading" data-part-id={readingPart.id}>
                    <div data-measurement="voltage"><dt>{labels.voltage}</dt><dd>{formatReading(reading.voltageVolts, "V")}</dd></div>
                    <div data-measurement="current"><dt>{labels.current}</dt><dd>{formatReading(reading.currentAmps, "A")}</dd></div>
                    <div data-measurement="power"><dt>電力</dt><dd>{formatReading(reading.powerWatts, "W")}</dd></div>
                    {analysis.mode === "ac" && <>
                      <div><dt>電圧位相</dt><dd>{formatReading(reading.voltagePhaseDegrees, "°")}</dd></div>
                      <div><dt>電流位相</dt><dd>{formatReading(reading.currentPhaseDegrees, "°")}</dd></div>
                    </>}
                  </dl>}
            </section>
          );
        })}
      </div>
    </div>
    {part && (selectedReading || selectedMeter) && <section className="circuit-editor__floating-readings circuit-editor__selected-readings" aria-label="選択部品の計測値" data-corner={readingCorner} hidden={resultsMinimized}>
      <h2>{part.label}の計測値</h2>
      {selectedMeter
        ? <CircuitMeterReadout kind={part.kind} reading={selectedReading} analysisStatus={analysis.status} />
        : selectedReading && <dl className="circuit-editor__floating-reading" data-part-id={part.id}>
            <div data-measurement="voltage"><dt>{selectedLabels.voltage}</dt><dd>{formatReading(selectedReading.voltageVolts, "V")}</dd></div>
            <div data-measurement="current"><dt>{selectedLabels.current}</dt><dd>{formatReading(selectedReading.currentAmps, "A")}</dd></div>
            <div data-measurement="power"><dt>電力</dt><dd>{formatReading(selectedReading.powerWatts, "W")}</dd></div>
            {analysis.mode === "ac" && <>
              <div><dt>電圧位相</dt><dd>{formatReading(selectedReading.voltagePhaseDegrees, "°")}</dd></div>
              <div><dt>電流位相</dt><dd>{formatReading(selectedReading.currentPhaseDegrees, "°")}</dd></div>
            </>}
          </dl>}
    </section>}
    </>
  );
}

function EditorCanvasNotices({
  preview,
  editor,
  onAddBattery,
}: {
  preview: boolean;
  editor: EditorContext;
  onAddBattery: () => void;
}) {
  return <>
    {!preview && editor.document.parts.length === 0 && <div className="circuit-editor__empty-canvas"><CircuitIcon name="circuit" size={32} /><h2>最初の部品を置きましょう</h2><p>部品パレットから選ぶと、ここに追加されます。</p><button type="button" className="circuit-button" onClick={onAddBattery}><CircuitIcon name="plus" />電池を追加</button></div>}
    {!preview && editor.pendingEndpoint && <div className="circuit-editor__connection" role="status"><CircuitIcon name="wire" /><span>{editor.pendingWire ? "新しい接続先の端子・導線を選択" : "接続先の端子・導線を選択"}<span className="circuit-editor__connection-detail"> · 空白で接続点を追加 · Escで中止</span></span><button type="button" onClick={editor.cancelConnection} aria-label="接続をキャンセル" title="接続をキャンセル (Esc)"><CircuitIcon name="close" /></button></div>}
    {!preview && editor.error && <p className="circuit-editor__error" role="alert">{editor.error}</p>}
  </>;
}

function selectionStatus(preview: boolean, editor: EditorContext, part: CircuitPart | undefined, wire: EditorContext["document"]["wires"][number] | undefined, tool: EditorTool) {
  if (preview) { return "ドラッグで移動・ピンチで拡大"; }
  if (editor.pendingEndpoint) { return editor.pendingWire ? "導線のつなぎ替え中" : "接続中"; }
  if (editor.selection.parts.length + editor.selection.wires.length > 1) { return `部品 ${editor.selection.parts.length} 個・導線 ${editor.selection.wires.length} 本を選択中`; }
  if (part) { return `${part.label} · 端子からドラッグして接続`; }
  if (wire) { return "区間をドラッグして経路調整、端の丸でつなぎ替え"; }
  if (tool === "pan") { return "ドラッグして表示位置を移動"; }
  return "部品を選択して編集";
}

function EditorCanvasFooter({
  editor,
  preview,
  part,
  wire,
  tool,
}: {
  editor: EditorContext;
  preview: boolean;
  part: CircuitPart | undefined;
  wire: EditorContext["document"]["wires"][number] | undefined;
  tool: EditorTool;
}) {
  return (
    <footer className="circuit-editor__canvas-footer">
      <span className="circuit-editor__selection-status" role="status">{selectionStatus(preview, editor, part, wire, tool)}</span>
      <span className="circuit-editor__canvas-hint">{preview ? <><kbd>Esc</kbd> 編集に戻る</> : <><kbd>Space</kbd> ドラッグで移動</>}</span>
      <span className="circuit-editor__document-count">部品 {editor.document.parts.length}<span> / </span>導線 {editor.document.wires.length}</span>
    </footer>
  );
}

function EditorSidebarContent({
  editor,
  part,
  wire,
  selected,
  inspectorProps,
  onClose,
  endpointLabel,
}: {
  editor: EditorContext;
  part: CircuitPart | undefined;
  wire: EditorContext["document"]["wires"][number] | undefined;
  selected: boolean;
  inspectorProps?: Partial<CircuitInspectorProps>;
  onClose: () => void;
  endpointLabel: (endpoint: NonNullable<EditorContext["document"]["wires"][number]>["from"]) => string;
}) {
  const multipleSelected = editor.selection.parts.length + editor.selection.wires.length > 1;
  const reading = part && getMeterDisplay(part.kind) ? editor.analysis.parts[part.id] : undefined;
  return (
    <>
      <button type="button" className="circuit-editor__panel-close circuit-icon-button" aria-label="プロパティパネルを閉じる" onClick={onClose}><CircuitIcon name="close" /></button>
      {multipleSelected ? <section className="circuit-editor__multi-selection" aria-label="複数選択">
        <h2>複数選択</h2><p>部品 {editor.selection.parts.length} 個・導線 {editor.selection.wires.length} 本</p>
        <p>ドラッグでまとめて移動できます。Shiftを押しながらクリックすると選択を切り替えます。</p>
        <button type="button" className="circuit-button" onClick={editor.clearSelection}>選択を解除</button>
      </section> : <CircuitInspector part={part} wire={wire} wireLabel={wire ? `${endpointLabel(wire.from)} → ${endpointLabel(wire.to)}` : undefined} wireEndpoints={wire ? { from: endpointLabel(wire.from), to: endpointLabel(wire.to) } : undefined} onReconnect={wire ? (end) => editor.startReconnect(wire.id, end) : undefined} onResetWireRoute={wire ? () => editor.resetWireRoute(wire.id) : undefined} onChange={editor.updatePart} onRotate={editor.rotateSelected} onDelete={editor.removeSelected} {...inspectorProps} reading={reading} analysisStatus={editor.analysis.status} />}
      <CircuitDiagnosticsPanel diagnostics={editor.diagnostics} onSelect={editor.selectRange} />
      {!selected && editor.document.parts.length > 0 && <section className="circuit-editor__outline" aria-label="回路内の部品"><h2>回路内の部品<span>{editor.document.parts.length}</span></h2><div>{editor.document.parts.map((item) => <button type="button" key={item.id} onClick={() => editor.selectPart(item.id)}><CircuitPartIcon kind={item.kind} /><span>{item.label}</span><CircuitIcon name="chevron" size={14} /></button>)}</div></section>}
    </>
  );
}

function EditorRightSidebar({
  id,
  preview,
  editor,
  part,
  wire,
  selected,
  inspectorProps,
  onClose,
  endpointLabel,
  onFrameChange,
}: {
  id: string;
  preview: boolean;
  editor: EditorContext;
  part: CircuitPart | undefined;
  wire: EditorContext["document"]["wires"][number] | undefined;
  selected: boolean;
  inspectorProps?: Partial<CircuitInspectorProps>;
  onClose: () => void;
  endpointLabel: (endpoint: NonNullable<EditorContext["document"]["wires"][number]>["from"]) => string;
  onFrameChange: (frame: CircuitTransientFrame | null) => void;
}) {
  if (preview) { return null; }
  return (
    <aside className="circuit-editor__right" id={`${id}-properties`} aria-label="プロパティ">
      <CircuitSimulationPanel document={editor.document} analysis={editor.analysis} options={editor.analysisOptions} onChange={editor.setAnalysisOptions} onFrameChange={onFrameChange} />

      <EditorSidebarContent editor={editor} part={part} wire={wire} selected={selected} inspectorProps={inspectorProps} onClose={onClose} endpointLabel={endpointLabel} />
    </aside>
  );
}

function EditorCenter({
  id,
  editor,
  boardVersion,
  preview,
  previewDocument,
  previewAnalysis,
  tool,
  part,
  wire,
  selected,
  boardProps,
  analysisProps,
  helpDialogRef,
  resultsMinimized,
  selectTool,
  setResultsMinimized,
  onViewportCenterChange,
  onAddBattery,
  onSwitchToggle,
  onInspectPart,
  formatReading,
  sampledAnalysis,
  onFrameChange,
}: {
  id: string;
  editor: EditorContext;
  boardVersion: number;
  preview: boolean;
  previewDocument: CircuitDocument | null;
  previewAnalysis: ReturnType<typeof analyzeCircuit> | null;
  tool: EditorTool;
  part: CircuitPart | undefined;
  wire: EditorContext["document"]["wires"][number] | undefined;
  selected: boolean;
  boardProps?: Partial<CircuitBoardProps>;
  analysisProps?: Partial<CircuitAnalysisPanelProps>;
  helpDialogRef: RefObject<HTMLDialogElement | null>;
  resultsMinimized: boolean;
  selectTool: (tool: EditorTool) => void;
  setResultsMinimized: (minimized: boolean | ((current: boolean) => boolean)) => void;
  onViewportCenterChange: (point: Point) => void;
  onAddBattery: () => void;
  onSwitchToggle: (partId: string) => void;
  onInspectPart: (partId: string) => void;
  formatReading: (value: number | undefined, unit: string) => string;
  sampledAnalysis: ReturnType<typeof analyzeCircuit> | null;
  onFrameChange: (frame: CircuitTransientFrame | null) => void;
}) {
  return (
    <section className="circuit-editor__center" aria-label={preview ? "プレビュー領域" : "編集領域"}>
      {!preview && <EditorToolbar
        editor={editor}
        tool={tool}
        part={part}
        selected={selected}
        selectTool={selectTool}
        helpDialogRef={helpDialogRef}
      />}
      <div className="circuit-editor__canvas">
        <CircuitBoard
          key={boardVersion}
          selection={editor.selection}
          pendingEndpoint={editor.pendingEndpoint}
          pendingWire={editor.pendingWire}
          panMode={preview || tool === "pan"}
          onSelectPart={editor.selectPart}
          onSelectWire={editor.selectWire}
          onSelectRange={editor.selectRange}
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
          onViewportCenterChange={onViewportCenterChange}
          {...boardProps}
          document={previewDocument ?? editor.document}
          analysis={sampledAnalysis ?? previewAnalysis ?? editor.analysis}
          showFlow={preview || boardProps?.showFlow === true}
          showPotentials={boardProps?.showPotentials ?? true}
          onSwitchToggle={preview ? onSwitchToggle : boardProps?.onSwitchToggle}
          onInspectPart={preview ? onInspectPart : boardProps?.onInspectPart}
          readOnly={preview || boardProps?.readOnly === true}
          fitOnResize={preview || boardProps?.fitOnResize === true}
          compactControls={preview || boardProps?.compactControls === true}
          panOnScroll={boardProps?.panOnScroll ?? !preview}
        />
        {!preview && <EditorFloatingResults id={id} editor={editor} part={part} preview={preview} previewDocument={previewDocument} previewAnalysis={sampledAnalysis ?? previewAnalysis} resultsMinimized={resultsMinimized} setResultsMinimized={setResultsMinimized} analysisProps={analysisProps} formatReading={formatReading} />}
        <EditorCanvasNotices preview={preview} editor={editor} onAddBattery={onAddBattery} />
      </div>
      {preview && previewAnalysis ? (
        <div className="circuit-editor__preview-footer">
          <CircuitAnalysisPanel analysis={sampledAnalysis ?? previewAnalysis} showReason={false} className="circuit-editor__preview-summary" />
          <span className="circuit-editor__preview-hint">部品をダブルクリックして値を調整</span>
        </div>
      ) : <EditorCanvasFooter editor={editor} preview={preview} part={part} wire={wire} tool={tool} />}
      {preview && previewDocument && previewAnalysis && <details className="circuit-editor__learning">
        <summary>学習ビュー<span>時間波形・エネルギー・比較</span></summary>
        <CircuitSimulationPanel document={previewDocument} baselineDocument={editor.document} analysis={previewAnalysis} options={editor.analysisOptions} onChange={editor.setAnalysisOptions} onFrameChange={onFrameChange} />
      </details>}
    </section>
  );
}

function EditorMobileNav({
  panel,
  selected,
  setPanel,
  focusBoard,
}: {
  panel: EditorPanel;
  selected: boolean;
  setPanel: (panel: EditorPanel) => void;
  focusBoard: () => void;
}) {
  return (
    <nav className="circuit-editor__mobile-nav" aria-label="エディターパネル">
      <button type="button" data-panel-trigger="parts" aria-expanded={panel === "parts"} className={panel === "parts" ? "is-active" : ""} onClick={() => setPanel(panel === "parts" ? null : "parts")}><CircuitIcon name="layers" /><span>部品</span></button>
      <button type="button" aria-pressed={panel === null} className={panel === null ? "is-active" : ""} onClick={() => { setPanel(null); focusBoard(); }}><CircuitIcon name="circuit" /><span>回路図</span></button>
      <button type="button" data-panel-trigger="properties" aria-expanded={panel === "properties"} className={panel === "properties" ? "is-active" : ""} onClick={() => setPanel(panel === "properties" ? null : "properties")}><CircuitIcon name="sliders" /><span>プロパティ</span>{selected && <span className="circuit-editor__mobile-selection" />}</button>
    </nav>
  );
}

function closeDialogOnBackdrop(event: MouseEvent<HTMLDialogElement>) {
  if (event.target === event.currentTarget) { event.currentTarget.close(); }
}

function EditorShortcuts() {
  const shortcuts = [
    ["部品を追加", "1–7"],
    ["選択 / 移動ツール", "V / H"],
    ["選択の追加・解除", "Shift + クリック"],
    ["範囲を追加選択", "Shift + 余白をドラッグ"],
    ["すべて選択", "⌘ / Ctrl + A"],
    ["コピー / 切り取り / 貼り付け", "⌘ / Ctrl + C / X / V"],
    ["選択を複製", "⌘ / Ctrl + D"],
    ["回転 / 削除", "R / Delete"],
    ["元に戻す", "⌘ / Ctrl + Z"],
    ["やり直す", "⌘ / Ctrl + Shift + Z"],
    ["保存 / 開く", "⌘ / Ctrl + S / O"],
    ["選択・接続を解除", "Esc"],
    ["表示位置を移動", "Space + ドラッグ"],
    ["拡大・縮小", "⌘ / Ctrl + ホイール"],
  ];
  return <dl className="circuit-shortcuts">{shortcuts.map(([label, keys]) => <div key={label}><dt>{label}</dt><dd><kbd>{keys}</kbd></dd></div>)}</dl>;
}

function EditorDialogs({
  id,
  resetDialogRef,
  helpDialogRef,
  onReset,
}: {
  id: string;
  resetDialogRef: RefObject<HTMLDialogElement | null>;
  helpDialogRef: RefObject<HTMLDialogElement | null>;
  onReset: (kind: CircuitExampleKind) => void;
}) {
  const [sample, setSample] = useState<CircuitExampleKind>("dc");
  return <>
    <dialog ref={resetDialogRef} className="circuit-dialog" aria-labelledby={`${id}-reset-title`} onClick={closeDialogOnBackdrop}>
      <div className="circuit-dialog__content">
        <h2 id={`${id}-reset-title`}>サンプル回路を開く</h2>
        <label htmlFor={`${id}-sample`}>サンプルの種類</label>
        <select id={`${id}-sample`} className="circuit-sample-select" value={sample} onChange={(event) => setSample(event.target.value as CircuitExampleKind)}>
          {Object.entries(circuitExampleCatalog).map(([kind, spec]) => <option value={kind} key={kind}>{spec.name}</option>)}
        </select>
        <p>{circuitExampleCatalog[sample].description}</p>
        <p>今の編集内容は「元に戻す」で復元できます。</p>
        <div className="circuit-dialog__actions"><button type="button" className="circuit-button" autoFocus onClick={() => resetDialogRef.current?.close()}>キャンセル</button><button type="button" className="circuit-button circuit-button--primary" onClick={() => onReset(sample)}>サンプルを開く</button></div>
      </div>
    </dialog>
    <dialog ref={helpDialogRef} className="circuit-dialog circuit-dialog--help" aria-labelledby={`${id}-help-title`} onClick={closeDialogOnBackdrop}>
      <div className="circuit-dialog__content"><div className="circuit-dialog__heading"><h2 id={`${id}-help-title`}>操作ガイド</h2><button type="button" className="circuit-icon-button" aria-label="操作ガイドを閉じる" autoFocus onClick={() => helpDialogRef.current?.close()}><CircuitIcon name="close" /></button></div><p>端子の丸からドラッグ、または端子を順にクリックして接続。<br />導線へつなぐと分岐します。選択した導線は線上または四角いハンドルをドラッグして経路を調整し、端の丸から接続先を変更できます。</p><EditorShortcuts /><p className="circuit-dialog__note">区間ハンドルは矢印キーでも動かせます。Shift + 矢印キーは5マス移動、Escでドラッグを取り消します。<br />部品にフォーカスして矢印キーで移動。タッチ操作では、2本指で移動・ピンチで拡大できます。</p></div>
    </dialog>
  </>;
}

/** Optional ready-to-use arrangement of the headless editor state and UI pieces. */
export function CircuitEditorLayout({
  className = "",
  previewOnly = false,
  boardProps,
  paletteProps,
  inspectorProps,
  analysisProps,
  onKeyDown: onRootKeyDown,
  onBlur: onRootBlur,
  ...rootProps
}: CircuitEditorLayoutProps) {
  const editor = useCircuitEditorContext();
  const id = useId();
  const [boardVersion, setBoardVersion] = useState(0);
  const [tool, setTool] = useState<"select" | "pan">("select");
  const [resultsMinimized, setResultsMinimized] = useState(false);
  const [previewDocument, setPreviewDocument] = useState<CircuitDocument | null>(() => previewOnly
    ? { ...editor.document, parts: editor.document.parts.map((item) => ({ ...item })) }
    : null);
  const [previewPanelOpen, setPreviewPanelOpen] = useState(false);
  const [previewPartId, setPreviewPartId] = useState<string | null>(null);
  const previewReturnFocus = useRef<HTMLElement | SVGElement | null>(null);
  const preview = previewDocument !== null;
  const previewAnalysis = useMemo(() => previewDocument ? analyzeCircuit(previewDocument, {}, editor.analysisOptions) : null, [previewDocument, editor.analysisOptions]);
  const activeDocument = previewDocument ?? editor.document;
  const [transientState, setTransientState] = useState<{ document: CircuitDocument; frame: CircuitTransientFrame | null } | null>(null);
  const onFrameChange = useCallback((frame: CircuitTransientFrame | null) => setTransientState({ document: activeDocument, frame }), [activeDocument]);
  const activeFrame = transientState?.document === activeDocument ? transientState.frame : null;
  const sampledAnalysis = useMemo(() => activeFrame ? analysisAtTransientFrame(activeDocument, activeFrame) : null, [activeDocument, activeFrame]);
  const [panel, setPanel] = useState<"parts" | "properties" | null>(null);
  const previousPanel = useRef(panel);
  const rootRef = useRef<HTMLElement>(null);
  const previewToggleRef = useRef<HTMLButtonElement>(null);
  const resetDialogRef = useRef<HTMLDialogElement>(null);
  const helpDialogRef = useRef<HTMLDialogElement>(null);
  const viewportCenter = useRef<Point>({ x: 14, y: 9 });
  const part = editor.document.parts.find((item) => item.id === editor.selection.parts[0]);
  const wire = editor.document.wires.find((item) => item.id === editor.selection.wires[0]);
  const selected = Boolean(part || wire);
  const files = useCircuitFiles(editor, () => {
    setPreviewDocument(null);
    setBoardVersion((version) => version + 1);
    setTool("select");
    setPanel(null);
    focusBoard();
  });
  const formatReading = (value: number | undefined, unit: string) => value === undefined || !Number.isFinite(value) ? "—" : `${value !== 0 && Math.abs(value) < 0.01 ? value.toPrecision(3) : value.toFixed(2)} ${unit}`;

  function resetPreview(partId?: string) {
    setPreviewDocument((current) => !partId || !current
      ? { ...editor.document, parts: editor.document.parts.map((item) => ({ ...item })) }
      : { ...current, parts: current.parts.map((item) => item.id === partId
        ? { ...(editor.document.parts.find((initial) => initial.id === partId) ?? item) } : item) });
  }

  function openPreviewDialog(partId: string | null) {
    const active = globalThis.document.activeElement;
    previewReturnFocus.current = active instanceof HTMLElement || active instanceof SVGElement ? active : null;
    setPreviewPartId(partId);
    setPreviewPanelOpen(true);
  }

  function startPreview() {
    editor.cancelConnection();
    setPanel(null);
    setPreviewPanelOpen(false);
    setPreviewPartId(null);
    resetPreview();
  }

  function stopPreview() {
    if (previewOnly) { return; }
    setPreviewPanelOpen(false);
    setPreviewPartId(null);
    setPreviewDocument(null);
    previewToggleRef.current?.focus({ preventScroll: true });
  }

  function changePreviewPart(partId: string, patch: Partial<CircuitPart>) {
    setPreviewDocument((current) => current && {
      ...current,
      parts: current.parts.map((item) => item.id === partId ? { ...item, ...patch } : item),
    });
  }

  useEffect(() => {
    const previous = previousPanel.current;
    previousPanel.current = panel;
    if (!window.matchMedia("(max-width: 900px)").matches) { return; }
    const frame = requestAnimationFrame(() => {
      const selector = (panel ?? previous) === "parts" ? ".circuit-editor__left" : ".circuit-editor__right";
      const sidebar = rootRef.current?.querySelector<HTMLElement>(selector);
      if (panel) { sidebar?.querySelector<HTMLElement>("button")?.focus(); }
      else if (previous && (sidebar?.contains(globalThis.document.activeElement) || globalThis.document.activeElement === globalThis.document.body)) {
        rootRef.current?.querySelector<HTMLElement>(`[data-panel-trigger="${previous}"]`)?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [panel]);

  function focusBoard() {
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(".circuit-board__viewport")?.focus({ preventScroll: true }));
  }

  function addPart(kind: CircuitPartKind) {
    editor.add(kind, viewportCenter.current);
    setTool("select");
    setPanel(null);
    focusBoard();
  }

  function selectTool(next: "select" | "pan") {
    setTool(next);
    editor.cancelConnection();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    onRootKeyDown?.(event);
    if (event.defaultPrevented) { return; }
    if (preview && previewPanelOpen) { return; }
    if (handleModalKeyDown(event, preview, resetDialogRef, helpDialogRef, stopPreview)) { return; }
    if (handleFileKeyDown(event, files)) { return; }
    if (isEditorTextInput(event.target)) { return; }
    if (handleEscapeKeyDown(event, panel, editor, setTool, setPanel)) { return; }
    if (handleCommandKeyDown(event, editor)) { return; }
    handleEditorShortcut(event, selected, part, editor, addPart, selectTool, helpDialogRef);
  }

  const endpointLabel = (endpoint: NonNullable<typeof wire>["from"]) => {
    const endpointPart = editor.document.parts.find((item) => item.id === endpoint.partId);
    return endpointPart ? endpointName(endpointPart, endpoint.terminal) : "接続先なし";
  };

  function onBlur(event: FocusEvent<HTMLElement>) {
    onRootBlur?.(event);
    if (!event.defaultPrevented) { editor.endEdit(); }
  }

  function togglePreview() {
    if (preview) { stopPreview(); }
    else { startPreview(); }
  }

  function togglePreviewSwitch(partId: string) {
    setPreviewDocument((current) => current && {
      ...current,
      parts: current.parts.map((item) => item.id === partId && item.kind === "switch"
        ? { ...item, initiallyClosed: !(item.initiallyClosed ?? false) } : item),
    });
  }

  function resetSample(kind: CircuitExampleKind) {
    editor.openExample(kind);
    setBoardVersion((version) => version + 1);
    setTool("select");
    setPanel(null);
    resetDialogRef.current?.close();
    focusBoard();
  }

  const Root = previewOnly ? "section" : "main";

  return (
    <Root aria-label={previewOnly ? "回路プレビュー" : undefined} {...rootProps} ref={rootRef} className={`circuit-editor ${className}`} data-panel={panel ?? "none"} data-preview={preview} data-embedded={previewOnly} data-preview-panel={previewPanelOpen ? "open" : "closed"} onKeyDown={onKeyDown} onBlur={onBlur}>
      <EditorHeader
        title={editor.document.title}
        preview={preview}
        previewOnly={previewOnly}
        previewPanelOpen={previewPanelOpen}
        previewToggleRef={previewToggleRef}
        onTitleChange={editor.setTitle}
        onTogglePreview={togglePreview}
        onOpenPreviewPanel={() => openPreviewDialog(null)}
        onOpenSample={() => resetDialogRef.current?.showModal()}
        files={files}
      />
      {files.error && <p className="circuit-editor__file-error" role="alert">{files.error}</p>}
      {files.loading && <p className="circuit-editor__file-status" role="status">回路ファイルを読み込んでいます…</p>}
      <div className="circuit-editor__workspace">
        {panel && <button type="button" className="circuit-editor__backdrop" onClick={() => setPanel(null)} aria-label="パネルを閉じる" />}
        {!previewOnly && <EditorLeftSidebar paletteProps={paletteProps} onAdd={addPart} onClose={() => setPanel(null)} onOpenHelp={() => helpDialogRef.current?.showModal()} />}
        <EditorCenter
          id={id}
          editor={editor}
          boardVersion={boardVersion}
          preview={preview}
          previewDocument={previewDocument}
          previewAnalysis={previewAnalysis}
          tool={tool}
          part={part}
          wire={wire}
          selected={selected}
          boardProps={boardProps}
          analysisProps={analysisProps}
          helpDialogRef={helpDialogRef}
          resultsMinimized={resultsMinimized}
          selectTool={selectTool}
          setResultsMinimized={setResultsMinimized}
          onViewportCenterChange={(point) => { viewportCenter.current = point; }}
          onAddBattery={() => addPart("battery")}
          onSwitchToggle={togglePreviewSwitch}
          onInspectPart={openPreviewDialog}
          formatReading={formatReading}
          sampledAnalysis={sampledAnalysis}
          onFrameChange={onFrameChange}
        />
        {!previewOnly && <EditorRightSidebar
          id={id}
          preview={preview}
          editor={editor}
          part={part}
          wire={wire}
          selected={selected}
          inspectorProps={inspectorProps}
          onClose={() => setPanel(null)}
          endpointLabel={endpointLabel}
          onFrameChange={onFrameChange}
        />}
      </div>
      {!previewOnly && <EditorMobileNav panel={panel} selected={selected} setPanel={setPanel} focusBoard={focusBoard} />}
      {previewDocument && previewAnalysis && <CircuitPreviewDialog
        open={previewPanelOpen}
        partId={previewPartId}
        document={previewDocument}
        initialDocument={editor.document}
        analysis={previewAnalysis}
        analysisProps={analysisProps}
        options={editor.analysisOptions}
        container={rootRef}
        returnFocus={previewReturnFocus}
        onOpenChange={setPreviewPanelOpen}
        onSelectPart={setPreviewPartId}
        onChange={changePreviewPart}
        onOptionsChange={editor.setAnalysisOptions}
        onReset={resetPreview}
      />}
      {!previewOnly && <EditorDialogs id={id} resetDialogRef={resetDialogRef} helpDialogRef={helpDialogRef} onReset={resetSample} />}
    </Root>
  );
}
