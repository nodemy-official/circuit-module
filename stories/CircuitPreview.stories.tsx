import type { Meta, StoryObj } from "@storybook/react-vite";
import { createExampleCircuit } from "../src/circuit-model.js";
import { CircuitPreview } from "../src/ui/preset.js";
import "./circuit-preview-story.css";

const meta = {
  title: "Circuit/Preview",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const exampleCircuit = createExampleCircuit();

function LearningBlock({ narrow = false }: { narrow?: boolean }) {
  return (
    <main
      className={
        narrow
          ? "circuit-preview-story circuit-preview-story--width-360"
          : "circuit-preview-story"
      }
    >
      <div className="circuit-preview-story__content">
        <p className="circuit-preview-story__text">
          電池と抵抗を導線でつないだ回路です。回路図を見ながら、電気の流れを確かめましょう。
        </p>

        <figure className="circuit-preview-story__block">
          <figcaption className="circuit-preview-story__caption">
            <strong>回路</strong>
            <small>実行結果</small>
          </figcaption>
          <div className="circuit-preview-story__result">
            <CircuitPreview initialDocument={exampleCircuit} />
          </div>
        </figure>

        <p className="circuit-preview-story__text">
          スイッチを操作して回路の状態を変え、測定値の変化を見比べてみましょう。
        </p>
      </div>
    </main>
  );
}

export const Embedded: Story = {
  name: "教材ブロックへの埋め込み",
  render: () => <LearningBlock />,
};

export const Width360: Story = {
  name: "幅360px",
  render: () => <LearningBlock narrow />,
};

export const Dark: Story = {
  name: "ダークテーマ",
  globals: { theme: "dark" },
  render: () => <LearningBlock />,
};
