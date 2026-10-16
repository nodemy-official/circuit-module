// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCircuitEditor } from "../useCircuitEditor.js";
import { useDocumentGestureBoundary } from "../useDocumentGestureBoundary.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

type VersionStyle = "number" | "legacy-getter" | "scoped-getter";

function mount(style: VersionStyle) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest: { editor: ReturnType<typeof useCircuitEditor>; boundary: ReturnType<typeof useDocumentGestureBoundary> } | undefined;
  function Harness() {
    const editor = useCircuitEditor({ title: "original", parts: [], wires: [] });
    const version = style === "number" ? editor.documentVersion
      : style === "legacy-getter" ? () => editor.getDocumentVersion() : editor.getDocumentVersion;
    latest = { editor, boundary: useDocumentGestureBoundary(editor.document, version) };
    return null;
  }
  act(() => root.render(<Harness />));
  mounted.push({ root, container });
  return () => {
    if (!latest) { throw new Error("Missing hook result"); }
    return latest;
  };
}

describe("document gesture version compatibility", () => {
  it.each((["number", "legacy-getter", "scoped-getter"] as const).flatMap((style) =>
    ["move", "wire-route"].map((group) => ({ style, group })),
  ))("cancels an unedited $group gesture through $style", ({ style, group }) => {
    const current = mount(style);
    const token = current().boundary.capture(`${group}:target`);
    act(() => {
      if (group === "move") { current().editor.cancelMove("target"); }
      else { current().editor.cancelWireRoute("target"); }
    });

    expect(current().boundary.isCurrent(token)).toBe(false);
    expect(current().editor.getDocumentVersion()).toBe(current().editor.documentVersion);
    expect(current().boundary.canStart()).toBe(true);
    expect(current().boundary.isCurrent(current().boundary.capture(`${group}:target`))).toBe(true);
  });

  it.each((["number", "legacy-getter", "scoped-getter"] as const).flatMap((style) =>
    ["other-id", "other-group", "global"].map((command) => ({ style, command })),
  ))("handles $command changes through $style", ({ style, command }) => {
    const current = mount(style);
    const token = current().boundary.capture("move:target");
    act(() => {
      if (command === "other-id") { current().editor.cancelMove("other"); }
      else if (command === "other-group") { current().editor.cancelWireRoute("target"); }
      else { current().editor.endEdit(); }
    });

    expect(current().boundary.isCurrent(token)).toBe(style === "scoped-getter" && command !== "global");
    expect(current().editor.getDocumentVersion()).toBe(current().editor.documentVersion);
    expect(current().boundary.canStart()).toBe(true);
  });

  it.each(["legacy-getter", "scoped-getter"] as const)("waits for a commit before starting another gesture through %s", (style) => {
    const current = mount(style);
    act(() => {
      current().editor.cancelMove("target");
      expect(current().boundary.canStart()).toBe(false);
    });
    expect(current().boundary.canStart()).toBe(true);
  });
});
