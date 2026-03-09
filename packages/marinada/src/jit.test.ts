import { describe, it, expect } from "bun:test";
import { compile, CompileError } from "./jit.ts";
import { evaluate, EMPTY_ENV } from "./evaluate.ts";
import type { Value } from "./value.ts";
import type { Expr } from "./types.ts";

// --- Helpers ---

function run(expr: Expr, env: Record<string, unknown> = {}): unknown {
  return compile(expr)(env);
}

// Convert a JS-native JIT value to an interpreter Value for comparison.
function toValue(v: unknown): Value {
  if (v === null) return { kind: "null" };
  if (typeof v === "boolean") return { kind: "bool", value: v };
  if (typeof v === "bigint") return { kind: "int", value: v };
  if (typeof v === "number") return { kind: "float", value: v };
  if (typeof v === "string") return { kind: "string", value: v };
  if (Array.isArray(v)) return { kind: "array", value: (v as unknown[]).map(toValue) };
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const tag = o["$tag"];
    if (typeof tag === "string") {
      // variant
      const fields: Value[] = [];
      let i = 0;
      while (`$${i}` in o) {
        fields.push(toValue(o[`$${i}`]));
        i++;
      }
      return { kind: "variant", tag, fields };
    }
    // record
    const entries = Object.entries(o).map(([k, val]) => [k, toValue(val)] as [string, Value]);
    return { kind: "record", value: new Map(entries) };
  }
  return { kind: "null" };
}

// Build an interpreter Env from a plain record of JIT-native values.
function envFromRecord(env: Record<string, unknown>) {
  const valRecord: Record<string, Value> = {};
  for (const [k, v] of Object.entries(env)) {
    valRecord[k] = toValue(v);
  }
  return EMPTY_ENV.extend(valRecord);
}

// --- Atom tests ---

describe("atoms", () => {
  it("null", () => {
    expect(run(null)).toBe(null);
  });

  it("true", () => {
    expect(run(true)).toBe(true);
  });

  it("false", () => {
    expect(run(false)).toBe(false);
  });

  it("integer → bigint", () => {
    expect(run(42)).toBe(42n);
  });

  it("negative integer → bigint", () => {
    expect(run(-7)).toBe(-7n);
  });

  it("float → number", () => {
    expect(run(3.14)).toBe(3.14);
  });

  it("variable reference", () => {
    expect(run("x", { x: 99n })).toBe(99n);
  });

  it("variable reference string value", () => {
    expect(run("name", { name: "alice" })).toBe("alice");
  });
});

// --- Arithmetic ---

describe("arithmetic", () => {
  it("int + int = bigint", () => {
    expect(run(["+", 3, 5])).toBe(8n);
  });

  it("float + float = number", () => {
    expect(run(["+", 1.5, 2.5])).toBe(4.0);
  });

  it("int + float = number (promotes)", () => {
    const result = run(["+", 3, 1.5]);
    expect(typeof result).toBe("number");
    expect(result).toBe(4.5);
  });

  it("subtraction", () => {
    expect(run(["-", 10, 3])).toBe(7n);
  });

  it("multiplication", () => {
    expect(run(["*", 6, 7])).toBe(42n);
  });

  it("division int / int = bigint", () => {
    expect(run(["/", 10, 3])).toBe(3n);
  });

  it("division float", () => {
    // Use truly non-integer floats (10.5 / 4.2 are not integers in JS)
    expect(run(["/", "x", "y"], { x: 10.5, y: 2.0 })).toBe(5.25);
  });

  it("modulo", () => {
    expect(run(["%", 10, 3])).toBe(1n);
  });

  it("division by zero throws", () => {
    expect(() => run(["/", 10, 0])).toThrow();
  });

  it("modulo by zero throws", () => {
    expect(() => run(["%", 10, 0])).toThrow();
  });

  it("variable arithmetic", () => {
    expect(run(["+", "x", "y"], { x: 3n, y: 4n })).toBe(7n);
  });
});

// --- Comparison ---

describe("comparison", () => {
  it("== equal ints", () => {
    expect(run(["==", 5, 5])).toBe(true);
  });

  it("== unequal ints", () => {
    expect(run(["==", 5, 6])).toBe(false);
  });

  it("== null and null", () => {
    expect(run(["==", null, null])).toBe(true);
  });

  it("!= unequal", () => {
    expect(run(["!=", 1, 2])).toBe(true);
  });

  it("!= equal", () => {
    expect(run(["!=", 1, 1])).toBe(false);
  });

  it("< true", () => {
    expect(run(["<", 3, 5])).toBe(true);
  });

  it("< false", () => {
    expect(run(["<", 5, 3])).toBe(false);
  });

  it("> true", () => {
    expect(run([">", 10, 1])).toBe(true);
  });

  it("<= equal", () => {
    expect(run(["<=", 4, 4])).toBe(true);
  });

  it(">= greater", () => {
    expect(run([">=", 5, 3])).toBe(true);
  });

  it("float comparison", () => {
    expect(run(["<", 1.5, 2.5])).toBe(true);
  });
});

// --- Logic ---

describe("logic", () => {
  it("and true true", () => {
    expect(run(["and", true, true])).toBe(true);
  });

  it("and true false", () => {
    expect(run(["and", true, false])).toBe(false);
  });

  it("or false true", () => {
    expect(run(["or", false, true])).toBe(true);
  });

  it("or false false", () => {
    expect(run(["or", false, false])).toBe(false);
  });

  it("not true", () => {
    expect(run(["not", true])).toBe(false);
  });

  it("not false", () => {
    expect(run(["not", false])).toBe(true);
  });

  it("not variable", () => {
    expect(run(["not", "flag"], { flag: false })).toBe(true);
  });
});

// --- if ---

describe("if", () => {
  it("then branch", () => {
    expect(run(["if", true, 1, 2])).toBe(1n);
  });

  it("else branch", () => {
    expect(run(["if", false, 1, 2])).toBe(2n);
  });

  it("condition from variable", () => {
    expect(run(["if", "cond", 10, 20], { cond: true })).toBe(10n);
  });

  it("nested if", () => {
    expect(run(["if", true, ["if", false, 1, 2], 3])).toBe(2n);
  });
});

// --- do ---

describe("do", () => {
  it("single expression", () => {
    expect(run(["do", 42])).toBe(42n);
  });

  it("returns last", () => {
    expect(run(["do", 1, 2, 3])).toBe(3n);
  });

  it("side effects via assignment not needed — sequence eval", () => {
    // do evaluates all and returns last
    expect(run(["do", true, false, 99])).toBe(99n);
  });
});

// --- let ---

describe("let", () => {
  it("simple binding", () => {
    expect(run(["let", [["x", 5]], "x"])).toBe(5n);
  });

  it("multiple sequential bindings", () => {
    // y = x + 1, so y = 6
    expect(
      run([
        "let",
        [
          ["x", 5],
          ["y", ["+", "x", 1]],
        ],
        "y",
      ]),
    ).toBe(6n);
  });

  it("shadowing outer variable", () => {
    expect(run(["let", [["x", 99]], "x"], { x: 1n })).toBe(99n);
  });

  it("body uses binding", () => {
    expect(
      run([
        "let",
        [
          ["a", 3],
          ["b", 4],
        ],
        ["*", "a", "b"],
      ]),
    ).toBe(12n);
  });

  it("empty bindings", () => {
    expect(run(["let", [], 42])).toBe(42n);
  });
});

// --- letrec ---

describe("letrec", () => {
  it("recursive factorial", () => {
    const fact: Expr = [
      "letrec",
      [
        [
          "fact",
          ["fn", ["n"], ["if", ["==", "n", 0], 1, ["*", "n", ["call", "fact", ["-", "n", 1]]]]],
        ],
      ],
      ["call", "fact", 5],
    ];
    expect(run(fact)).toBe(120n);
  });

  it("mutual recursion: isEven/isOdd", () => {
    const expr: Expr = [
      "letrec",
      [
        ["isEven", ["fn", ["n"], ["if", ["==", "n", 0], true, ["call", "isOdd", ["-", "n", 1]]]]],
        ["isOdd", ["fn", ["n"], ["if", ["==", "n", 0], false, ["call", "isEven", ["-", "n", 1]]]]],
      ],
      ["call", "isEven", 4],
    ];
    expect(run(expr)).toBe(true);
  });
});

// --- fn and call ---

describe("fn and call", () => {
  it("fn creates a callable function", () => {
    const fn = run(["fn", ["x"], ["+", "x", 1]]);
    expect(typeof fn).toBe("function");
    expect((fn as (x: unknown) => unknown)(5n)).toBe(6n);
  });

  it("call with args", () => {
    expect(
      run(["call", "add", 3, 4], {
        add: (a: unknown, b: unknown) => (a as bigint) + (b as bigint),
      }),
    ).toBe(7n);
  });

  it("inline fn call", () => {
    expect(run(["call", ["fn", ["x", "y"], ["+", "x", "y"]], 3, 4])).toBe(7n);
  });

  it("fn with typed param annotation", () => {
    expect(run(["call", ["fn", [["x", "int"]], ["+", "x", 1]], 10])).toBe(11n);
  });

  it("closure captures env", () => {
    // fn captures 'base' from outer env
    const fn = run(["fn", ["x"], ["+", "x", "base"]], { base: 100n }) as (x: unknown) => unknown;
    expect(fn(5n)).toBe(105n);
  });
});

// --- get / set on records and arrays ---

describe("get and set", () => {
  it("get from record", () => {
    // "fieldName" is a variable that holds the key string "key"
    expect(run(["get", "r", "fieldName"], { r: { key: "value" }, fieldName: "key" })).toBe("value");
  });

  it("get from array by index", () => {
    expect(run(["get", "a", 0], { a: [10n, 20n, 30n] })).toBe(10n);
  });

  it("get missing key returns null", () => {
    expect(run(["get", "r", "missing"], { r: {} })).toBe(null);
  });

  it("get out-of-bounds returns null", () => {
    expect(run(["get", "a", 5], { a: [1n] })).toBe(null);
  });

  it("set on record", () => {
    // "key" is a variable ref that resolves to the key name string
    const result = run(["set", "r", "key", 42], { r: { x: 1n }, key: "k" });
    expect(result).toEqual({ x: 1n, k: 42n });
  });

  it("set on array", () => {
    const result = run(["set", "a", 1, 99], { a: [1n, 2n, 3n] });
    expect(result).toEqual([1n, 99n, 3n]);
  });
});

// --- get-in / set-in ---

describe("get-in and set-in", () => {
  it("get-in nested record", () => {
    const env = { r: { a: { b: "deep" } } };
    // path is a literal array expression — not possible in Marinada without array literal
    // Use a variable for the path
    expect(run(["get-in", "r", "path"], { ...env, path: ["a", "b"] })).toBe("deep");
  });

  it("set-in nested", () => {
    const env = { r: { a: { b: 1n } }, path: ["a", "b"] };
    const result = run(["set-in", "r", "path", 99], env);
    expect(result).toEqual({ a: { b: 99n } });
  });
});

// --- map / filter / reduce ---

describe("collections: map, filter, reduce", () => {
  it("map doubles", () => {
    const fn = (x: unknown) => (x as bigint) * 2n;
    expect(run(["map", "f", "arr"], { f: fn, arr: [1n, 2n, 3n] })).toEqual([2n, 4n, 6n]);
  });

  it("map with inline fn", () => {
    expect(run(["map", ["fn", ["x"], ["*", "x", 2]], "arr"], { arr: [1n, 2n, 3n] })).toEqual([
      2n,
      4n,
      6n,
    ]);
  });

  it("filter keeps evens", () => {
    const isEven = (x: unknown) => (x as bigint) % 2n === 0n;
    expect(run(["filter", "f", "arr"], { f: isEven, arr: [1n, 2n, 3n, 4n] })).toEqual([2n, 4n]);
  });

  it("reduce sum", () => {
    const add = (a: unknown, b: unknown) => (a as bigint) + (b as bigint);
    expect(run(["reduce", "f", 0, "arr"], { f: add, arr: [1n, 2n, 3n, 4n] })).toBe(10n);
  });
});

// --- count / merge / keys / vals ---

describe("count, merge, keys, vals", () => {
  it("count array", () => {
    expect(run(["count", "arr"], { arr: [1n, 2n, 3n] })).toBe(3n);
  });

  it("count record", () => {
    expect(run(["count", "r"], { r: { a: 1n, b: 2n } })).toBe(2n);
  });

  it("merge records", () => {
    expect(run(["merge", "r1", "r2"], { r1: { a: 1n }, r2: { b: 2n } })).toEqual({
      a: 1n,
      b: 2n,
    });
  });

  it("merge r2 overrides r1", () => {
    expect(run(["merge", "r1", "r2"], { r1: { a: 1n, b: 2n }, r2: { b: 99n } })).toEqual({
      a: 1n,
      b: 99n,
    });
  });

  it("keys returns array of strings", () => {
    const result = run(["keys", "r"], { r: { x: 1n, y: 2n } }) as string[];
    expect(result.sort()).toEqual(["x", "y"]);
  });

  it("vals returns array of values", () => {
    const result = run(["vals", "r"], { r: { x: 10n, y: 20n } }) as unknown[];
    expect(result.sort()).toEqual([10n, 20n]);
  });
});

// --- String ops ---

describe("string ops", () => {
  it("concat two string variables", () => {
    expect(run(["concat", "a", "b"], { a: "hello", b: " world" })).toBe("hello world");
  });

  it("concat more string variables", () => {
    expect(run(["concat", "a", "b"], { a: "foo", b: "bar" })).toBe("foobar");
  });

  it("slice", () => {
    expect(run(["slice", "s", 0, 5], { s: "hello world" })).toBe("hello");
  });

  it("to-string int", () => {
    expect(run(["to-string", 42])).toBe("42");
  });

  it("to-string float", () => {
    expect(run(["to-string", 3.14])).toBe("3.14");
  });

  it("to-string bool", () => {
    expect(run(["to-string", true])).toBe("true");
  });

  it("to-string null", () => {
    expect(run(["to-string", null])).toBe("null");
  });

  it("parse-number integer string", () => {
    expect(run(["parse-number", "s"], { s: "42" })).toBe(42n);
  });

  it("parse-number float string", () => {
    expect(run(["parse-number", "s"], { s: "3.14" })).toBe(3.14);
  });

  it("parse-number invalid returns null", () => {
    expect(run(["parse-number", "s"], { s: "abc" })).toBe(null);
  });
});

// --- Variant construction ---

describe("variants", () => {
  it("unit variant (no fields)", () => {
    expect(run(["None"])).toEqual({ $tag: "None" });
  });

  it("variant with one field", () => {
    expect(run(["Some", 42])).toEqual({ $tag: "Some", $0: 42n });
  });

  it("variant with multiple fields", () => {
    expect(run(["Rect", 10, 20])).toEqual({ $tag: "Rect", $0: 10n, $1: 20n });
  });
});

// --- match ---

describe("match", () => {
  it("matches correct branch - Circle", () => {
    const expr: Expr = [
      "match",
      "shape",
      [
        ["Circle", "r"],
        ["*", "r", "r"],
      ],
      [
        ["Rect", "w", "h"],
        ["*", "w", "h"],
      ],
    ];
    expect(run(expr, { shape: { $tag: "Circle", $0: 5n } })).toBe(25n);
  });

  it("matches correct branch - Rect", () => {
    const expr: Expr = [
      "match",
      "shape",
      [
        ["Circle", "r"],
        ["*", "r", "r"],
      ],
      [
        ["Rect", "w", "h"],
        ["*", "w", "h"],
      ],
    ];
    expect(run(expr, { shape: { $tag: "Rect", $0: 3n, $1: 4n } })).toBe(12n);
  });

  it("non-exhaustive match throws", () => {
    const expr: Expr = ["match", "shape", [["Circle", "r"], "r"]];
    expect(() => run(expr, { shape: { $tag: "Rect", $0: 1n, $1: 2n } })).toThrow(
      "non-exhaustive match",
    );
  });

  it("unit variant match", () => {
    const expr: Expr = ["match", "v", [["None"], 0], [["Some", "x"], "x"]];
    expect(run(expr, { v: { $tag: "None" } })).toBe(0n);
    expect(run(expr, { v: { $tag: "Some", $0: 99n } })).toBe(99n);
  });
});

// --- untyped ---

describe("untyped", () => {
  it("passes through the inner expression", () => {
    expect(run(["untyped", 42])).toBe(42n);
  });

  it("passes through variable ref", () => {
    expect(run(["untyped", "x"], { x: "hello" })).toBe("hello");
  });
});

// --- CompileError for effects ---

describe("CompileError for effects", () => {
  it("perform throws CompileError", () => {
    expect(() => compile(["perform", "Error", null])).toThrow(CompileError);
  });

  it("handle throws CompileError", () => {
    expect(() => compile(["handle", 42, [["return", "x"], "x"]])).toThrow(CompileError);
  });

  it("CompileError has path", () => {
    try {
      compile(["perform", "Error", null]);
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError);
      expect((e as CompileError).path).toEqual([]);
    }
  });

  it("nested perform throws with path", () => {
    try {
      compile(["+", 1, ["perform", "Error", null]]);
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError);
      expect((e as CompileError).path).toEqual([2]);
    }
  });
});

// --- Performance: callable multiple times ---

describe("performance: reusable compiled function", () => {
  it("same compiled fn called with different envs", () => {
    const fn = compile(["+", "x", "y"]);
    expect(fn({ x: 1n, y: 2n })).toBe(3n);
    expect(fn({ x: 10n, y: 20n })).toBe(30n);
    expect(fn({ x: 100n, y: 200n })).toBe(300n);
  });

  it("compiled fn does not share state between calls", () => {
    const fn = compile(["let", [["z", ["+", "x", 1]]], "z"]);
    expect(fn({ x: 5n })).toBe(6n);
    expect(fn({ x: 10n })).toBe(11n);
  });
});

// --- Correctness: JIT matches interpreter ---

describe("correctness: JIT matches interpreter", () => {
  // Expressions where both JIT and interpreter should agree.
  // We convert JIT output to Value for comparison.

  const cases: Array<{ label: string; expr: Expr; env: Record<string, unknown> }> = [
    { label: "null atom", expr: null, env: {} },
    { label: "true atom", expr: true, env: {} },
    { label: "false atom", expr: false, env: {} },
    { label: "int atom", expr: 42, env: {} },
    { label: "float atom", expr: 3.14, env: {} },
    { label: "variable ref", expr: "x", env: { x: 7n } },
    { label: "int addition", expr: ["+", 3, 5], env: {} },
    { label: "float addition", expr: ["+", 1.5, 2.5], env: {} },
    { label: "subtraction", expr: ["-", 10, 3], env: {} },
    { label: "multiplication", expr: ["*", 6, 7], env: {} },
    { label: "integer division", expr: ["/", 10, 3], env: {} },
    { label: "modulo", expr: ["%", 10, 3], env: {} },
    { label: "equality true", expr: ["==", 5, 5], env: {} },
    { label: "equality false", expr: ["==", 5, 6], env: {} },
    { label: "inequality", expr: ["!=", 1, 2], env: {} },
    { label: "less than", expr: ["<", 3, 5], env: {} },
    { label: "greater than", expr: [">", 5, 3], env: {} },
    { label: "and", expr: ["and", true, false], env: {} },
    { label: "or", expr: ["or", false, true], env: {} },
    { label: "not", expr: ["not", true], env: {} },
    { label: "if then", expr: ["if", true, 1, 2], env: {} },
    { label: "if else", expr: ["if", false, 1, 2], env: {} },
    { label: "do sequence", expr: ["do", 1, 2, 3], env: {} },
    { label: "let binding", expr: ["let", [["x", 5]], ["+", "x", 1]], env: {} },
    { label: "to-string int", expr: ["to-string", 42], env: {} },
    { label: "to-string bool", expr: ["to-string", true], env: {} },
    { label: "parse-number int", expr: ["parse-number", "s"], env: { s: "123" } },
    { label: "parse-number float", expr: ["parse-number", "s"], env: { s: "1.5" } },
    { label: "parse-number invalid", expr: ["parse-number", "s"], env: { s: "xyz" } },
    {
      label: "variant construction",
      expr: ["Some", 42],
      env: {},
    },
    {
      label: "match variant",
      expr: ["match", "v", [["Some", "x"], "x"], [["None"], 0]],
      env: { v: { $tag: "Some", $0: 10n } },
    },
  ];

  for (const { label, expr, env } of cases) {
    it(label, () => {
      const jitResult = compile(expr)(env);
      const interpEnv = envFromRecord(env);
      const interpResult = evaluate(expr, interpEnv);
      expect(interpResult.ok).toBe(true);
      if (interpResult.ok) {
        expect(toValue(jitResult)).toEqual(interpResult.value);
      }
    });
  }
});

// --- cond ---

describe("cond", () => {
  it("first matching clause", () => {
    expect(run(["cond", [true, 1], ["else", 2]])).toBe(1n);
  });

  it("else clause", () => {
    expect(run(["cond", [false, 1], ["else", 2]])).toBe(2n);
  });

  it("second clause matches", () => {
    expect(run(["cond", ["eq1", 1], ["eq2", 2], ["else", 0]], { eq1: false, eq2: true })).toBe(2n);
  });
});

// --- is / as ---

describe("is and as", () => {
  it("is int true", () => {
    expect(run(["is", "int", 42])).toBe(true);
  });

  it("is int false for float", () => {
    expect(run(["is", "int", 3.14])).toBe(false);
  });

  it("is string", () => {
    expect(run(["is", "string", "s"], { s: "hello" })).toBe(true);
  });

  it("as passes when type matches", () => {
    expect(run(["as", "int", 42])).toBe(42n);
  });

  it("as throws when type does not match", () => {
    expect(() => run(["as", "int", 3.14])).toThrow();
  });
});
