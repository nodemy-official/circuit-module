import type { Meta, StoryObj } from "@storybook/react-vite";
import { CircuitEditor } from "../src/ui/CircuitEditor.js";
import { createExampleCircuit, type CircuitDocument } from "../src/circuit-model.js";

const meta = {
  title: "Circuit/Editor",
  component: CircuitEditor,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CircuitEditor>;

export default meta;
type Story = StoryObj<typeof meta>;
const exampleCircuit = createExampleCircuit();

const shortCircuitDocument: CircuitDocument = {
  title: "短絡の確認",
  parts: [{
    id: "battery-1",
    kind: "battery",
    x: 10,
    y: 8,
    label: "電池",
    voltageVolts: 9,
    internalResistanceOhms: 0,
  }, {
    id: "junction-left",
    kind: "junction",
    x: 5,
    y: 12,
    label: "接続点1",
  }, {
    id: "junction-right",
    kind: "junction",
    x: 15,
    y: 12,
    label: "接続点2",
  }],
  wires: [
    {
      id: "wire-1",
      from: { partId: "battery-1", terminal: "a" },
      to: { partId: "junction-left", terminal: "a" },
    },
    {
      id: "wire-2",
      from: { partId: "junction-left", terminal: "a" },
      to: { partId: "junction-right", terminal: "a" },
    },
    {
      id: "wire-3",
      from: { partId: "junction-right", terminal: "a" },
      to: { partId: "battery-1", terminal: "b" },
    },
  ],
};

export const Interactive: Story = {
  name: "回路エディター",
};

export const OpenCircuit: Story = {
  name: "開回路",
  args: {
    initialDocument: {
      ...exampleCircuit,
      title: "スイッチを開いた回路",
      parts: exampleCircuit.parts.map((part) =>
        part.kind === "switch" ? { ...part, initiallyClosed: false } : part,
      ),
    },
  },
};

export const EmptyCircuit: Story = {
  name: "空の回路",
  args: {
    initialDocument: { title: "空の回路", parts: [], wires: [] },
  },
};

export const ShortCircuit: Story = {
  name: "短絡",
  args: { initialDocument: shortCircuitDocument },
};
