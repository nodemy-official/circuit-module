// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../../circuit-model.js";
import { CircuitEditor } from "../CircuitEditor.js";
import { CircuitEditorLayout } from "../CircuitEditorLayout.js";

const observedBoard = vi.hoisted(() => ({ documents: [] as CircuitDocument[] }));
vi.mock("../CircuitBoard.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../CircuitBoard.js")>();
  return {
    ...original,
    CircuitBoard: (props: ComponentProps<typeof original.CircuitBoard>) => {
      observedBoard.documents.push(props.document);
      return <original.CircuitBoard {...props} />;
    },
  };
});

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => {
  observedBoard.documents = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media }));
});
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) { act(() => root.unmount()); container.remove(); }
  vi.unstubAllGlobals();
});

it.each([false, true].flatMap((previewOnly) => (["resistor", "switch"] as const).map((kind) => ({ previewOnly, kind }))))
("copies, repairs, and resets an own $kind accessor without running it (previewOnly=$previewOnly)", ({ previewOnly, kind }) => {
  const part: CircuitPart = { id: "part", kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults };
  const key = kind === "switch" ? "initiallyClosed" : "resistanceOhms";
  const getter = vi.fn(() => { throw new Error("Editable setting getters must not run"); });
  Object.defineProperty(part, key, { get: getter, enumerable: true, configurable: true });
  const initialDocument = { title: "Accessor preview", parts: [part], wires: [] };
  const onDocumentChange = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(<CircuitEditor initialDocument={initialDocument} onDocumentChange={onDocumentChange}>
    <CircuitEditorLayout previewOnly={previewOnly} previewFeatures={{ learning: false, summary: false, analysisSettings: false }} />
  </CircuitEditor>));
  if (!previewOnly) { act(() => container.querySelector<HTMLButtonElement>(".circuit-editor__preview-toggle")!.click()); }
  act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__toggle")!.click());
  if (kind === "switch") {
    const toggle = container.querySelector<HTMLButtonElement>(".circuit-preview-parts__switch")!;
    expect(toggle.getAttribute("aria-invalid")).toBe("true");
    act(() => toggle.click());
    expect(toggle.hasAttribute("aria-invalid")).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__reset")!.click());
    expect(toggle.getAttribute("aria-invalid")).toBe("true");
  } else {
    act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__inspect")!.click());
    const input = container.querySelector<HTMLInputElement>('.circuit-preview__field input[type="number"]')!;
    expect(input.value).toBe("");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "10");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("10");
    expect(container.querySelector(".circuit-board__part-detail")?.textContent).toBe("10 Ω");
    act(() => container.querySelector<HTMLButtonElement>(".circuit-preview__heading button")!.click());
    expect(container.querySelector<HTMLInputElement>('.circuit-preview__field input[type="number"]')?.value).toBe("");
  }
  expect(getter).not.toHaveBeenCalled();
  expect(Object.getOwnPropertyDescriptor(part, key)?.get).toBe(getter);
  expect(onDocumentChange).not.toHaveBeenCalled();
});

it.each(["resistor", "switch"] as const)("preserves hidden frozen document fields while changing and resetting a preview %s", (kind) => {
  const part: CircuitPart = { id: "part", kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults };
  const key = kind === "switch" ? "initiallyClosed" : "resistanceOhms";
  Object.defineProperty(part, key, { value: null, enumerable: false, configurable: false, writable: false });
  Object.freeze(part);
  const metadata = { owner: "host", revision: 3 };
  const metadataGetter = vi.fn(() => { throw new Error("Unknown metadata accessors must not run"); });
  const initialDocument: CircuitDocument = {
    title: "Hidden preview document",
    parts: [part, { id: "j", kind: "junction", label: "J", x: 10, y: 0 }],
    wires: [{ id: "w", from: { partId: "part", terminal: "b" }, to: { partId: "j", terminal: "a" } }],
  };
  Object.defineProperty(initialDocument, "retained", { value: metadata, enumerable: false });
  Object.defineProperty(initialDocument, "unreadMetadata", { get: metadataGetter, enumerable: false });
  for (const field of Object.getOwnPropertyNames(initialDocument)) {
    Object.defineProperty(initialDocument, field, { enumerable: false, configurable: false });
  }
  Object.freeze(initialDocument.parts);
  Object.freeze(initialDocument.wires);
  Object.freeze(initialDocument);
  const onDocumentChange = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(<CircuitEditor initialDocument={initialDocument} onDocumentChange={onDocumentChange}>
    <CircuitEditorLayout previewOnly previewFeatures={{ learning: false, summary: false, analysisSettings: false }} />
  </CircuitEditor>));
  const latestDocument = () => {
    const value = observedBoard.documents.at(-1);
    if (!value) { throw new Error("Missing preview document"); }
    return value;
  };
  const capturedWires = latestDocument().wires;
  expect(capturedWires).not.toBe(initialDocument.wires);
  expect(capturedWires).toEqual(initialDocument.wires);
  const expectRetainedDocument = () => {
    expect(latestDocument().title).toBe(initialDocument.title);
    expect(latestDocument().wires).toBe(capturedWires);
    expect(Object.getOwnPropertyDescriptor(latestDocument(), "retained")?.value).toBe(metadata);
    expect(Object.getOwnPropertyDescriptor(latestDocument(), "unreadMetadata")?.get).toBe(metadataGetter);
    expect(container.querySelectorAll('.circuit-board__wire[data-wire-id="w"]')).toHaveLength(1);
  };
  expectRetainedDocument();
  act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__toggle")!.click());

  if (kind === "switch") {
    act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__switch")!.click());
    expect(latestDocument().parts[0]?.initiallyClosed).toBe(true);
    expectRetainedDocument();
    act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__reset")!.click());
  } else {
    act(() => container.querySelector<HTMLButtonElement>(".circuit-preview-parts__inspect")!.click());
    const input = container.querySelector<HTMLInputElement>('.circuit-preview__field input[type="number"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "22");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(latestDocument().parts[0]?.resistanceOhms).toBe(22);
    expectRetainedDocument();
    act(() => container.querySelector<HTMLButtonElement>(".circuit-preview__heading button")!.click());
  }

  expect(latestDocument().parts[0]?.[key]).toBeNull();
  expectRetainedDocument();
  expect(part[key]).toBeNull();
  expect(initialDocument.title).toBe("Hidden preview document");
  expect(metadataGetter).not.toHaveBeenCalled();
  expect(onDocumentChange).not.toHaveBeenCalled();
});

it("renders a preview-only document with a malformed own label using its part ID", () => {
  const part: CircuitPart = { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 10 };
  Object.defineProperty(part, "label", { value: null, enumerable: false, writable: false, configurable: false });
  Object.freeze(part);
  const initialDocument: CircuitDocument = { title: "Malformed label preview", parts: [part], wires: [] };
  for (const field of Object.getOwnPropertyNames(initialDocument)) {
    Object.defineProperty(initialDocument, field, { enumerable: false, configurable: false, writable: false });
  }
  Object.freeze(initialDocument.parts);
  Object.freeze(initialDocument.wires);
  Object.freeze(initialDocument);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });

  act(() => root.render(<CircuitEditor initialDocument={initialDocument}>
    <CircuitEditorLayout previewOnly previewFeatures={{ learning: false, summary: false, analysisSettings: false }} />
  </CircuitEditor>));

  expect(container.querySelector('.circuit-board__part[data-part-id="r"] .circuit-board__part-label')?.textContent).toBe("r");
  expect(part.label).toBeNull();
});
