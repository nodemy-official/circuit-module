import type { Meta, StoryObj } from "@storybook/react-vite";
import { CircuitBoard } from "../src/ui/CircuitBoard.js";
import { CircuitPalette } from "../src/ui/CircuitPalette.js";
import { CircuitInspector } from "../src/ui/CircuitInspector.js";
import { CircuitAnalysisPanel } from "../src/ui/CircuitAnalysisPanel.js";
import { useCircuitEditor } from "../src/ui/useCircuitEditor.js";
import { analyzeCircuit } from "../src/circuit-solver.js";
import { createExampleCircuit } from "../src/circuit-model.js";
import "../src/ui/editor.css";

const document = createExampleCircuit();
const analysis = analyzeCircuit(document);

const meta = {
  title: "Circuit/Parts",
  component: CircuitBoard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CircuitBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Board: Story = {
  name: "基板",
  args: { document },
};

export const Palette: Story = {
  name: "部品パレット",
  render: () => <div style={{ width: 250, padding: 18, border: "1px solid #e3e9ed" }}><CircuitPalette onAdd={() => {}} /></div>,
};

export const Inspector: Story = {
  name: "設定パネル",
  render: () => <div style={{ width: 270, padding: 18, border: "1px solid #e3e9ed" }}><CircuitInspector part={document.parts[0]} reading={analysis.parts[document.parts[0].id]} /></div>,
};

export const Analysis: Story = {
  name: "解析パネル",
  render: () => <div style={{ width: 270, padding: 18, border: "1px solid #e3e9ed" }}><CircuitAnalysisPanel analysis={analysis} partCount={document.parts.length} wireCount={document.wires.length} /></div>,
};

function CustomWorkbench() {
  const editor = useCircuitEditor();
  const selected = editor.document.parts.find((part) => part.id === editor.selection.parts[0]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 260px", gap: 20, background: "#f6f8fc", padding: 24 }}>
      <div style={{ minWidth: 0 }}>
        <CircuitAnalysisPanel analysis={editor.analysis} partCount={editor.document.parts.length} wireCount={editor.document.wires.length} />
        <CircuitBoard document={editor.document} selection={editor.selection} pendingEndpoint={editor.pendingEndpoint} onSelectPart={editor.selectPart} onSelectWire={editor.selectWire} onTerminalClick={editor.chooseTerminal} onBoardClick={editor.choosePoint} onMovePart={editor.movePart} />
      </div>
      <div style={{ background: "white", padding: 16 }}>
        <CircuitInspector part={selected} reading={selected ? editor.analysis.parts[selected.id] : undefined} onChange={editor.updatePart} onRotate={editor.rotateSelected} onDelete={editor.removeSelected} />
        <CircuitPalette onAdd={editor.add} />
      </div>
    </div>
  );
}

export const CustomLayout: Story = {
  name: "自由な組み合わせ",
  render: () => <CustomWorkbench />,
};
