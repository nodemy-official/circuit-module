import { useEffect, type RefObject } from "react";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../circuit-model.js";
import type { CircuitAnalysis, CircuitAnalysisOptions } from "../circuit-solver.js";
import { CircuitAnalysisPanel } from "./CircuitAnalysisPanel.js";
import type { CircuitAnalysisPanelProps } from "./CircuitAnalysisPanel.js";
import { CircuitIcon } from "./CircuitIcon.js";
import { CircuitPartIcon } from "./CircuitPalette.js";
import { CircuitPreviewPanel } from "./CircuitPreviewPanel.js";
import { CircuitSimulationPanel } from "./CircuitSimulationPanel.js";
import { Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, Tabs, TabsContent, TabsList, TabsTrigger } from "./primitives.js";

interface CircuitPreviewDialogProps {
  open: boolean;
  partId: string | null;
  document: CircuitDocument;
  initialDocument: CircuitDocument;
  analysis: CircuitAnalysis;
  analysisProps?: Partial<CircuitAnalysisPanelProps>;
  options: CircuitAnalysisOptions;
  container: RefObject<HTMLElement | null>;
  returnFocus: RefObject<HTMLElement | SVGElement | null>;
  onOpenChange: (open: boolean) => void;
  onSelectPart: (id: string | null) => void;
  onChange: (id: string, patch: Partial<CircuitPart>) => void;
  onOptionsChange: (options: CircuitAnalysisOptions) => void;
  onReset: (partId?: string) => void;
}

/** The preview keeps experiments local; closing a dialog preserves its current values. */
export function CircuitPreviewDialog({
  open, partId, document, initialDocument, analysis, analysisProps, options, container, returnFocus,
  onOpenChange, onSelectPart, onChange, onOptionsChange, onReset,
}: CircuitPreviewDialogProps) {
  const part = document.parts.find((item) => item.id === partId);
  const changed = document.parts.filter((item) => {
    const initial = initialDocument.parts.find((candidate) => candidate.id === item.id);
    return JSON.stringify(item) !== JSON.stringify(initial);
  }).length;
  useEffect(() => {
    if (!open) { return; }
    const frame = requestAnimationFrame(() => container.current?.querySelector<HTMLElement>(".circuit-ui-dialog-title")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open, partId, container]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent container={container} finalFocus={() => { returnFocus.current?.focus({ preventScroll: true }); return false; }} className="circuit-preview-dialog">
        <header className="circuit-preview-dialog__header">
          {part && <Button variant="ghost" size="icon" aria-label="部品一覧に戻る" onClick={() => onSelectPart(null)}><CircuitIcon name="arrowLeft" /></Button>}
          <div className="circuit-preview-dialog__identity">
            {part ? <CircuitPartIcon kind={part.kind} aria-hidden="true" /> : <CircuitIcon name="sliders" aria-hidden="true" />}
            <div>
              <DialogTitle tabIndex={-1}>{part ? part.label : "解析・部品"}</DialogTitle>
              {part && part.label !== circuitPartCatalog[part.kind].name && <p className="circuit-preview-dialog__kind">{circuitPartCatalog[part.kind].name}</p>}
            </div>
          </div>
        </header>
        <DialogDescription>値を試しても編集データは変わりません。</DialogDescription>
        <div className="circuit-preview-dialog__body">
          {part ? (
            <CircuitPreviewPanel
              key={part.id}
              partId={part.id}
              document={document}
              initialDocument={initialDocument}
              analysis={analysis}
              onChange={onChange}
              onReset={() => onReset(part.id)}
            />
          ) : (
            <>
              <CircuitAnalysisPanel {...analysisProps} analysis={analysis} className={`circuit-preview-dialog__analysis ${analysisProps?.className ?? ""}`} />
              <Tabs defaultValue="parts">
                <TabsList aria-label="回路プレビューの設定">
                  <TabsTrigger value="parts">部品<span className="circuit-preview-dialog__count">{document.parts.length}</span></TabsTrigger>
                  <TabsTrigger value="analysis">解析設定</TabsTrigger>
                </TabsList>
                <TabsContent value="parts">
                  {document.parts.length > 0 ? <ul className="circuit-preview-dialog__parts">
                    {document.parts.map((item) => (
                      <li key={item.id}>
                        <Button variant="ghost" className="circuit-preview-dialog__part" onClick={() => onSelectPart(item.id)}>
                          <CircuitPartIcon kind={item.kind} aria-hidden="true" />
                          <span><strong>{item.label}</strong>{item.label !== circuitPartCatalog[item.kind].name && <small>{circuitPartCatalog[item.kind].name}</small>}</span>
                          <CircuitIcon name="arrowRight" aria-hidden="true" />
                        </Button>
                      </li>
                    ))}
                  </ul> : <p className="circuit-preview__empty">この回路にはまだ部品がありません。</p>}
                </TabsContent>
                <TabsContent value="analysis">
                  <CircuitSimulationPanel document={document} analysis={analysis} options={options} onChange={onOptionsChange} showLearningPanels={false} />
                  <p>波形と比較は、回路図下の「学習ビュー」で確認できます。</p>
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
        <footer className="circuit-preview-dialog__footer">
          {!part && <Button variant="outline" disabled={changed === 0} onClick={() => onReset()}><CircuitIcon name="undo" />すべてリセット{changed > 0 && `（${changed}部品）`}</Button>}
          <DialogClose render={<Button />}>回路に戻る</DialogClose>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
