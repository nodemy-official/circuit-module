import { describe, expect, it } from "vitest";

import { boardSize, contentBounds, routeDocumentWires } from "../circuit-geometry.js";
import type { CircuitDocument } from "../circuit-model.js";

describe("rendered circuit bounds", () => {
  it("includes automatic detours when many wires share one terminal", () => {
    const document: CircuitDocument = {
      title: "自動配線の全体表示",
      parts: Array.from({ length: 21 }, (_, index) => ({
        id: `part-${index}`, kind: "junction", x: index * 3, y: 0, label: "J",
      })),
      wires: Array.from({ length: 20 }, (_, index) => ({
        id: `wire-${index}`,
        from: { partId: "part-0", terminal: "a" },
        to: { partId: `part-${index + 1}`, terminal: "a" },
      })),
    };
    const points = [...routeDocumentWires(document).values()].flat();
    expect(points.some((point) => Math.abs(point.y) > 4.5)).toBe(true);
    const bounds = contentBounds(document)!;
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(point.x).toBeLessThanOrEqual(bounds.maxX);
      expect(point.y).toBeGreaterThanOrEqual(bounds.minY);
      expect(point.y).toBeLessThanOrEqual(bounds.maxY);
    }
    const board = boardSize(document);
    expect(board.columns).toBeGreaterThanOrEqual(bounds.maxX - bounds.minX + 8);
    expect(board.rows).toBeGreaterThanOrEqual(bounds.maxY - bounds.minY + 6);
  });
});
