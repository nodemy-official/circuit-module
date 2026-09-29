import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createExampleCircuit } from "../../circuit-model.js";
import { CircuitEditor, useCircuitEditorContext } from "../CircuitEditor.js";

function EditorSnapshot() {
  const editor = useCircuitEditorContext();
  return createElement("output", null, `${editor.document.title}:${editor.document.parts.length}`);
}

describe("CircuitEditor provider", () => {
  it("adds no DOM around its children during server rendering", () => {
    const markup = renderToStaticMarkup(createElement(CircuitEditor, { children: null }));

    expect(markup).toBe("");
  });

  it("supports caller-defined placement and keeps sibling provider state separate", () => {
    const firstDocument = { ...createExampleCircuit(), title: "first circuit" };
    const secondDocument = { ...createExampleCircuit(), title: "second circuit", parts: [] };
    const markup = renderToStaticMarkup(
      createElement(
        "main",
        null,
        createElement(CircuitEditor, { initialDocument: firstDocument, children: createElement(EditorSnapshot) }),
        createElement(CircuitEditor, {
          initialDocument: secondDocument,
          children: (editor) => createElement("aside", null, `${editor.document.title}:${editor.document.parts.length}`),
        }),
      ),
    );

    expect(markup).toContain("<main><output>first circuit:4</output><aside>second circuit:0</aside></main>");
  });

  it("throws a clear error when its context hook is used outside a provider", () => {
    expect(() => renderToStaticMarkup(createElement(EditorSnapshot))).toThrow(
      "useCircuitEditorContext must be used within a <CircuitEditor> provider.",
    );
  });
});
