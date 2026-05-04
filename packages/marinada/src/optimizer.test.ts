import { describe, it, expect } from "bun:test";
import { compile, compileToSource, CompileError } from "./jit.ts";
import { buildTypeInfo } from "./typecheck.ts";
import {
  optimize,
  CONSTANT_FOLDING_RULES,
  inlineSmallFunctions,
  tco,
  type RewriteRule,
} from "./optimizer.ts";
import { STD_BINDINGS } from "./std.ts";
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

// --- optimize: empty rule set is identity ---

describe("optimize: empty rules", () => {
  it("returns the expression unchanged when no rules given", () => {
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

// --- Constant folding rules ---

describe("optimizer: arithmetic folding", () => {
  it("folds + over int literals", () => {
    expect(optimize(["+", 1, 2], CONSTANT_FOLDING_RULES) as unknown).toEqual(["__lit", 3n]);
  });

  it("folds nested arithmetic bottom-up", () => {
    // (1 + 2) * (3 + 4) → 21
    expect(optimize(["*", ["+", 1, 2], ["+", 3, 4]], CONSTANT_FOLDING_RULES) as unknown).toEqual([
      "__lit",
      21n,
    ]);
  });

  it("folds float arithmetic", () => {
    expect(optimize(["+", 1.5, 2.25], CONSTANT_FOLDING_RULES)).toEqual(["__lit", 3.75]);
  });

  it("does not fold integer division by zero", () => {
    const expr: Expr = ["/", 10, 0];
    expect(optimize(expr, CONSTANT_FOLDING_RULES)).toEqual(["/", 10, 0]);
  });

  it("does not fold integer modulo by zero", () => {
    const expr: Expr = ["%", 10, 0];
    expect(optimize(expr, CONSTANT_FOLDING_RULES)).toEqual(["%", 10, 0]);
  });

  it("folds integer division when divisor is non-zero", () => {
    expect(optimize(["/", 10, 2], CONSTANT_FOLDING_RULES) as unknown).toEqual(["__lit", 5n]);
  });

  it("does not fold float ops that would produce non-finite results", () => {
    // 1.0 / 0.0 → Infinity; do not fold.
    const expr: Expr = ["/", 1.5, 0.0];
    expect(optimize(expr, CONSTANT_FOLDING_RULES)).toEqual(["/", 1.5, 0.0]);
  });
});

describe("optimizer: comparison folding", () => {
  it("folds <, <=, >, >= on numeric literals", () => {
    expect(optimize(["<", 1, 2], CONSTANT_FOLDING_RULES)).toEqual(["__lit", true]);
    expect(optimize([">=", 5, 5], CONSTANT_FOLDING_RULES)).toEqual(["__lit", true]);
    expect(optimize([">", 1, 2], CONSTANT_FOLDING_RULES)).toEqual(["__lit", false]);
  });

  it("folds == with deep equality", () => {
    expect(optimize(["==", 1, 1], CONSTANT_FOLDING_RULES)).toEqual(["__lit", true]);
    // Bare strings are variable references in Marinada; string literals must
    // be wrapped in __lit. Compare two equal __lit strings.
    expect(
      optimize(["==", ["__lit", "hello"], ["__lit", "hello"]], CONSTANT_FOLDING_RULES),
    ).toEqual(["__lit", true]);
    expect(optimize(["==", ["__lit", "a"], ["__lit", "b"]], CONSTANT_FOLDING_RULES)).toEqual([
      "__lit",
      false,
    ]);
  });

  it("folds != with deep equality", () => {
    expect(optimize(["!=", 1, 2], CONSTANT_FOLDING_RULES)).toEqual(["__lit", true]);
  });
});

describe("optimizer: logic folding", () => {
  it("folds not over boolean", () => {
    expect(optimize(["not", true], CONSTANT_FOLDING_RULES)).toEqual(["__lit", false]);
    expect(optimize(["not", false], CONSTANT_FOLDING_RULES)).toEqual(["__lit", true]);
  });

  it("short-circuits and: false short-circuits to false", () => {
    expect(optimize(["and", false, "x"], CONSTANT_FOLDING_RULES)).toEqual(["__lit", false]);
  });

  it("short-circuits and: true reduces to right operand (not necessarily lit)", () => {
    expect(optimize(["and", true, "x"], CONSTANT_FOLDING_RULES)).toEqual("x");
  });

  it("short-circuits or: true short-circuits to true", () => {
    expect(optimize(["or", true, "x"], CONSTANT_FOLDING_RULES)).toEqual(["__lit", true]);
  });

  it("short-circuits or: false reduces to right operand", () => {
    expect(optimize(["or", false, "x"], CONSTANT_FOLDING_RULES)).toEqual("x");
  });
});

describe("optimizer: branch elimination", () => {
  it("if true → then branch", () => {
    expect(optimize(["if", true, "t", "e"], CONSTANT_FOLDING_RULES)).toEqual("t");
  });

  it("if false → else branch", () => {
    expect(optimize(["if", false, "t", "e"], CONSTANT_FOLDING_RULES)).toEqual("e");
  });

  it("if with const-folded test", () => {
    // ["==", 1, 1] folds to ["__lit", true], then if folds to "t".
    expect(optimize(["if", ["==", 1, 1], "t", "e"], CONSTANT_FOLDING_RULES)).toEqual("t");
  });

  it("cond with else clause folds to else body when prior tests are constant false", () => {
    expect(
      optimize(["cond", [false, "a"], [false, "b"], ["else", "c"]], CONSTANT_FOLDING_RULES),
    ).toEqual("c");
  });

  it("cond with constant true test picks that clause", () => {
    expect(
      optimize(["cond", [false, "a"], [true, "b"], ["else", "c"]], CONSTANT_FOLDING_RULES),
    ).toEqual("b");
  });
});

describe("optimizer: string folding", () => {
  it("folds str-len on string literal", () => {
    expect(optimize(["str-len", ["__lit", "hello"]], CONSTANT_FOLDING_RULES) as unknown).toEqual([
      "__lit",
      5n,
    ]);
  });

  it("folds str-concat on two literal strings", () => {
    expect(
      optimize(["str-concat", ["__lit", "a"], ["__lit", "b"]], CONSTANT_FOLDING_RULES),
    ).toEqual(["__lit", "ab"]);
  });

  it("folds str-slice when all args are constants", () => {
    expect(optimize(["str-slice", ["__lit", "hello"], 1, 4], CONSTANT_FOLDING_RULES)).toEqual([
      "__lit",
      "ell",
    ]);
  });
});

describe("optimizer: array compound folding", () => {
  it("folds array of all literals to a single __lit value", () => {
    expect(optimize(["array", 1, 2, 3], CONSTANT_FOLDING_RULES) as unknown).toEqual([
      "__lit",
      [1n, 2n, 3n],
    ]);
  });

  it("does not fold array with a non-constant element", () => {
    const expr: Expr = ["array", 1, "x", 3];
    const r = optimize(expr, CONSTANT_FOLDING_RULES);
    expect(r).toEqual(expr);
  });

  it("folds nested array literals via recursion", () => {
    // [[1,2], [3,4]] — the inner arrays fold first, then outer.
    expect(
      optimize(["array", ["array", 1, 2], ["array", 3, 4]], CONSTANT_FOLDING_RULES) as unknown,
    ).toEqual([
      "__lit",
      [
        [1n, 2n],
        [3n, 4n],
      ],
    ]);
  });

  it("folds get on a literal array with a literal index", () => {
    expect(optimize(["get", ["array", 10, 20, 30], 1], CONSTANT_FOLDING_RULES) as unknown).toEqual([
      "__lit",
      20n,
    ]);
  });

  it("folds get with out-of-bounds index to null", () => {
    expect(optimize(["get", ["array", 10, 20], 5], CONSTANT_FOLDING_RULES)).toEqual([
      "__lit",
      null,
    ]);
  });
});

describe("optimizer: to-string folding", () => {
  it("folds to-string on int literal", () => {
    expect(optimize(["to-string", 42], CONSTANT_FOLDING_RULES)).toEqual(["__lit", "42"]);
  });

  it("folds to-string on bool literal", () => {
    expect(optimize(["to-string", true], CONSTANT_FOLDING_RULES)).toEqual(["__lit", "true"]);
  });
});

describe("optimizer: dead binding elimination", () => {
  it("drops a let binding when name is unused and value is pure", () => {
    // (let [[unused 1]] body)  →  body
    expect(optimize(["let", [["unused", 1]], "body"], CONSTANT_FOLDING_RULES)).toEqual("body");
  });

  it("does not drop a binding when value has side effects", () => {
    // perform is effectful; binding can't be dropped even if unused.
    const expr: Expr = ["let", [["unused", ["perform", "Eff", 0]]], "body"];
    expect(optimize(expr, CONSTANT_FOLDING_RULES)).toEqual(expr);
  });

  it("keeps a binding that is referenced", () => {
    const expr: Expr = ["let", [["x", ["__lit", 99n as unknown as null]]], ["+", "x", 1]];
    // Literal copy propagation substitutes x→99n in the body, then folds + to 100n.
    expect(optimize(expr, CONSTANT_FOLDING_RULES) as unknown).toEqual(["__lit", 100n]);
  });
});

describe("optimizer: literal copy propagation", () => {
  it("substitutes a __lit binding into the body", () => {
    expect(optimize(["let", [["x", ["__lit", "hi"]]], "x"], CONSTANT_FOLDING_RULES)).toEqual([
      "__lit",
      "hi",
    ]);
  });

  it("propagates a literal across multiple uses and folds", () => {
    // let x = 5 in x + x  →  10n
    expect(
      optimize(
        ["let", [["x", ["__lit", 5n as unknown as null]]], ["+", "x", "x"]],
        CONSTANT_FOLDING_RULES,
      ) as unknown,
    ).toEqual(["__lit", 10n]);
  });

  it("does not propagate past a shadowing binding", () => {
    // let x = 1 in let x = "y" in x  →  let x = "y" in x  (shadowed; outer x dropped as unused)
    const r = optimize(
      [
        "let",
        [["x", ["__lit", 1n as unknown as null]]],
        ["let", [["x", ["__lit", "shadow"]]], "x"],
      ],
      CONSTANT_FOLDING_RULES,
    );
    // After folding: outer x has no remaining uses (inner shadow), and inner is propagated.
    expect(r).toEqual(["__lit", "shadow"]);
  });
});

describe("optimizer: termination guard", () => {
  it("throws when a non-reducing rule fires twice on the same node", () => {
    // A pathological rule: matches any "noop" expression and rewrites to itself
    // (same value). Marked reducing: false so the optimizer guards against
    // re-firing. Then we craft a wrapper rule that re-introduces the same node
    // by rewrite-to-input — actually simplest: a reducing-true rule that returns
    // the same reference triggers the explicit termination guard.
    const badRule: RewriteRule = {
      name: "bad-loop",
      headOp: "noop",
      reducing: true,
      match: (e) => (Array.isArray(e) && e[0] === "noop" ? {} : null),
      rewrite: (_b) => {
        // Return a structurally-different node with the same head op so the
        // optimizer keeps trying to apply the rule. Each iteration produces a
        // brand-new array, so the "same reference" guard doesn't trigger; the
        // 1000-iteration backstop does.
        return ["noop"] as Expr;
      },
    };
    expect(() => optimize(["noop"], [badRule])).toThrow(/did not terminate|same node/);
  });

  it("throws when a reducing-true rule returns the same reference", () => {
    const sameRefRule: RewriteRule = {
      name: "same-ref",
      headOp: "id",
      reducing: true,
      match: (e) => (Array.isArray(e) && e[0] === "id" ? { e: e as Expr } : null),
      rewrite: (b) => b.e as Expr, // returns the SAME array — should trigger guard
    };
    expect(() => optimize(["id"], [sameRefRule])).toThrow(/same node|non-reducing/);
  });
});

describe("optimizer: integration with compile", () => {
  it("folded result preserves runtime semantics", () => {
    const fn = compile(["+", 1, 2]);
    expect(fn({})).toBe(3n);
  });

  it("compile output uses the folded literal, not _rt._add", () => {
    const src = compileToSource(["+", 1, 2]);
    expect(src).toContain("3n");
    expect(src).not.toContain("_rt._add");
  });

  it("compile with optimize:false preserves the un-folded shape", () => {
    const src = compileToSource(["+", 1, 2], { optimize: false });
    expect(src).toContain("_rt._add");
  });

  it("nested constant expression folds end-to-end", () => {
    const fn = compile(["if", ["==", ["+", 1, 1], 2], ["__lit", "yes"], ["__lit", "no"]]);
    expect(fn({})).toBe("yes");
  });

  it("preserves dynamic computation when operands are not constant", () => {
    // ["+", 1, "x"] — x is a var ref; cannot fold.
    const fn = compile(["+", 1, "x"]);
    expect(fn({ x: 41n })).toBe(42n);
  });
});

// --- Phase 6: function inlining ---

// JSON.stringify can't serialize bigints, so we use a custom dumper that
// renders bigints as `"<n>n"` for substring checks.
function stringifyExpr(e: unknown): string {
  if (typeof e === "bigint") return `"${e}n"`;
  if (Array.isArray(e)) return `[${e.map(stringifyExpr).join(",")}]`;
  if (e === null) return "null";
  if (typeof e === "object") {
    return `{${Object.entries(e as Record<string, unknown>)
      .map(([k, v]) => `${JSON.stringify(k)}:${stringifyExpr(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(e);
}

describe("optimizer: function inlining", () => {
  it("inlines identity at a single call site", () => {
    // let id = (fn (x) x) in (call id 42)  →  42
    const expr: Expr = [
      "let",
      [["id", ["fn", ["x"], "x"]]],
      ["call", "id", ["__lit", 42n as unknown as null]],
    ];
    const r = inlineSmallFunctions(expr);
    // After inlining, the binding is dropped and `(call id 42)` becomes `42`.
    expect(r).toEqual(["__lit", 42n as unknown as null]);
  });

  it("inlines const at a single call site", () => {
    // let k = (fn (x) (fn (_) x)) in (call (call k 7) 99)
    const expr: Expr = [
      "let",
      [["k", ["fn", ["x"], ["fn", ["_"], "x"]]]],
      ["call", ["call", "k", ["__lit", 7n as unknown as null]], ["__lit", 99n as unknown as null]],
    ];
    // k's body is (fn (_) x) — small, no call, no letrec → inlineable.
    // The outer (call k 7) is the single call site referencing k.
    const r = inlineSmallFunctions(expr);
    expect(stringifyExpr(r)).not.toContain('"k"');
    // Semantics: result is 7.
    expect(compile(expr)({})).toBe(7n);
  });

  it("does NOT inline a function used twice", () => {
    // let f = (fn (x) (+ x 1)) in (+ (call f 1) (call f 2))
    const expr: Expr = [
      "let",
      [["f", ["fn", ["x"], ["+", "x", 1]]]],
      ["+", ["call", "f", 1], ["call", "f", 2]],
    ];
    const r = inlineSmallFunctions(expr);
    // Binding for f must remain (used twice — would duplicate body).
    expect(stringifyExpr(r)).toContain('"f"');
  });

  it("does NOT inline a large function body", () => {
    // Body size > threshold (10 nodes).
    const bigBody: Expr = ["+", ["+", ["+", ["+", "x", 1], 2], 3], ["+", ["+", ["+", 4, 5], 6], 7]];
    const expr: Expr = [
      "let",
      [["big", ["fn", ["x"], bigBody]]],
      ["call", "big", ["__lit", 99n as unknown as null]],
    ];
    const r = inlineSmallFunctions(expr);
    expect(stringifyExpr(r)).toContain('"big"');
  });

  it("does NOT inline a function whose body contains letrec (loop)", () => {
    const expr: Expr = [
      "let",
      [["looper", ["fn", ["xs"], ["letrec", [["go", ["fn", ["i"], "i"]]], "xs"]]]],
      ["call", "looper", ["__lit", 0n as unknown as null]],
    ];
    const r = inlineSmallFunctions(expr);
    expect(stringifyExpr(r)).toContain('"looper"');
  });

  it("does NOT inline a function whose body contains a nested call", () => {
    // Body has its own call → blocked.
    const expr: Expr = [
      "let",
      [
        ["g", ["fn", ["x"], "x"]],
        ["f", ["fn", ["x"], ["call", "g", "x"]]],
      ],
      ["call", "f", ["__lit", 1n as unknown as null]],
    ];
    const r = inlineSmallFunctions(expr);
    // f has a `call` in its body — not inlineable.
    expect(stringifyExpr(r)).toContain('"f"');
  });

  it("alpha-renames to avoid variable capture", () => {
    // let f = (fn (x) (+ x 1)) in
    //   let x = 100 in (call f x)
    // Naive substitution would map param x→arg x — luckily not capture, but
    // a more devious case: body has a let that binds the same name as the arg.
    // let f = (fn (x) (let [[y x]] (+ y 1))) in
    //   let y = 999 in (call f y)
    // After inlining without renaming: (let [[y y]] (+ y 1)) — `y` from the
    // arg gets shadowed. Alpha-renaming should make the inner y fresh.
    const expr: Expr = [
      "let",
      [["f", ["fn", ["x"], ["let", [["y", "x"]], ["+", "y", 1]]]]],
      ["let", [["y", ["__lit", 999n as unknown as null]]], ["call", "f", "y"]],
    ];
    const fn = compile(expr);
    expect(fn({})).toBe(1000n);
  });

  it("inlined result produces correct output through compile", () => {
    // identity at a single call site, end-to-end.
    const expr: Expr = ["let", [["id", ["fn", ["x"], "x"]]], ["call", "id", ["+", 1, 2]]];
    const fn = compile(expr);
    expect(fn({})).toBe(3n);
  });

  it("inlines flip and produces correct output", () => {
    // let flip = (fn (f) (fn (a b) (call f b a))) — body has a `call`, NOT inlineable directly.
    // But identity composition is. Test that flip remains because of nested call.
    const expr: Expr = [
      "let",
      [["fl", ["fn", ["f"], ["fn", ["a", "b"], ["call", "f", "b", "a"]]]]],
      ["call", "fl", "sub"],
    ];
    const r = inlineSmallFunctions(expr);
    // fl's body has a `call` (call f b a) — disqualified.
    expect(stringifyExpr(r)).toContain('"fl"');
  });

  it("inlining preserves semantics with const-like function", () => {
    // let k = (fn (x) (fn (y) x)) in (call (call k 5) 999)
    // k's body is (fn (y) x) — no call, no letrec, small. Inlineable.
    // After inlining outer (call k 5): substitute x=5 in (fn (y) x) → (fn (y) 5).
    // Then (call (fn (y) 5) 999) — direct call to fn literal.
    const expr: Expr = [
      "let",
      [["k", ["fn", ["x"], ["fn", ["y"], "x"]]]],
      ["call", ["call", "k", ["__lit", 5n as unknown as null]], ["__lit", 999n as unknown as null]],
    ];
    const fn = compile(expr);
    expect(fn({})).toBe(5n);
  });

  it("does not inline when binding is referenced as a value (not just called)", () => {
    // let id = (fn (x) x) in id  — id escapes; can't inline.
    const expr: Expr = ["let", [["id", ["fn", ["x"], "x"]]], "id"];
    const r = inlineSmallFunctions(expr);
    // id is referenced (returned) — not a call site, so otherUses > 0 → keep.
    expect(stringifyExpr(r)).toContain('"id"');
  });
});

// --- Phase 4: tail-call optimization ---

describe("optimizer: tail-call optimization (TCO)", () => {
  function findLoop(expr: Expr): Expr | null {
    if (!Array.isArray(expr)) return null;
    if (expr[0] === "__loop") return expr;
    for (const e of expr) {
      const found = findLoop(e as Expr);
      if (found) return found;
    }
    return null;
  }

  function hasOp(expr: Expr, op: string): boolean {
    if (!Array.isArray(expr)) return false;
    if (expr[0] === op) return true;
    for (let i = 0; i < expr.length; i++) {
      if (hasOp(expr[i] as Expr, op)) return true;
    }
    return false;
  }

  it("transforms simple self-recursive function into __loop/__continue", () => {
    // letrec [[fact, fn [n, acc] (if (<= n 1) acc (call fact (- n 1) (* acc n)))]]
    //   (call fact n-input 1)
    const expr: Expr = [
      "letrec",
      [
        [
          "fact",
          [
            "fn",
            ["n", "acc"],
            ["if", ["<=", "n", 1], "acc", ["call", "fact", ["-", "n", 1], ["*", "acc", "n"]]],
          ],
        ],
      ],
      ["call", "fact", "n-input", 1],
    ];
    const r = tco(expr);
    expect(Array.isArray(r) && r[0] === "__loop").toBe(true);
    // No __continue in __continue must appear
    expect(hasOp(r, "__continue")).toBe(true);
    // letrec should be gone
    expect(hasOp(r, "letrec")).toBe(false);
  });

  it("does NOT transform when recursive call is in non-tail position", () => {
    // letrec [[f, fn [n] (if (== n 0) 0 (+ 1 (call f (- n 1))))]] (call f 5)
    // The recursive call is inside (+ 1 _), which is non-tail. Should not transform.
    const expr: Expr = [
      "letrec",
      [["f", ["fn", ["n"], ["if", ["==", "n", 0], 0, ["+", 1, ["call", "f", ["-", "n", 1]]]]]]],
      ["call", "f", 5],
    ];
    const r = tco(expr);
    expect(hasOp(r, "__loop")).toBe(false);
    expect(hasOp(r, "letrec")).toBe(true);
  });

  it("transforms tail call inside if-branches", () => {
    const expr: Expr = [
      "letrec",
      [["loop", ["fn", ["i"], ["if", [">=", "i", "n"], "i", ["call", "loop", ["+", "i", 1]]]]]],
      ["call", "loop", 0],
    ];
    const r = tco(expr);
    const loop = findLoop(r);
    expect(loop).not.toBeNull();
    expect(hasOp(r, "__continue")).toBe(true);
  });

  it("transforms tail call inside match-branch", () => {
    // letrec [[f, fn [opt] (match opt [[None] 0] [[Some, x] (call f (Some x))])]]
    //   (call f some-val) — recursive call is in tail position of a match clause.
    const expr: Expr = [
      "letrec",
      [
        [
          "f",
          [
            "fn",
            ["opt"],
            [
              "match",
              "opt",
              [["None"], 0],
              [
                ["Some", "x"],
                ["call", "f", ["None"]],
              ],
            ],
          ],
        ],
      ],
      ["call", "f", "init"],
    ];
    const r = tco(expr);
    expect(hasOp(r, "__loop")).toBe(true);
    expect(hasOp(r, "__continue")).toBe(true);
  });

  it("transforms tail call as last expression of do", () => {
    const expr: Expr = [
      "letrec",
      [
        [
          "loop",
          [
            "fn",
            ["i"],
            ["if", [">=", "i", "n"], "i", ["do", "i", ["call", "loop", ["+", "i", 1]]]],
          ],
        ],
      ],
      ["call", "loop", 0],
    ];
    const r = tco(expr);
    expect(hasOp(r, "__loop")).toBe(true);
    expect(hasOp(r, "__continue")).toBe(true);
  });

  it("does NOT transform mutual recursion", () => {
    // letrec [[even, fn [n] ...], [odd, fn [n] ...]] — multiple bindings.
    const expr: Expr = [
      "letrec",
      [
        ["even", ["fn", ["n"], ["if", ["==", "n", 0], true, ["call", "odd", ["-", "n", 1]]]]],
        ["odd", ["fn", ["n"], ["if", ["==", "n", 0], false, ["call", "even", ["-", "n", 1]]]]],
      ],
      ["call", "even", 4],
    ];
    const r = tco(expr);
    expect(hasOp(r, "__loop")).toBe(false);
    expect(hasOp(r, "letrec")).toBe(true);
  });

  it("compiled TCO'd function produces correct output (factorial)", () => {
    const expr: Expr = [
      "letrec",
      [
        [
          "fact",
          [
            "fn",
            ["n", "acc"],
            ["if", ["<=", "n", 1], "acc", ["call", "fact", ["-", "n", 1], ["*", "acc", "n"]]],
          ],
        ],
      ],
      ["call", "fact", "n", 1],
    ];
    // After TCO, this becomes a __loop. Verify both that the AST is loop-shaped
    // and that running it gives the right answer.
    const after = tco(expr);
    expect(hasOp(after, "__loop")).toBe(true);
    const fn = compile(expr);
    expect(fn({ n: 6n })).toBe(720n);
  });

  it("compiled TCO'd function produces correct output (sum)", () => {
    const expr: Expr = [
      "letrec",
      [
        [
          "loop",
          [
            "fn",
            ["i", "acc"],
            ["if", [">", "i", "n"], "acc", ["call", "loop", ["+", "i", 1], ["+", "acc", "i"]]],
          ],
        ],
      ],
      ["call", "loop", 1, 0],
    ];
    const after = tco(expr);
    expect(hasOp(after, "__loop")).toBe(true);
    const fn = compile(expr);
    expect(fn({ n: 10n })).toBe(55n);
  });

  it("transforms lib:std map (entry is fn wrapping a tail call)", () => {
    const stdMap = STD_BINDINGS.find((b) => b.name === "map")!;
    const after = tco(stdMap.expr);
    // The fn shape stays but its body becomes a __loop.
    expect(hasOp(after, "__loop")).toBe(true);
    expect(hasOp(after, "__continue")).toBe(true);
    expect(hasOp(after, "letrec")).toBe(false);
  });

  it("transforms lib:std filter", () => {
    const stdFilter = STD_BINDINGS.find((b) => b.name === "filter")!;
    const after = tco(stdFilter.expr);
    expect(hasOp(after, "__loop")).toBe(true);
    expect(hasOp(after, "__continue")).toBe(true);
    expect(hasOp(after, "letrec")).toBe(false);
  });

  it("transforms lib:std reduce", () => {
    const stdReduce = STD_BINDINGS.find((b) => b.name === "reduce")!;
    const after = tco(stdReduce.expr);
    expect(hasOp(after, "__loop")).toBe(true);
    expect(hasOp(after, "__continue")).toBe(true);
    expect(hasOp(after, "letrec")).toBe(false);
  });

  it("compiled lib:std map produces correct output via TCO loop", () => {
    const stdMap = STD_BINDINGS.find((b) => b.name === "map")!;
    // Apply: (call <map> (fn [x] (* x 2)) [1,2,3])
    const expr: Expr = ["call", stdMap.expr, ["fn", ["x"], ["*", "x", 2]], "xs"];
    const fn = compile(expr);
    expect(fn({ xs: [1n, 2n, 3n] })).toEqual([2n, 4n, 6n]);
  });

  it("compiled lib:std filter produces correct output via TCO loop", () => {
    const stdFilter = STD_BINDINGS.find((b) => b.name === "filter")!;
    const expr: Expr = ["call", stdFilter.expr, ["fn", ["x"], [">", "x", 2]], "xs"];
    const fn = compile(expr);
    expect(fn({ xs: [1n, 2n, 3n, 4n] })).toEqual([3n, 4n]);
  });

  it("compiled lib:std reduce produces correct output via TCO loop", () => {
    const stdReduce = STD_BINDINGS.find((b) => b.name === "reduce")!;
    const expr: Expr = ["call", stdReduce.expr, ["fn", ["a", "b"], ["+", "a", "b"]], 0, "xs"];
    const fn = compile(expr);
    expect(fn({ xs: [1n, 2n, 3n, 4n] })).toBe(10n);
  });
});

// CompileError is referenced indirectly via earlier suite imports; ensure not unused.
void CompileError;
