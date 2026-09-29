import { describe, expect, it } from "vitest";

import { cameraLabelSizes, createCameraFrame, MAX_ZOOM, MIN_ZOOM, zoomCameraAt, type BoardCamera } from "../board-camera.js";

function fakeFrames() {
  let nextId = 1;
  const pending = new Map<number, FrameRequestCallback>();

  return {
    requestFrame(callback: FrameRequestCallback) {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    },
    cancelFrame(id: number) {
      pending.delete(id);
    },
    flushNext() {
      const next = pending.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!next) { throw new Error("No frame is pending"); }
      const [id, callback] = next;
      pending.delete(id);
      callback(16);
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

const worldAt = (camera: BoardCamera, pointer: { x: number; y: number }) => ({
  x: camera.x + pointer.x / camera.zoom,
  y: camera.y + pointer.y / camera.zoom,
});

describe("board camera", () => {
  it("keeps the world point under the pointer fixed while zooming", () => {
    const camera = { x: 120, y: -48, zoom: 0.8 };
    const pointer = { x: 237, y: 119 };

    expect(worldAt(zoomCameraAt(camera, 1.65, pointer), pointer)).toEqual(worldAt(camera, pointer));
  });

  it.each([
    [0.1, MIN_ZOOM],
    [9, MAX_ZOOM],
  ])("keeps the pointer anchor fixed when zoom is clamped to %s", (requestedZoom, clampedZoom) => {
    const camera = { x: -21, y: 73, zoom: 1.4 };
    const pointer = { x: 311, y: 86 };
    const result = zoomCameraAt(camera, requestedZoom, pointer);

    expect(result.zoom).toBe(clampedZoom);
    const beforeWorld = worldAt(camera, pointer);
    const afterWorld = worldAt(result, pointer);
    expect(afterWorld.x).toBeCloseTo(beforeWorld.x, 10);
    expect(afterWorld.y).toBeCloseTo(beforeWorld.y, 10);
  });

  it("applies every fine zoom delta in a frame and paints only the latest camera", () => {
    const frames = fakeFrames();
    const painted: BoardCamera[] = [];
    const queue = createCameraFrame((nextCamera) => painted.push(nextCamera), frames.requestFrame, frames.cancelFrame);
    const pointer = { x: 180, y: 95 };
    let camera: BoardCamera = { x: 30, y: 12, zoom: 1 };
    const deltas = Array.from({ length: 240 }, () => 0.002);

    for (const delta of deltas) {
      camera = zoomCameraAt(camera, camera.zoom * Math.exp(delta), pointer);
      queue.queue(camera);
    }

    expect(frames.pendingCount).toBe(1);
    expect(painted).toEqual([]);
    frames.flushNext();

    expect(painted).toEqual([camera]);
    expect(camera.zoom).toBeCloseTo(Math.exp(deltas.reduce((sum, delta) => sum + delta, 0)));
    expect(camera.zoom).not.toBeCloseTo(zoomCameraAt({ x: 30, y: 12, zoom: 1 }, Math.exp(deltas.at(-1)!), pointer).zoom);
    expect(frames.pendingCount).toBe(0);
  });

  it("reflects input queued for the frame after a paint", () => {
    const frames = fakeFrames();
    const painted: BoardCamera[] = [];
    const queue = createCameraFrame((camera) => painted.push(camera), frames.requestFrame, frames.cancelFrame);
    const first = { x: 0, y: 0, zoom: 1 };
    const second = { x: 18, y: -7, zoom: 1.2 };

    queue.queue(first);
    frames.flushNext();
    queue.queue(second);
    expect(frames.pendingCount).toBe(1);
    frames.flushNext();

    expect(painted).toEqual([first, second]);
  });

  it("cancels pending paint and accepts a later queued camera", () => {
    const frames = fakeFrames();
    const painted: BoardCamera[] = [];
    const queue = createCameraFrame((camera) => painted.push(camera), frames.requestFrame, frames.cancelFrame);
    const canceled = { x: 1, y: 2, zoom: 1.1 };
    const next = { x: 3, y: 4, zoom: 0.9 };

    queue.queue(canceled);
    queue.cancel();
    expect(frames.pendingCount).toBe(0);
    expect(painted).toEqual([]);

    queue.queue(next);
    frames.flushNext();
    expect(painted).toEqual([next]);
  });

  it("keeps label sizing continuous across the 55% zoom threshold", () => {
    const before = cameraLabelSizes(0.549);
    const after = cameraLabelSizes(0.551);

    expect(Math.abs(after.label - before.label)).toBeLessThan(0.1);
    expect(Math.abs(after.detail - before.detail)).toBeLessThan(0.1);
  });

  it("keeps label sizes bounded at both zoom limits", () => {
    expect(cameraLabelSizes(MIN_ZOOM)).toEqual({ label: 20, detail: 18 });
    expect(cameraLabelSizes(MAX_ZOOM)).toEqual({ label: 10, detail: 9 });
  });
});
