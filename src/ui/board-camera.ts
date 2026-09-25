import type { Point } from "../circuit-geometry.js";

export interface BoardCamera {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;

/** Keep the world position underneath a viewport-relative pointer fixed. */
export function zoomCameraAt(camera: BoardCamera, nextZoom: number, pointer: Point): BoardCamera {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  return {
    x: camera.x + pointer.x / camera.zoom - pointer.x / zoom,
    y: camera.y + pointer.y / camera.zoom - pointer.y / zoom,
    zoom,
  };
}

/** Preserve readable labels without a size jump when crossing the low-zoom threshold. */
export function cameraLabelSizes(zoom: number) {
  return {
    label: Math.min(20, Math.max(10, 11 / zoom)),
    detail: Math.min(18, Math.max(9, 10 / zoom)),
  };
}

/** Commit the latest camera once per display frame, without delaying or dropping input deltas. */
export function createCameraFrame(
  paint: (camera: BoardCamera) => void,
  requestFrame: (callback: FrameRequestCallback) => number = (callback) => requestAnimationFrame(callback),
  cancelFrame: (id: number) => void = (id) => cancelAnimationFrame(id),
) {
  let frame: number | null = null;
  let latest: BoardCamera | null = null;
  return {
    queue(camera: BoardCamera) {
      latest = camera;
      if (frame !== null) { return; }
      frame = requestFrame(() => {
        frame = null;
        const next = latest;
        latest = null;
        if (next) { paint(next); }
      });
    },
    cancel() {
      if (frame !== null) { cancelFrame(frame); }
      frame = null;
      latest = null;
    },
  };
}
