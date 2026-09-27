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
import type { ResolvedPreviewFeatures } from "./preview-features.js";

interface CircuitPreviewDialogProps {
  open: boolean;
  partId: string | null;
  document: CircuitDocument;
  initialDocument: CircuitDocument;
  analysis: CircuitAnalysis;
  analysisProps?: Partial<CircuitAnalysisPanelProps>;
  options: CircuitAnalysisOptions;
  features: ResolvedPreviewFeatures;
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
  open, partId, document, initialDocument, analysis, analysisProps, options, features, container, returnFocus,
  onOpenChange, onSelectPart, onChange, onOptionsChange, onReset,
}: CircuitPreviewDialogProps) {
  const part = features.parts ? document.parts.find((item) => item.id === partId) : undefined;
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
    <Dialog open={open && features.dialog} onOpenChange={onOpenChange}>
      <DialogContent container={container} finalFocus={() => {
        const target = returnFocus.current?.isConnected ? returnFocus.current : container.current?.querySelector<HTMLElement>(".circuit-board__viewport");
        target?.focus({ preventScroll: true });
        return false;
      }} className="circuit-preview-dialog">
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
              {features.summary && <CircuitAnalysisPanel {...analysisProps} analysis={analysis} className={`circuit-preview-dialog__analysis ${analysisProps?.className ?? ""}`} />}
              <Tabs key={`${features.parts}-${features.analysisSettings}`} defaultValue={features.parts ? "parts" : "analysis"}>
                <TabsList aria-label="回路プレビューの設定">
                  {features.parts && <TabsTrigger value="parts">部品<span className="circuit-preview-dialog__count">{document.parts.length}</span></TabsTrigger>}
                  {features.analysisSettings && <TabsTrigger value="analysis">解析設定</TabsTrigger>}
                </TabsList>
                {features.parts && <TabsContent value="parts">
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
                </TabsContent>}
                {features.analysisSettings && <TabsContent value="analysis">
                  <CircuitSimulationPanel document={document} analysis={analysis} options={options} onChange={onOptionsChange} showLearningPanels={false} learningFeatures={features} />
                  {features.learning && <p>追加の解析は、回路図下の「学習ビュー」で確認できます。</p>}
                </TabsContent>}
              </Tabs>
            </>
          )}
        </div>
        <footer className="circuit-preview-dialog__footer">
          {!part && features.parts && <Button variant="outline" disabled={changed === 0} onClick={() => onReset()}><CircuitIcon name="undo" />すべてリセット{changed > 0 && `（${changed}部品）`}</Button>}
          <DialogClose render={<Button />}>回路に戻る</DialogClose>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
