import { describe, it, expect } from "bun:test";
import { compile, CompileError } from "./jit.ts";
import { buildTypeInfo } from "./typecheck.ts";
import { optimize } from "./optimizer.ts";
import type { Expr } from "./types.ts";

// --- Helper ---
function run(expr: Expr, env: Record<string, unknown> = {}): unknown {
  return compile(expr)(env);
}

// --- __native ---

describe("__native", () => {
  it("array_map doubles each element", () => {
    const expr: Expr = ["__native", "array_map", "xs", ["fn", ["x"], ["*", "x", 2]]];
    expect(run(expr, { xs: [1n, 2n, 3n] })).toEqual([2n, 4n, 6n]);
  });

  it("array_filter keeps evens", () => {
    const expr: Expr = ["__native", "array_filter", "xs", ["fn", ["x"], ["==", ["%", "x", 2], 0]]];
    expect(run(expr, { xs: [1n, 2n, 3n, 4n, 5n] })).toEqual([2n, 4n]);
  });

  it("array_reduce sums elements", () => {
    const expr: Expr = ["__native", "array_reduce", "xs", ["fn", ["a", "b"], ["+", "a", "b"]], 0];
    expect(run(expr, { xs: [1n, 2n, 3n, 4n] })).toBe(10n);
  });

  it("array_find returns first match", () => {
    const expr: Expr = ["__native", "array_find", "xs", ["fn", ["x"], [">", "x", 3]]];
    expect(run(expr, { xs: [1n, 2n, 3n, 4n, 5n] })).toBe(4n);
  });

  it("array_find returns null when no match", () => {
    const expr: Expr = ["__native", "array_find", "xs", ["fn", ["x"], [">", "x", 100]]];
    expect(run(expr, { xs: [1n, 2n, 3n] })).toBe(null);
  });

  it("array_every returns true when all match", () => {
    const expr: Expr = ["__native", "array_every", "xs", ["fn", ["x"], [">", "x", 0]]];
    expect(run(expr, { xs: [1n, 2n, 3n] })).toBe(true);
  });

  it("array_every returns false when some don't match", () => {
    const expr: Expr = ["__native", "array_every", "xs", ["fn", ["x"], [">", "x", 2]]];
    expect(run(expr, { xs: [1n, 2n, 3n] })).toBe(false);
  });

  it("array_any returns true when any match", () => {
    const expr: Expr = ["__native", "array_any", "xs", ["fn", ["x"], ["==", "x", 2]]];
    expect(run(expr, { xs: [1n, 2n, 3n] })).toBe(true);
  });

  it("array_any returns false when none match", () => {
    const expr: Expr = ["__native", "array_any", "xs", ["fn", ["x"], ["==", "x", 99]]];
    expect(run(expr, { xs: [1n, 2n, 3n] })).toBe(false);
  });

  it("array_flat_map flattens", () => {
    const expr: Expr = [
      "__native",
      "array_flat_map",
      "xs",
      ["fn", ["x"], ["array", "x", ["*", "x", 2]]],
    ];
    expect(run(expr, { xs: [1n, 2n] })).toEqual([1n, 2n, 2n, 4n]);
  });

  it("array_includes finds element by deep equality", () => {
    const expr: Expr = ["__native", "array_includes", "xs", 2];
    expect(run(expr, { xs: [1n, 2n, 3n] })).toBe(true);
  });

  it("array_includes returns false when not found", () => {
    const expr: Expr = ["__native", "array_includes", "xs", 99];
    expect(run(expr, { xs: [1n, 2n, 3n] })).toBe(false);
  });

  it("array_index_of returns bigint index", () => {
    const expr: Expr = ["__native", "array_index_of", "xs", 3];
    expect(run(expr, { xs: [1n, 2n, 3n] })).toBe(2n);
  });

  it("array_index_of returns -1n when not found", () => {
    const expr: Expr = ["__native", "array_index_of", "xs", 99];
    expect(run(expr, { xs: [1n, 2n, 3n] })).toBe(-1n);
  });

  it("__native throws CompileError when name is not a string", () => {
    expect(() => compile(["__native", 42])).toThrow(CompileError);
  });
});

// --- __lit ---

describe("__lit", () => {
  it("null literal", () => {
    expect(run(["__lit", null])).toBe(null);
  });

  it("boolean true literal", () => {
    expect(run(["__lit", true])).toBe(true);
  });

  it("boolean false literal", () => {
    expect(run(["__lit", false])).toBe(false);
  });

  it("bigint literal", () => {
    // bigint is not part of Expr; pass via env
    const fn = compile(["__lit", 42n as unknown as null]);
    expect(fn({})).toBe(42n);
  });

  it("number literal", () => {
    expect(run(["__lit", 3.14])).toBe(3.14);
  });

  it("string literal", () => {
    expect(run(["__lit", "hello"])).toBe("hello");
  });

  it("array literal", () => {
    const fn = compile(["__lit", [1n, 2n, 3n] as unknown as null]);
    expect(fn({})).toEqual([1n, 2n, 3n]);
  });

  it("plain object literal", () => {
    const fn = compile(["__lit", { x: 1n, y: 2n } as unknown as null]);
    expect(fn({})).toEqual({ x: 1n, y: 2n });
  });

  it("__lit throws CompileError with wrong arity", () => {
    expect(() => compile(["__lit", 1, 2])).toThrow(CompileError);
  });
});

// --- __loop / __continue ---

describe("__loop and __continue", () => {
  it("loop counting up to n (tail-recursive sum)", () => {
    // sum [1..n] using __loop: acc + i while i <= n
    // __loop [i, acc] [1, 0] body
    //   if i <= n: __continue [i+1, acc+i]
    //   else: acc
    const expr: Expr = [
      "__loop",
      ["i", "acc"],
      [1, 0],
      ["if", ["<=", "i", "n"], ["__continue", ["+", "i", 1], ["+", "acc", "i"]], "acc"],
    ];
    expect(run(expr, { n: 10n })).toBe(55n);
  });

  it("loop with no iterations", () => {
    // loop that immediately returns init value (0 iterations)
    const expr: Expr = ["__loop", ["x"], [99], ["if", false, ["__continue", ["+", "x", 1]], "x"]];
    expect(run(expr, {})).toBe(99n);
  });

  it("loop computing factorial", () => {
    // fact(n) using __loop
    const expr: Expr = [
      "__loop",
      ["i", "acc"],
      ["n", 1],
      ["if", ["<=", "i", 1], "acc", ["__continue", ["-", "i", 1], ["*", "acc", "i"]]],
    ];
    expect(run(expr, { n: 6n })).toBe(720n);
  });

  it("__continue outside __loop throws CompileError", () => {
    expect(() => compile(["__continue", 1])).toThrow(CompileError);
  });

  it("__loop propagates non-continue exceptions", () => {
    // A loop body that throws a non-sentinel error
    const expr: Expr = [
      "__loop",
      ["x"],
      [0],
      ["if", ["==", "x", 0], ["as", "int", "notANumber"], ["__continue", ["+", "x", 1]]],
    ];
    expect(() => run(expr, { notANumber: "string" })).toThrow();
  });
});

// --- buildTypeInfo ---

describe("buildTypeInfo", () => {
  it("typeOf([]) returns root type for int literal", () => {
    const info = buildTypeInfo(42);
    const t = info.typeOf([]);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe("int");
  });

  it("typeOf([]) returns bool for boolean literal", () => {
    const info = buildTypeInfo(true);
    const t = info.typeOf([]);
    expect(t!.kind).toBe("bool");
  });

  it("typeOf([]) returns null-type for null", () => {
    const info = buildTypeInfo(null);
    const t = info.typeOf([]);
    expect(t!.kind).toBe("null");
  });

  it("typeOf([]) returns int for addition of ints", () => {
    const info = buildTypeInfo(["+", 1, 2]);
    const t = info.typeOf([]);
    expect(t!.kind).toBe("int");
  });

  it("typeOf([1]) returns int for first arg of +", () => {
    const info = buildTypeInfo(["+", 1, 2]);
    const t = info.typeOf([1]);
    expect(t!.kind).toBe("int");
  });

  it("typeOf returns null for unknown path", () => {
    const info = buildTypeInfo(42);
    expect(info.typeOf([99])).toBeNull();
  });

  it("isPure returns false for pure int expression (open row is conservative)", () => {
    // A fresh open effects row is conservative — isPure returns false.
    // The root effects row starts as an open fresh row even for pure exprs.
    const info = buildTypeInfo(["+", 1, 2]);
    expect(info.isPure([])).toBe(false);
  });

  it("isPure returns false for boolean literal (open row is conservative)", () => {
    const info = buildTypeInfo(true);
    expect(info.isPure([])).toBe(false);
  });

  it("isPure returns false for perform (effectful)", () => {
    // perform adds an effect to the row — so isPure should be false
    // We can't easily compile/run perform, but we CAN typecheck it
    const info = buildTypeInfo(["perform", "MyEff", 42]);
    // perform adds an effect to the row — isPure should be false
    expect(info.isPure([])).toBe(false);
  });

  it("effectsOf([]) returns a row type", () => {
    const info = buildTypeInfo(["+", 1, 2]);
    const eff = info.effectsOf([]);
    expect(eff).not.toBeNull();
    expect(eff!.kind).toBe("row");
  });

  it("effectsOf for perform has non-empty effects", () => {
    const info = buildTypeInfo(["perform", "MyEff", 42]);
    const eff = info.effectsOf([]);
    expect(eff).not.toBeNull();
    // Should have at least one effect field (MyEff)
    if (eff && eff.kind === "row") {
      expect(eff.fields.size).toBeGreaterThan(0);
    }
  });
});

// --- optimize (Phase 0 identity) ---

describe("optimize (Phase 0 identity)", () => {
  it("returns the expression unchanged", () => {
    const expr: Expr = ["+", 1, 2];
    expect(optimize(expr, [])).toBe(expr);
  });

  it("returns null unchanged", () => {
    expect(optimize(null, [])).toBe(null);
  });

  it("accepts typeInfo argument", () => {
    const expr: Expr = ["+", 1, 2];
    const info = buildTypeInfo(expr);
    expect(optimize(expr, [], info)).toBe(expr);
  });
});
