import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { circuitPartCatalog, circuitPartKinds, endpointName, type CircuitDocument, type CircuitPartKind } from "../circuit-model.js";
import type { Point } from "../circuit-geometry.js";
import { CircuitAnalysisPanel } from "./CircuitAnalysisPanel.js";
import { CircuitBoard } from "./CircuitBoard.js";
import { CircuitIcon } from "./CircuitIcon.js";
import { CircuitInspector } from "./CircuitInspector.js";
import { CircuitPalette, CircuitPartIcon } from "./CircuitPalette.js";
import { useCircuitEditor } from "./useCircuitEditor.js";
import "./editor.css";

export interface CircuitEditorProps {
  initialDocument?: CircuitDocument;
  onDocumentChange?: (document: CircuitDocument) => void;
  className?: string;
}

/** Ready-to-use arrangement of the optional UI pieces. Import each piece separately to arrange them yourself. */
export function CircuitEditor({ initialDocument, onDocumentChange, className = "" }: CircuitEditorProps) {
  const editor = useCircuitEditor(initialDocument);
  const id = useId();
  const [boardVersion, setBoardVersion] = useState(0);
  const [tool, setTool] = useState<"select" | "pan">("select");
  const [panel, setPanel] = useState<"parts" | "properties" | null>(null);
  const previousPanel = useRef(panel);
  const rootRef = useRef<HTMLElement>(null);
  const resetDialogRef = useRef<HTMLDialogElement>(null);
  const helpDialogRef = useRef<HTMLDialogElement>(null);
  const viewportCenter = useRef<Point>({ x: 14, y: 9 });
  const previousDocument = useRef(editor.document);
  const part = editor.document.parts.find((item) => item.id === editor.selection.parts[0]);
  const wire = editor.document.wires.find((item) => item.id === editor.selection.wires[0]);
  const selected = Boolean(part || wire);

  useEffect(() => {
    if (previousDocument.current !== editor.document) {
      previousDocument.current = editor.document;
      onDocumentChange?.(editor.document);
    }
  }, [editor.document, onDocumentChange]);

  useEffect(() => {
    const previous = previousPanel.current;
    previousPanel.current = panel;
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    const frame = requestAnimationFrame(() => {
      const selector = (panel ?? previous) === "parts" ? ".circuit-editor__left" : ".circuit-editor__right";
      const sidebar = rootRef.current?.querySelector<HTMLElement>(selector);
      if (panel) sidebar?.querySelector<HTMLElement>("button")?.focus();
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
    if (resetDialogRef.current?.open || helpDialogRef.current?.open) return;
    if (event.key === "Escape" && panel) {
      event.preventDefault();
      setPanel(null);
      return;
    }
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (event.key === "Escape") {
      editor.cancelConnection();
      editor.clearSelection();
      setTool("select");
      setPanel(null);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) editor.redo(); else editor.undo();
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        editor.redo();
      }
      return;
    }
    if (event.altKey || event.repeat) return;
    if ((event.key === "Delete" || event.key === "Backspace") && selected) {
      event.preventDefault();
      editor.removeSelected();
      return;
    }
    const kind = circuitPartKinds.find((kind) => circuitPartCatalog[kind].shortcut === event.key);
    if (kind) {
      event.preventDefault();
      addPart(kind);
    } else if (event.key.toLowerCase() === "r" && part) {
      event.preventDefault();
      editor.rotateSelected();
    } else if (event.key.toLowerCase() === "v") selectTool("select");
    else if (event.key.toLowerCase() === "h") selectTool("pan");
    else if (event.key === "?") helpDialogRef.current?.showModal();
  }

  const endpointLabel = (endpoint: NonNullable<typeof wire>["from"]) => {
    const endpointPart = editor.document.parts.find((item) => item.id === endpoint.partId);
    return endpointPart ? endpointName(endpointPart, endpoint.terminal) : "接続先なし";
  };

  return (
    <main ref={rootRef} className={`circuit-editor ${className}`} data-panel={panel ?? "none"} onKeyDown={onKeyDown} onBlur={editor.endEdit}>
      <header className="circuit-editor__header">
        <div className="circuit-editor__identity">
          <span className="circuit-editor__mark"><CircuitIcon name="circuit" size={22} /></span>
          <span className="circuit-editor__brand">回路エディター</span>
        </div>
        <span className="circuit-editor__header-divider" aria-hidden="true" />
        <div className="circuit-editor__document-name">
          <input aria-label="回路名" title="クリックして回路名を変更" value={editor.document.title} onChange={(event) => editor.setTitle(event.target.value)} placeholder="名称未設定の回路" />
        </div>
        <div className="circuit-editor__header-actions">
          <span className="circuit-editor__auto-analysis"><span />自動解析</span>
          <button type="button" className="circuit-button" onClick={() => resetDialogRef.current?.showModal()} title="サンプルを開く" aria-label="サンプルを開く"><CircuitIcon name="sample" /><span>サンプルを開く</span></button>
        </div>
      </header>

      <div className="circuit-editor__workspace">
        {panel && <button type="button" className="circuit-editor__backdrop" onClick={() => setPanel(null)} aria-label="パネルを閉じる" />}
        <aside className="circuit-editor__left" aria-label="部品ライブラリ">
          <button type="button" className="circuit-editor__panel-close circuit-icon-button" aria-label="部品パネルを閉じる" onClick={() => setPanel(null)}><CircuitIcon name="close" /></button>
          <CircuitPalette onAdd={addPart} />
          <div className="circuit-editor__sidebar-footer">
            <p>クリックで追加。<br />端子同士を選んでつなげます。</p>
            <button type="button" className="circuit-editor__help" onClick={() => helpDialogRef.current?.showModal()}><CircuitIcon name="help" /><span>操作ガイド</span><kbd>?</kbd></button>
          </div>
        </aside>

        <section className="circuit-editor__center" aria-label="編集領域">
          <div className="circuit-editor__toolbar" role="toolbar" aria-label="回路の編集">
            <div className="circuit-editor__tool-group" aria-label="編集ツール">
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
              <button type="button" className="circuit-icon-button" onClick={editor.rotateSelected} disabled={!part || part.kind === "junction"} aria-label="選択した部品を回転" title="90° 回転 (R)"><CircuitIcon name="rotate" /></button>
              <button type="button" className="circuit-icon-button" onClick={editor.removeSelected} disabled={!selected} aria-label="選択した部品または導線を削除" title="削除 (Delete)"><CircuitIcon name="trash" /></button>
            </div>
            <span className="circuit-editor__toolbar-caption">回路図</span>
            <button type="button" className="circuit-icon-button circuit-editor__toolbar-help" title="操作ガイド (?)" aria-label="操作ガイド" onClick={() => helpDialogRef.current?.showModal()}><CircuitIcon name="help" /></button>
          </div>
          <div className="circuit-editor__canvas">
            <CircuitBoard
              key={boardVersion}
              document={editor.document}
              selection={editor.selection}
              pendingEndpoint={editor.pendingEndpoint}
              panMode={tool === "pan"}
              analysis={editor.analysis}
              onSelectPart={editor.selectPart}
              onSelectWire={editor.selectWire}
              onTerminalClick={editor.chooseTerminal}
              onBoardClick={editor.choosePoint}
              onMovePart={editor.movePart}
              onMoveEnd={editor.endEdit}
              onMoveCancel={editor.cancelMove}
              onViewportCenterChange={(point) => { viewportCenter.current = point; }}
            />
            {editor.document.parts.length === 0 && <div className="circuit-editor__empty-canvas"><CircuitIcon name="circuit" size={32} /><h2>最初の部品を置きましょう</h2><p>部品パレットから選ぶと、ここに追加されます。</p><button type="button" className="circuit-button" onClick={() => addPart("battery")}><CircuitIcon name="plus" />電池を追加</button></div>}
            {editor.pendingEndpoint && <div className="circuit-editor__connection" role="status"><CircuitIcon name="wire" /><span>接続先の端子を選択<span className="circuit-editor__connection-detail"> · 空白を選ぶと接続点を追加</span></span><button type="button" onClick={editor.cancelConnection} aria-label="接続をキャンセル" title="接続をキャンセル (Esc)"><CircuitIcon name="close" /></button></div>}
            {editor.error && <p className="circuit-editor__error" role="alert">{editor.error}</p>}
          </div>
          <footer className="circuit-editor__canvas-footer">
            <span className="circuit-editor__selection-status" role="status">{editor.pendingEndpoint ? "接続中" : part ? `${part.label} を選択中` : wire ? "導線を選択中" : tool === "pan" ? "ドラッグして表示位置を移動" : "部品を選択して編集"}</span>
            <span className="circuit-editor__canvas-hint"><kbd>Space</kbd> ドラッグで移動</span>
            <span className="circuit-editor__document-count">部品 {editor.document.parts.length}<span> / </span>導線 {editor.document.wires.length}</span>
          </footer>
        </section>

        <aside className="circuit-editor__right" aria-label="プロパティと解析">
          <button type="button" className="circuit-editor__panel-close circuit-icon-button" aria-label="プロパティパネルを閉じる" onClick={() => setPanel(null)}><CircuitIcon name="close" /></button>
          <CircuitInspector part={part} wire={wire} wireLabel={wire ? `${endpointLabel(wire.from)} → ${endpointLabel(wire.to)}` : undefined} reading={part ? editor.analysis.parts[part.id] : undefined} onChange={editor.updatePart} onRotate={editor.rotateSelected} onDelete={editor.removeSelected} />
          {!selected && editor.document.parts.length > 0 && <section className="circuit-editor__outline" aria-label="回路内の部品"><h2>回路内の部品<span>{editor.document.parts.length}</span></h2><div>{editor.document.parts.map((item) => <button type="button" key={item.id} onClick={() => editor.selectPart(item.id)}><CircuitPartIcon kind={item.kind} /><span>{item.label}</span><CircuitIcon name="chevron" size={14} /></button>)}</div></section>}
          <CircuitAnalysisPanel analysis={editor.analysis} partCount={editor.document.parts.length} wireCount={editor.document.wires.length} />
        </aside>
      </div>

      <nav className="circuit-editor__mobile-nav" aria-label="エディターパネル">
        <button type="button" data-panel-trigger="parts" aria-expanded={panel === "parts"} className={panel === "parts" ? "is-active" : ""} onClick={() => setPanel(panel === "parts" ? null : "parts")}><CircuitIcon name="layers" /><span>部品</span></button>
        <button type="button" aria-pressed={panel === null} className={panel === null ? "is-active" : ""} onClick={() => { setPanel(null); focusBoard(); }}><CircuitIcon name="circuit" /><span>回路図</span></button>
        <button type="button" data-panel-trigger="properties" aria-expanded={panel === "properties"} className={panel === "properties" ? "is-active" : ""} onClick={() => setPanel(panel === "properties" ? null : "properties")}><CircuitIcon name="sliders" /><span>プロパティ</span>{selected && <span className="circuit-editor__mobile-selection" />}</button>
      </nav>

      <dialog ref={resetDialogRef} className="circuit-dialog" aria-labelledby={`${id}-reset-title`} onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <div className="circuit-dialog__content"><h2 id={`${id}-reset-title`}>サンプル回路を開く</h2><p>電池・抵抗・電球・スイッチを接続した回路に置き換えます。今の編集内容は「元に戻す」で復元できます。</p><div className="circuit-dialog__actions"><button type="button" className="circuit-button" autoFocus onClick={() => resetDialogRef.current?.close()}>キャンセル</button><button type="button" className="circuit-button circuit-button--primary" onClick={() => { editor.reset(); setBoardVersion((version) => version + 1); setTool("select"); setPanel(null); resetDialogRef.current?.close(); focusBoard(); }}>サンプルを開く</button></div></div>
      </dialog>
      <dialog ref={helpDialogRef} className="circuit-dialog circuit-dialog--help" aria-labelledby={`${id}-help-title`} onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <div className="circuit-dialog__content"><div className="circuit-dialog__heading"><h2 id={`${id}-help-title`}>操作ガイド</h2><button type="button" className="circuit-icon-button" aria-label="操作ガイドを閉じる" autoFocus onClick={() => helpDialogRef.current?.close()}><CircuitIcon name="close" /></button></div><p>部品を置いて、端子の丸を順にクリック。<br />接続や値を変えると、その場で計測値が更新されます。</p><dl className="circuit-shortcuts"><div><dt>部品を追加</dt><dd><kbd>1</kbd> – <kbd>7</kbd></dd></div><div><dt>選択 / 移動ツール</dt><dd><kbd>V</kbd> / <kbd>H</kbd></dd></div><div><dt>回転 / 削除</dt><dd><kbd>R</kbd> / <kbd>Delete</kbd></dd></div><div><dt>元に戻す</dt><dd><kbd>⌘ / Ctrl</kbd> + <kbd>Z</kbd></dd></div><div><dt>やり直す</dt><dd><kbd>⌘ / Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd></dd></div><div><dt>選択・接続を解除</dt><dd><kbd>Esc</kbd></dd></div><div><dt>表示位置を移動</dt><dd><kbd>Space</kbd> + ドラッグ</dd></div><div><dt>拡大・縮小</dt><dd><kbd>⌘ / Ctrl</kbd> + ホイール</dd></div></dl><p className="circuit-dialog__note">部品にフォーカスして矢印キーで移動。<br />タッチ操作では、2本指で移動・ピンチで拡大できます。</p></div>
      </dialog>
    </main>
  );
}
