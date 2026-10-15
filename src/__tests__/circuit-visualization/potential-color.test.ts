import { describe, expect, it } from "vitest";
import { circuitPotentialColor } from "../../circuit-visualization.js";

describe("potential color scale", () => {
  it.each([Number.MIN_VALUE, 1e-300, 1e-20, 1, Number.MAX_VALUE])(
    "uses the full color range at the positive scale %s",
    (scale) => {
      expect(circuitPotentialColor(scale, scale)).toBe("hsl(18 80% 43%)");
      expect(circuitPotentialColor(-scale, scale)).toBe("hsl(218 80% 43%)");
      expect(circuitPotentialColor(0, scale)).toBe("hsl(18 0% 55%)");
    },
  );

  it.each([Number.MIN_VALUE * 4, 2 ** -1000, 1, 2 ** 1000])(
    "preserves relative colors for representable fractions of %s",
    (scale) => {
      expect(circuitPotentialColor(scale / 4, scale)).toBe("hsl(18 20% 52%)");
      expect(circuitPotentialColor(-scale / 2, scale)).toBe("hsl(218 40% 49%)");
      expect(circuitPotentialColor(scale * 0.75, scale)).toBe("hsl(18 60% 46%)");
    },
  );

  it("saturates above the scale even when the ratio overflows", () => {
    expect(circuitPotentialColor(Number.MAX_VALUE, Number.MIN_VALUE)).toBe("hsl(18 80% 43%)");
    expect(circuitPotentialColor(-Number.MAX_VALUE, Number.MIN_VALUE)).toBe("hsl(218 80% 43%)");
  });
});
