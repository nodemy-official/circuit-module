import { describe, expect, it } from "vitest";
import { createFlowPath, flowArrowPath } from "./flow-geometry.js";

function pointIsClose(actual: { x: number; y: number }, expected: { x: number; y: number }, tolerance = 0.000_01) {
  return Math.hypot(actual.x - expected.x, actual.y - expected.y) <= tolerance;
}

function arrowPoints(pathData: string) {
  const points: Array<{ x: number; y: number }> = [];
  for (const match of pathData.matchAll(/(?:M|L)\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s+(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi)) {
    if (!match[1] || !match[2]) { continue; }
    points.push({ x: Number(match[1]), y: Number(match[2]) });
  }
  return points;
}

function hasSelfIntersection(points: readonly { x: number; y: number }[]) {
  const cross = (first: { x: number; y: number }, second: { x: number; y: number }, third: { x: number; y: number }) =>
    (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  const onSegment = (first: { x: number; y: number }, second: { x: number; y: number }, point: { x: number; y: number }) =>
    Math.abs(cross(first, second, point)) < 0.0001 &&
    point.x >= Math.min(first.x, second.x) - 0.0001 && point.x <= Math.max(first.x, second.x) + 0.0001 &&
    point.y >= Math.min(first.y, second.y) - 0.0001 && point.y <= Math.max(first.y, second.y) + 0.0001;

  for (let firstIndex = 0; firstIndex < points.length; firstIndex++) {
    const firstStart = points[firstIndex];
    const firstEnd = points[(firstIndex + 1) % points.length];
    if (!firstStart || !firstEnd) { continue; }
    for (let secondIndex = firstIndex + 2; secondIndex < points.length; secondIndex++) {
      if (firstIndex === 0 && secondIndex === points.length - 1) { continue; }
      const secondStart = points[secondIndex];
      const secondEnd = points[(secondIndex + 1) % points.length];
      if (!secondStart || !secondEnd) { continue; }
      const firstA = cross(firstStart, firstEnd, secondStart);
      const firstB = cross(firstStart, firstEnd, secondEnd);
      const secondA = cross(secondStart, secondEnd, firstStart);
      const secondB = cross(secondStart, secondEnd, firstEnd);
      if ((firstA > 0.0001 && firstB < -0.0001 || firstA < -0.0001 && firstB > 0.0001) &&
          (secondA > 0.0001 && secondB < -0.0001 || secondA < -0.0001 && secondB > 0.0001)) { return true; }
      if (onSegment(firstStart, firstEnd, secondStart) || onSegment(firstStart, firstEnd, secondEnd) ||
          onSegment(secondStart, secondEnd, firstStart) || onSegment(secondStart, secondEnd, firstEnd)) { return true; }
    }
  }
  return false;
}

const arrowVertices = [
  { x: -8, y: -8 },
  { x: -1, y: -8 },
  { x: -1, y: -11 },
  { x: 6, y: -6 },
  { x: -1, y: -1 },
  { x: -1, y: -4 },
  { x: -8, y: -4 },
];

describe("flow geometry", () => {
  it("reproduces the rounded 12px quadratic route in either direction", () => {
    const route = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }];
    const forward = createFlowPath(route);
    const reverse = createFlowPath([...route].reverse());

    expect(forward.data).toBe("M 0 0 L 48 0 Q 60 0 60 12 L 60 40");
    expect(reverse.data).toBe("M 60 40 L 60 12 Q 60 0 48 0 L 0 0");
    expect(forward.length).toBeGreaterThan(94);
    expect(forward.length).toBeLessThan(96);
    expect(pointIsClose(forward.sample(0), { x: 0, y: 0 })).toBe(true);
    expect(pointIsClose(forward.sample(forward.length), { x: 60, y: 40 })).toBe(true);
    expect(pointIsClose(reverse.sample(0), { x: 60, y: 40 })).toBe(true);
    expect(reverse.sample(0).tangentY).toBeLessThan(0);
  });

  it("keeps short adjacent corner trims within their shared segment", () => {
    const route = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 0.25 },
      { x: 3, y: 0.25 },
      { x: 4, y: 0.25 },
    ];
    const path = createFlowPath(route);

    expect(path.data).toBe("M 0 0 L 37.5 0 Q 40 0 40 2.5 L 40 2.5 Q 40 5 42.5 5 L 60 5 L 80 5");
    expect(path.length).toBeGreaterThan(0);
    expect(path.sample(path.length).x).toBe(80);
  });

  it("preserves collinear reversals and follows the reversed tangent", () => {
    const path = createFlowPath([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 0 }]);

    expect(path.data).toBe("M 0 0 L 40 0 L 0 0");
    expect(path.sample(10).tangentX).toBe(1);
    expect(path.sample(50).tangentX).toBe(-1);
  });

  it("extends endpoint tangents for arrow samples beyond either end", () => {
    const path = createFlowPath([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }]);

    expect(pointIsClose(path.sample(-5), { x: -5, y: 0 })).toBe(true);
    expect(pointIsClose(path.sample(path.length + 5), { x: 60, y: 45 })).toBe(true);
    expect(flowArrowPath(path, 2)).not.toContain("NaN");
  });

  it("keeps the original arrow outline on a straight route, including scaled glyphs", () => {
    const path = createFlowPath([{ x: 0, y: 0 }, { x: 10, y: 0 }]);

    for (const scale of [1, 1.5]) {
      const points = arrowPoints(flowArrowPath(path, 80, scale));
      for (const vertex of arrowVertices) {
        expect(points.some((point) => Math.abs(point.x - vertex.x) < 0.001 && Math.abs(point.y - vertex.y) < 0.001)).toBe(true);
      }
    }
  });

  it("warps arrow points along an inside and outside turn", () => {
    const clockwise = createFlowPath([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }]);
    const counterClockwise = createFlowPath([{ x: 3, y: 2 }, { x: 3, y: 0 }, { x: 0, y: 0 }]);
    const clockwiseArrow = arrowPoints(flowArrowPath(clockwise, 57.5));
    const counterClockwiseArrow = arrowPoints(flowArrowPath(counterClockwise, counterClockwise.length - 57.5));

    expect(clockwiseArrow.length).toBeGreaterThan(arrowVertices.length);
    expect(counterClockwiseArrow.length).toBeGreaterThan(arrowVertices.length);
    expect(Math.abs((clockwiseArrow[3]?.y ?? -8) - arrowVertices[0]!.y)).toBeGreaterThan(0.1);
    expect(Math.abs((counterClockwiseArrow[3]?.y ?? -8) - arrowVertices[0]!.y)).toBeGreaterThan(0.1);
  });

  it("keeps the inside-turn scale-3 arrow outline free of self-intersections", () => {
    const innerTurn = createFlowPath([{ x: 3, y: 2 }, { x: 3, y: 0 }, { x: 0, y: 0 }]);

    for (let distance = 0; distance <= innerTurn.length; distance += 0.25) {
      expect(hasSelfIntersection(arrowPoints(flowArrowPath(innerTurn, distance, 3)))).toBe(false);
    }
  });
});
