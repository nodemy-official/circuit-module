// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GRID, routeDocumentWires, type Point } from "../../circuit-geometry.js";
import { createExampleCircuit, endpointName, type CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis } from "../../circuit-solver.js";
import { CircuitBoard } from "../CircuitBoard.js";
import { CircuitEditor } from "../CircuitEditor.js";
import { CircuitEditorLayout } from "../CircuitEditorLayout.js";
import { CircuitWireFlow } from "../CircuitFlow.js";

const circuit = createExampleCircuit();
const closedAnalysis = analyzeCircuit(circuit);
const directionalCircuit: CircuitDocument = {
  title: "正負の流れ",
  parts: [
    { id: "battery", kind: "battery", x: 2, y: 5, label: "電池", voltageVolts: 9 },
    { id: "resistor", kind: "resistor", x: 10, y: 5, label: "抵抗", resistanceOhms: 10 },
  ],
  wires: [
    { id: "wire-out", from: { partId: "battery", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
    { id: "wire-return", from: { partId: "battery", terminal: "b" }, to: { partId: "resistor", terminal: "b" } },
  ],
};
const directionalAnalysis = analyzeCircuit(directionalCircuit);

const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
const actEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false; },
    }),
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  if (matchMediaDescriptor) { Object.defineProperty(window, "matchMedia", matchMediaDescriptor); }
  else { Reflect.deleteProperty(window, "matchMedia"); }
  if (actEnvironmentDescriptor) { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironmentDescriptor); }
  else { Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); }
  vi.unstubAllGlobals();
});

function staticBoard(document: CircuitDocument, analysis?: CircuitAnalysis, showFlow?: boolean) {
  return renderToStaticMarkup(
    <CircuitBoard
      document={document}
      {...(analysis ? { analysis } : {})}
      {...(showFlow === undefined ? {} : { showFlow })}
      renderControls={null}
    />,
  );
}

function parseMarkup(markup: string) {
  const container = document.createElement("div");
  container.innerHTML = markup;
  return container;
}

function flow(container: ParentNode, wireId: string, kind: "current" | "electron") {
  return container.querySelector<SVGGElement>(
    `.circuit-board__wire[data-wire-id="${wireId}"] .circuit-board__flow[data-flow="${kind}"]`,
  );
}

function requiredFlow(container: ParentNode, wireId: string, kind: "current" | "electron") {
  const target = flow(container, wireId, kind);
  if (!target) { throw new Error(`Missing ${kind} flow on wire ${wireId}`); }
  return target;
}

function motionPathStart(flowTrack: Element): Point {
  const path = motionPathData(flowTrack);
  const startMatch = /^\s*M\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s+(-?(?:\d+(?:\.\d*)?|\.\d+))/i.exec(path);
  if (!startMatch[1] || !startMatch[2]) { throw new Error(`Flow motion path has no start point: ${path}`); }
  return { x: Number(startMatch[1]), y: Number(startMatch[2]) };
}

function motionPathData(flowTrack: Element) {
  const particle = flowTrack.querySelector(".circuit-board__flow-particle");
  if (!particle) { throw new Error("Flow track has no animated particle"); }
  const style = particle.getAttribute("style") ?? "";
  const pathMatch = /offset-path:\s*path\(\s*(['"])(.*?)\1\s*\)/i.exec(style);
  if (!pathMatch[2]) { throw new Error(`Flow particle is missing its CSS motion path: ${style}`); }
  return pathMatch[2];
}

function renderFlowPath(route: readonly Point[], current: number) {
  const markup = renderToStaticMarkup(
    <svg aria-hidden="true"><CircuitWireFlow route={route} current={current} display="current" /></svg>,
  );
  const container = parseMarkup(markup);
  const track = container.querySelector('.circuit-board__flow[data-flow="current"]');
  if (!track) { throw new Error("Missing current flow track"); }
  return motionPathData(track);
}

function quadraticJoinVectors(path: string): [Point, Point][] {
  const values = path.match(/-?(?:\d+(?:\.\d*)?|\.\d+)/g)?.map(Number) ?? [];
  if (values.length !== 10) { throw new Error(`Expected one quadratic corner in flow path: ${path}`); }
  const [startX, startY, entryX, entryY, controlX, controlY, exitX, exitY, endX, endY] = values as [
    number, number, number, number, number, number, number, number, number, number,
  ];
  return [
    [
      { x: entryX - startX, y: entryY - startY },
      { x: controlX - entryX, y: controlY - entryY },
    ],
    [
      { x: exitX - controlX, y: exitY - controlY },
      { x: endX - exitX, y: endY - exitY },
    ],
  ];
}

function flowDirections(container: ParentNode, wireId: string) {
  return {
    current: requiredFlow(container, wireId, "current").getAttribute("data-direction"),
    electron: requiredFlow(container, wireId, "electron").getAttribute("data-direction"),
  };
}

function motionPathStarts(container: ParentNode, document: CircuitDocument, wireId: string, current: number) {
  const route = routeDocumentWires(document).get(wireId);
  if (!route?.length) { throw new Error(`Missing route for wire ${wireId}`); }
  const from = route[0];
  const to = route.at(-1);
  if (!from || !to) { throw new Error(`Incomplete route for wire ${wireId}`); }
  const currentStart = current > 0 ? from : to;
  const electronStart = current > 0 ? to : from;
  return {
    current: motionPathStart(requiredFlow(container, wireId, "current")),
    electron: motionPathStart(requiredFlow(container, wireId, "electron")),
    expectedCurrent: { x: currentStart.x * GRID, y: currentStart.y * GRID },
    expectedElectron: { x: electronStart.x * GRID, y: electronStart.y * GRID },
  };
}

function mount(element: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

function mockFlowMotion() {
  let offsetDistance = "10%";
  let nextFrameId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  });
  const cancelAnimationFrame = vi.fn((id: number) => { frames.delete(id); });
  const getComputedStyle = vi.fn((element: Element) => ({
    offsetDistance: element.classList.contains("circuit-board__flow-particle") ? offsetDistance : "",
    getPropertyValue: (property: string) => property === "--circuit-board-flow-scale" ? "1" : "",
  }) as CSSStyleDeclaration);

  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
  vi.stubGlobal("getComputedStyle", getComputedStyle);

  return {
    requestAnimationFrame,
    cancelAnimationFrame,
    setOffsetDistance(value: string) { offsetDistance = value; },
    advanceFrame() {
      const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!next) { throw new Error("No animation frame is queued"); }
      const [id, callback] = next;
      frames.delete(id);
      act(() => callback(0));
    },
    pendingFrameCount() { return frames.size; },
  };
}

function unmount(container: HTMLElement) {
  const index = mounted.findIndex((entry) => entry.container === container);
  if (index < 0) { throw new Error("Mounted container was lost"); }
  const [{ root }] = mounted.splice(index, 1);
  act(() => root.unmount());
  container.remove();
}

function required(container: ParentNode, selector: string): HTMLElement {
  const target = container.querySelector<HTMLElement>(selector);
  if (!target) { throw new Error(`Missing element: ${selector}`); }
  return target;
}

function click(target: Element) {
  act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

function selectFlowDisplay(container: ParentNode, value: "current" | "electron" | "both") {
  const radio = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`);
  if (!radio) { throw new Error(`Missing flow display radio: ${value}`); }
  act(() => radio.click());
  return radio;
}

function flowDisplayKey(container: ParentNode, kind: "current" | "electron") {
  return container.querySelector(`.circuit-board__flow-key[data-flow="${kind}"]`);
}

describe("Circuit flow preview", () => {
  it("deforms the current arrow with its CSS path position and preserves its shape when position is unchanged", () => {
    const motion = mockFlowMotion();
    const route = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }];
    const container = mount(<svg aria-hidden="true"><CircuitWireFlow route={route} current={1} display="current" /></svg>);
    const arrow = required(container, ".circuit-board__current-arrow");

    const beforeBend = arrow.getAttribute("d");
    motion.setOffsetDistance("50%");
    motion.advanceFrame();
    const onBend = arrow.getAttribute("d");
    expect(onBend).not.toBe(beforeBend);

    motion.advanceFrame();
    expect(arrow.getAttribute("d")).toBe(onBend);

    motion.setOffsetDistance("90%");
    motion.advanceFrame();
    expect(arrow.getAttribute("d")).not.toBe(onBend);
  });

  it("cancels the queued shape update when the flow unmounts", () => {
    const motion = mockFlowMotion();
    const route = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }];
    const container = mount(<svg aria-hidden="true"><CircuitWireFlow route={route} current={1} display="current" /></svg>);
    const pendingFrame = motion.requestAnimationFrame.mock.results.at(-1)?.value;
    expect(motion.pendingFrameCount()).toBe(1);
    expect(pendingFrame).toBeDefined();

    unmount(container);

    expect(motion.cancelAnimationFrame).toHaveBeenCalledWith(pendingFrame);
    expect(motion.pendingFrameCount()).toBe(0);
  });

  it("rounds flow turns with aligned tangents in both directions", () => {
    const route = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }];
    const forward = renderFlowPath(route, 1);
    const reverse = renderFlowPath(route, -1);

    expect(forward).toBe("M 0 0 L 48 0 Q 60 0 60 12 L 60 40");
    expect(reverse).toBe("M 60 40 L 60 12 Q 60 0 48 0 L 0 0");
    for (const [first, second] of [...quadraticJoinVectors(forward), ...quadraticJoinVectors(reverse)]) {
      expect(first.x * second.y - first.y * second.x).toBeCloseTo(0);
      expect(first.x * second.x + first.y * second.y).toBeGreaterThan(0);
    }
  });

  it("keeps adjacent short-corner trims within their shared segment", () => {
    const route = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 0.25 },
      { x: 3, y: 0.25 },
      { x: 4, y: 0.25 },
    ];

    expect(renderFlowPath(route, 1)).toBe(
      "M 0 0 L 37.5 0 Q 40 0 40 2.5 L 40 2.5 Q 40 5 42.5 5 L 60 5 L 80 5",
    );
  });

  it("retains a collinear reversal in the particle path", () => {
    expect(renderFlowPath([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 0 }], 1))
      .toBe("M 0 0 L 40 0 L 0 0");
  });

  it("maps signed wire current to opposing electron flow along each route", () => {
    expect(directionalAnalysis.status).toBe("closed");
    const markup = mount(<CircuitBoard document={directionalCircuit} analysis={directionalAnalysis} showFlow renderControls={null} />);
    selectFlowDisplay(markup, "both");
    const positiveWire = directionalCircuit.wires.find((wire) => (directionalAnalysis.wireCurrents[wire.id] ?? 0) > 0);
    const negativeWire = directionalCircuit.wires.find((wire) => (directionalAnalysis.wireCurrents[wire.id] ?? 0) < 0);
    expect(positiveWire).toBeDefined();
    expect(negativeWire).toBeDefined();
    expect(markup.querySelector(".circuit-board__flow-legend")).not.toBeNull();

    for (const wire of [positiveWire, negativeWire]) {
      if (!wire) { throw new Error("Expected wires with both current signs"); }
      const current = directionalAnalysis.wireCurrents[wire.id];
      if (current === undefined) { throw new Error(`Missing current for wire ${wire.id}`); }
      expect(flowDirections(markup, wire.id)).toEqual({
        current: current > 0 ? "forward" : "reverse",
        electron: current > 0 ? "reverse" : "forward",
      });
      const paths = motionPathStarts(markup, directionalCircuit, wire.id, current);
      expect(paths.current).toEqual(paths.expectedCurrent);
      expect(paths.electron).toEqual(paths.expectedElectron);
    }
  });

  it("reverses animation direction when a wire's endpoints are swapped", () => {
    const originalWire = directionalCircuit.wires.find((wire) => (directionalAnalysis.wireCurrents[wire.id] ?? 0) > 0);
    if (!originalWire) { throw new Error("Example circuit has no positive wire current"); }
    const reversedDocument: CircuitDocument = {
      ...directionalCircuit,
      wires: directionalCircuit.wires.map((wire) => wire.id === originalWire.id
        ? { ...wire, from: wire.to, to: wire.from }
        : wire),
    };
    const reversedAnalysis = analyzeCircuit(reversedDocument);
    const originalCurrent = directionalAnalysis.wireCurrents[originalWire.id];
    const reversedCurrent = reversedAnalysis.wireCurrents[originalWire.id];
    expect(reversedAnalysis.status).toBe("closed");
    expect(originalCurrent).toBeDefined();
    expect(reversedCurrent).toBeCloseTo(-(originalCurrent ?? 0));

    const markup = mount(<CircuitBoard document={reversedDocument} analysis={reversedAnalysis} showFlow renderControls={null} />);
    selectFlowDisplay(markup, "both");
    expect(flowDirections(markup, originalWire.id)).toEqual({
      current: (reversedCurrent ?? 0) > 0 ? "forward" : "reverse",
      electron: (reversedCurrent ?? 0) > 0 ? "reverse" : "forward",
    });
    const paths = motionPathStarts(markup, reversedDocument, originalWire.id, reversedCurrent ?? 0);
    expect(paths.current).toEqual(paths.expectedCurrent);
    expect(paths.electron).toEqual(paths.expectedElectron);
  });

  it("omits zero-current branches and ignores missing, invalid, or non-finite analysis", () => {
    const branchedCircuit: CircuitDocument = {
      ...circuit,
      parts: [
        ...circuit.parts,
        { id: "branch", kind: "junction", x: 26, y: 5, label: "分岐" },
        { id: "open-resistor", kind: "resistor", x: 32, y: 5, label: "開放抵抗", resistanceOhms: 10 },
      ],
      wires: [
        ...circuit.wires,
        { id: "branch-wire-a", from: { partId: "part-2", terminal: "b" }, to: { partId: "branch", terminal: "a" } },
        { id: "branch-wire-b", from: { partId: "branch", terminal: "a" }, to: { partId: "open-resistor", terminal: "a" } },
      ],
    };
    const branchedAnalysis = analyzeCircuit(branchedCircuit);
    const branchMarkup = parseMarkup(staticBoard(branchedCircuit, branchedAnalysis, true));
    expect(branchedAnalysis.status).toBe("closed");
    expect(branchedAnalysis.wireCurrents["branch-wire-a"]).toBe(0);
    expect(branchedAnalysis.wireCurrents["branch-wire-b"]).toBe(0);
    expect(flow(branchMarkup, "branch-wire-a", "current")).toBeNull();
    expect(flow(branchMarkup, "branch-wire-b", "electron")).toBeNull();
    expect(branchMarkup.querySelectorAll(".circuit-board__flow").length).toBeGreaterThan(0);

    expect(parseMarkup(staticBoard(circuit, closedAnalysis)).querySelector(".circuit-board__flow")).toBeNull();
    expect(parseMarkup(staticBoard(circuit, undefined, true)).querySelector(".circuit-board__flow")).toBeNull();

    for (const status of ["open", "short", "invalid"] as const) {
      const unavailable = { ...closedAnalysis, status };
      expect(parseMarkup(staticBoard(circuit, unavailable, true)).querySelector(".circuit-board__flow")).toBeNull();
    }

    const noFiniteCurrent: CircuitAnalysis = {
      ...closedAnalysis,
      wireCurrents: Object.fromEntries(circuit.wires.map((wire, index) => [
        wire.id,
        [0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY][index] ?? 0,
      ])),
    };
    expect(parseMarkup(staticBoard(circuit, noFiniteCurrent, true)).querySelector(".circuit-board__flow")).toBeNull();
  });

  it("explains when wire currents are unavailable instead of reporting zero flow", () => {
    const acAnalysis: CircuitAnalysis = { ...closedAnalysis, mode: "ac", wireCurrents: {} };
    const dcWithoutWireCurrents: CircuitAnalysis = { ...closedAnalysis, mode: "dc", wireCurrents: {} };
    const acMarkup = parseMarkup(staticBoard(circuit, acAnalysis, true));
    const dcMarkup = parseMarkup(staticBoard(circuit, dcWithoutWireCurrents, true));

    expect(acMarkup.querySelector(".circuit-board__flow")).toBeNull();
    expect(acMarkup.querySelector(".circuit-board__flow-note")?.textContent).toContain("交流解析では導線電流を算出していない");
    expect(dcMarkup.querySelector(".circuit-board__flow-note")?.textContent).toContain("導線電流が未計算");
  });

  it("pauses and resumes the particle animation from the accessible control", () => {
    const container = mount(<CircuitBoard document={directionalCircuit} analysis={directionalAnalysis} showFlow renderControls={null} />);
    const board = required(container, ".circuit-board");
    expect(board.getAttribute("data-flow-paused")).toBe("false");
    const pause = required(container, '[aria-label="流れのアニメーションを一時停止"]');
    click(pause);
    expect(board.getAttribute("data-flow-paused")).toBe("true");
    expect(required(container, '[aria-label="流れのアニメーションを再生"]').getAttribute("aria-pressed")).toBe("true");
    selectFlowDisplay(container, "electron");
    expect(board.getAttribute("data-flow-display")).toBe("electron");
    expect(board.getAttribute("data-flow-paused")).toBe("true");
    click(required(container, '[aria-label="流れのアニメーションを再生"]'));
    expect(board.getAttribute("data-flow-paused")).toBe("false");
    expect(board.getAttribute("data-flow-display")).toBe("electron");
  });

  it("selects current, electron, or both tracks and updates wire descriptions", () => {
    const container = mount(<CircuitBoard document={directionalCircuit} analysis={directionalAnalysis} showFlow renderControls={null} />);
    const board = required(container, ".circuit-board");
    const fieldset = required(container, ".circuit-board__flow-legend fieldset");
    expect(fieldset.querySelector("legend")?.textContent).toBe("表示する向き");
    expect(board.getAttribute("data-flow-display")).toBe("current");

    for (const [value, label] of [["current", "電流のみ"], ["electron", "電子のみ"], ["both", "両方"]] as const) {
      const radio = fieldset.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`);
      expect(radio).not.toBeNull();
      expect(radio?.labels?.[0]?.textContent).toContain(label);
    }
    expect(fieldset.querySelector<HTMLInputElement>('input[type="radio"][value="current"]')?.checked).toBe(true);
    expect(flowDisplayKey(container, "current")).not.toBeNull();
    expect(flowDisplayKey(container, "electron")).toBeNull();

    const wire = directionalCircuit.wires.find((candidate) => (directionalAnalysis.wireCurrents[candidate.id] ?? 0) > 0);
    if (!wire) { throw new Error("Example circuit has no positive wire current"); }
    const current = directionalAnalysis.wireCurrents[wire.id];
    if (current === undefined) { throw new Error(`Missing current for wire ${wire.id}`); }
    const from = directionalCircuit.parts.find((part) => part.id === wire.from.partId);
    const to = directionalCircuit.parts.find((part) => part.id === wire.to.partId);
    if (!from || !to) { throw new Error(`Missing part for wire ${wire.id}`); }
    const fromName = endpointName(from, wire.from.terminal);
    const toName = endpointName(to, wire.to.terminal);
    const source = current > 0 ? fromName : toName;
    const destination = current > 0 ? toName : fromName;
    const wireElement = () => required(container, `.circuit-board__wire[data-wire-id="${wire.id}"]`);
    const wireName = `${fromName} と ${toName} をつなぐ導線`;

    expect(flow(container, wire.id, "current")).not.toBeNull();
    expect(flow(container, wire.id, "electron")).toBeNull();
    expect(wireElement().getAttribute("aria-label")).toBe(
      `${wireName}。電流は${source}から${destination}へ流れます`,
    );

    selectFlowDisplay(container, "current");
    expect(board.getAttribute("data-flow-display")).toBe("current");
    expect(flow(container, wire.id, "current")).not.toBeNull();
    expect(container.querySelector('.circuit-board__flow[data-flow="electron"]')).toBeNull();
    expect(flowDisplayKey(container, "current")).not.toBeNull();
    expect(flowDisplayKey(container, "electron")).toBeNull();
    expect(wireElement().getAttribute("aria-label")).toBe(`${wireName}。電流は${source}から${destination}へ流れます`);

    selectFlowDisplay(container, "electron");
    expect(board.getAttribute("data-flow-display")).toBe("electron");
    expect(container.querySelector('.circuit-board__flow[data-flow="current"]')).toBeNull();
    expect(flow(container, wire.id, "electron")).not.toBeNull();
    expect(flowDisplayKey(container, "current")).toBeNull();
    expect(flowDisplayKey(container, "electron")).not.toBeNull();
    expect(wireElement().getAttribute("aria-label")).toBe(`${wireName}。電子は${destination}から${source}へ流れます`);

    selectFlowDisplay(container, "both");
    expect(board.getAttribute("data-flow-display")).toBe("both");
    expect(flow(container, wire.id, "current")).not.toBeNull();
    expect(flow(container, wire.id, "electron")).not.toBeNull();
  });

  it("allows selecting a flow while the circuit is open and uses it after current resumes", () => {
    const openAnalysis: CircuitAnalysis = { ...directionalAnalysis, status: "open" };
    const container = mount(<CircuitBoard document={directionalCircuit} analysis={openAnalysis} showFlow renderControls={null} />);
    const board = required(container, ".circuit-board");

    selectFlowDisplay(container, "electron");
    expect(board.getAttribute("data-flow-display")).toBe("electron");
    expect(container.querySelector(".circuit-board__flow")).toBeNull();

    const mountedRoot = mounted.find((item) => item.container === container)?.root;
    if (!mountedRoot) { throw new Error("Mounted circuit board root was lost"); }
    act(() => mountedRoot.render(
      <CircuitBoard document={directionalCircuit} analysis={directionalAnalysis} showFlow renderControls={null} />,
    ));

    expect(board.getAttribute("data-flow-display")).toBe("electron");
    expect(container.querySelector('.circuit-board__flow[data-flow="current"]')).toBeNull();
    expect(container.querySelector('.circuit-board__flow[data-flow="electron"]')).not.toBeNull();
  });

  it("shows flow only during preview simulation and leaves the editor document unchanged", () => {
    const initialDocument = createExampleCircuit();
    let latestDocument: CircuitDocument | undefined;
    const container = mount(
      <CircuitEditor initialDocument={initialDocument}>
        {(editor) => {
          latestDocument = editor.document;
          return <CircuitEditorLayout boardProps={{ renderControls: null }} />;
        }}
      </CircuitEditor>,
    );
    const previewToggle = () => required(container, ".circuit-editor__preview-toggle");

    expect(container.querySelector(".circuit-board__flow")).toBeNull();
    click(previewToggle());
    expect(required(container, '.circuit-editor__canvas .circuit-board__flow[data-flow="current"]')).not.toBeNull();
    expect(container.querySelector('.circuit-editor__canvas .circuit-board__flow[data-flow="electron"]')).toBeNull();

    const switchPart = required(container, '.circuit-board__part[data-part-id="part-4"]');
    click(switchPart);
    expect(container.querySelector(".circuit-board__flow")).toBeNull();
    click(required(container, '.circuit-board__part[data-part-id="part-4"]'));
    expect(container.querySelector(".circuit-board__flow")).not.toBeNull();

    click(previewToggle());
    expect(container.querySelector(".circuit-board__flow")).toBeNull();
    expect(latestDocument).toEqual(initialDocument);
  });
});
