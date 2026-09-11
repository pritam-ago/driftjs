import { describe, expect, it } from "vitest";
import { canonical } from "../src/diff/canonical";

describe("canonical", () => {
  it("ignores object key order", () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }));
  });

  it("ignores key order at every depth", () => {
    expect(canonical({ outer: { x: 1, y: [{ p: 1, q: 2 }] } })).toBe(
      canonical({ outer: { y: [{ q: 2, p: 1 }], x: 1 } }),
    );
  });

  it("respects array order, which is meaningful", () => {
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });

  it("keeps null, undefined and the string \"undefined\" apart", () => {
    expect(canonical(null)).not.toBe(canonical(undefined));
    expect(canonical(undefined)).not.toBe(canonical("undefined"));
    expect(canonical(null)).not.toBe(canonical("null"));
  });

  it("keeps a number apart from its string form", () => {
    expect(canonical(1)).not.toBe(canonical("1"));
  });

  it("distinguishes an absent column from a null one", () => {
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: 1, b: null }));
  });
});
