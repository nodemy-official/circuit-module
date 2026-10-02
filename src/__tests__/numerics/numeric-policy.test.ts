import { expect, it } from "vitest";

import { findVirtualSourceViolations } from "../../../scripts/numeric-policy.mjs";

it("detects Float64Array sidecar mutation and copies in typed source", () => {
  const violations = findVirtualSourceViolations(`
    type State = Float64Array;
    declare const state: State;
    state[0] = 1;
    state[0] += 2;
    state[1]++;
    --state[2];
    state["fill"](3);
    state.set([1]);
    state.fill(0);
    state.copyWithin(0, 1);
    state.reverse();
    state.sort();
    state.slice();
    state.map((value) => value);
    state.filter((value) => value > 0);
    state.subarray(0);
    state.toReversed();
    state.toSorted();
    state.with(0, 1);
    state["slice"]();
    new Float64Array(state);
    Float64Array.from(state);
    Array.from(state);
    [...state];
    const F = Float64Array;
    const A = Array;
    new F(state);
    F.from(state);
    new globalThis.Float64Array(state);
    globalThis.Float64Array.from(state);
    A.from(state);
    globalThis.Array.from(state);
  `);

  expect(violations.map(({ code }) => code)).toEqual([
    "NPOL001", "NPOL001", "NPOL001", "NPOL001",
    "NPOL002", "NPOL002", "NPOL002", "NPOL002", "NPOL002", "NPOL002",
    "NPOL003", "NPOL003", "NPOL003", "NPOL003", "NPOL003", "NPOL003", "NPOL003", "NPOL003",
    "NPOL003", "NPOL003", "NPOL003", "NPOL003",
    "NPOL003", "NPOL003", "NPOL003", "NPOL003", "NPOL003", "NPOL003",
  ]);
});

it("ignores integer typed arrays, unrelated same-name methods, and safe numeric constructors", () => {
  const violations = findVirtualSourceViolations(`
    declare const integers: Int32Array;
    integers[0] = 1;
    integers.fill(2);
    integers.slice();

    const collection = {
      fill(_value: number) {},
      set(_value: number) {},
      slice() { return [1]; },
    };
    collection.fill(0);
    collection["fill"](2);
    collection.set(1);
    collection.slice();

    const Float64Array = { from(value: number[]) { return value; } };
    Float64Array.from([1, 2]);
    new globalThis.Float64Array([1, 2]);
    globalThis.Float64Array.from([1, 2]);
    Array.from([1, 2]);
    globalThis.Array.from([1, 2]);

    {
      class Float64Array {
        constructor(_source: globalThis.Float64Array) {}
        static from(source: globalThis.Float64Array) { return source; }
      }
      const local = new Float64Array(new globalThis.Float64Array([1]));
      Float64Array.from(new globalThis.Float64Array([1]));
      void local;
    }
  `);

  expect(violations).toEqual([]);
});

it("detects aliases and assignments through a variable alias", () => {
  const violations = findVirtualSourceViolations(`
    type State = Float64Array & { readonly __brand: unique symbol };
    declare const state: State;
    const alias = state;
    alias[3] = 7;
    alias.subarray(1);
  `);

  expect(violations.map(({ code }) => code)).toEqual(["NPOL001", "NPOL003"]);
});
