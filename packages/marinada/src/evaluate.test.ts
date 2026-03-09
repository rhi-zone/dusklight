import { describe, it, expect } from "bun:test";
import { evaluate, EMPTY_ENV } from "./evaluate.ts";
import type { Value } from "./value.ts";
import type { Expr } from "./types.ts";

// --- Helpers ---

function ok(value: Value): { ok: true; value: Value } {
  return { ok: true, value };
}

function err(code: string) {
  return expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) });
}

function int(n: number | bigint): Value {
  return { kind: "int", value: typeof n === "bigint" ? n : BigInt(n) };
}

function float(n: number): Value {
  return { kind: "float", value: n };
}

function str(s: string): Value {
  return { kind: "string", value: s };
}

function bool(b: boolean): Value {
  return { kind: "bool", value: b };
}

function arr(...vals: Value[]): Value {
  return { kind: "array", value: vals };
}

function rec(obj: Record<string, Value>): Value {
  return { kind: "record", value: new Map(Object.entries(obj)) };
}

function variant(tag: string, ...fields: Value[]): Value {
  return { kind: "variant", tag, fields };
}

const NULL: Value = { kind: "null" };

// --- Tests ---

describe("atoms", () => {
  it("null", () => {
    expect(evaluate(null)).toEqual(ok(NULL));
  });

  it("boolean true", () => {
    expect(evaluate(true)).toEqual(ok(bool(true)));
  });

  it("boolean false", () => {
    expect(evaluate(false)).toEqual(ok(bool(false)));
  });

  it("integer literal becomes int with BigInt", () => {
    expect(evaluate(42)).toEqual(ok(int(42)));
    expect(evaluate(0)).toEqual(ok(int(0)));
    expect(evaluate(-7)).toEqual(ok(int(-7)));
  });

  it("float literal becomes float", () => {
    expect(evaluate(3.14)).toEqual(ok(float(3.14)));
    expect(evaluate(-0.5)).toEqual(ok(float(-0.5)));
  });

  it("string in non-op position is a variable lookup", () => {
    const env = EMPTY_ENV.extend({ x: int(99) });
    const r = evaluate("x", env);
    expect(r).toEqual(ok(int(99)));
  });

  it("undefined variable returns error", () => {
    expect(evaluate("missing")).toEqual(err("UNDEFINED_VAR"));
  });
});

describe("arithmetic", () => {
  it("int + int = int", () => {
    expect(evaluate(["+", 3, 5])).toEqual(ok(int(8)));
  });

  it("int - int = int", () => {
    expect(evaluate(["-", 10, 4])).toEqual(ok(int(6)));
  });

  it("int * int = int", () => {
    expect(evaluate(["*", 6, 7])).toEqual(ok(int(42)));
  });

  it("int / int = int (truncating)", () => {
    expect(evaluate(["/", 10, 3])).toEqual(ok(int(3)));
  });

  it("int % int = int", () => {
    expect(evaluate(["%", 10, 3])).toEqual(ok(int(1)));
  });

  it("float + float = float", () => {
    expect(evaluate(["+", 1.5, 2.5])).toEqual(ok(float(4.0)));
  });

  it("int + float = float", () => {
    const r = evalOk(["+", 3, 1.5]);
    expect(r.kind).toBe("float");
    expect((r as { kind: "float"; value: number }).value).toBeCloseTo(4.5);
  });

  it("float + int = float", () => {
    const r = evalOk(["+", 1.5, 3]);
    expect(r.kind).toBe("float");
  });

  it("division by zero (int) returns error", () => {
    expect(evaluate(["/", 5, 0])).toEqual(err("DIVISION_BY_ZERO"));
  });

  it("type error: arithmetic on non-number", () => {
    expect(evaluate(["+", "x", 1], EMPTY_ENV.extend({ x: str("hi") }))).toEqual(err("TYPE_ERROR"));
  });

  it("arity error: wrong number of args", () => {
    expect(evaluate(["+", 1, 2, 3])).toEqual(err("ARITY_ERROR"));
  });
});

describe("comparison", () => {
  it("== same ints", () => {
    expect(evaluate(["==", 5, 5])).toEqual(ok(bool(true)));
  });

  it("== different ints", () => {
    expect(evaluate(["==", 5, 6])).toEqual(ok(bool(false)));
  });

  it("!= ints", () => {
    expect(evaluate(["!=", 5, 6])).toEqual(ok(bool(true)));
  });

  it("== strings", () => {
    expect(
      evaluate(["==", "a", "b"], EMPTY_ENV.extend({ a: str("hello"), b: str("hello") })),
    ).toEqual(ok(bool(true)));
  });

  it("== null == null", () => {
    expect(evaluate(["==", null, null])).toEqual(ok(bool(true)));
  });

  it("== int vs float with same numeric value: different kinds = unequal", () => {
    // 5.0 in JS has Number.isInteger(5.0) === true, so it evaluates as int(5)
    // Both sides become int(5), so they are equal
    expect(evaluate(["==", 5, 5])).toEqual(ok(bool(true)));
    // To compare int vs float we need an actual float (one with decimal fraction)
    expect(evaluate(["==", 5, 5.5])).toEqual(ok(bool(false)));
  });

  it("< numbers", () => {
    expect(evaluate(["<", 3, 5])).toEqual(ok(bool(true)));
    expect(evaluate(["<", 5, 3])).toEqual(ok(bool(false)));
  });

  it("> numbers", () => {
    expect(evaluate([">", 5, 3])).toEqual(ok(bool(true)));
  });

  it("<= numbers", () => {
    expect(evaluate(["<=", 3, 3])).toEqual(ok(bool(true)));
    expect(evaluate(["<=", 4, 3])).toEqual(ok(bool(false)));
  });

  it(">= numbers", () => {
    expect(evaluate([">=", 3, 3])).toEqual(ok(bool(true)));
  });

  it("< type error: non-number", () => {
    expect(evaluate(["<", "a", "b"], EMPTY_ENV.extend({ a: str("x"), b: str("y") }))).toEqual(
      err("TYPE_ERROR"),
    );
  });
});

describe("logic", () => {
  it("and true true", () => {
    expect(evaluate(["and", true, true])).toEqual(ok(bool(true)));
  });

  it("and true false", () => {
    expect(evaluate(["and", true, false])).toEqual(ok(bool(false)));
  });

  it("or false true", () => {
    expect(evaluate(["or", false, true])).toEqual(ok(bool(true)));
  });

  it("or false false", () => {
    expect(evaluate(["or", false, false])).toEqual(ok(bool(false)));
  });

  it("not true", () => {
    expect(evaluate(["not", true])).toEqual(ok(bool(false)));
  });

  it("not false", () => {
    expect(evaluate(["not", false])).toEqual(ok(bool(true)));
  });

  it("and type error: non-bool", () => {
    expect(evaluate(["and", 1, true])).toEqual(err("TYPE_ERROR"));
  });
});

describe("control flow", () => {
  it("if true branch", () => {
    expect(evaluate(["if", true, 1, 2])).toEqual(ok(int(1)));
  });

  it("if false branch", () => {
    expect(evaluate(["if", false, 1, 2])).toEqual(ok(int(2)));
  });

  it("if type error: non-bool condition", () => {
    expect(evaluate(["if", 1, 1, 2])).toEqual(err("TYPE_ERROR"));
  });

  it("do evaluates all, returns last", () => {
    expect(evaluate(["do", 1, 2, 3])).toEqual(ok(int(3)));
  });

  it("do with single expr", () => {
    expect(evaluate(["do", 42])).toEqual(ok(int(42)));
  });
});

describe("let", () => {
  it("basic let binding", () => {
    expect(evaluate(["let", [["x", 5]], ["*", "x", "x"]])).toEqual(ok(int(25)));
  });

  it("multiple sequential bindings, later sees earlier", () => {
    // y = x + 1 should see x = 10
    expect(
      evaluate([
        "let",
        [
          ["x", 10],
          ["y", ["+", "x", 1]],
        ],
        "y",
      ]),
    ).toEqual(ok(int(11)));
  });

  it("let binding shadows outer env", () => {
    const env = EMPTY_ENV.extend({ x: int(100) });
    expect(evaluate(["let", [["x", 5]], "x"], env)).toEqual(ok(int(5)));
  });

  it("let body can use binding", () => {
    // String literals as values must be held in vars; " world" as a bare string
    // is a var reference, so we supply it in the env.
    const env = EMPTY_ENV.extend({ helloStr: str("hello"), worldStr: str(" world") });
    expect(
      evaluate(["let", [["greeting", "helloStr"]], ["concat", "greeting", "worldStr"]], env),
    ).toEqual(ok(str("hello world")));
  });

  it("undefined var in let value returns error", () => {
    expect(evaluate(["let", [["x", "missing"]], "x"])).toEqual(err("UNDEFINED_VAR"));
  });
});

describe("letrec", () => {
  it("simple recursive function: factorial", () => {
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
    expect(evaluate(fact)).toEqual(ok(int(120)));
  });

  it("mutually recursive functions", () => {
    // isEven and isOdd via mutual recursion
    const expr: Expr = [
      "letrec",
      [
        ["isEven", ["fn", ["n"], ["if", ["==", "n", 0], true, ["call", "isOdd", ["-", "n", 1]]]]],
        ["isOdd", ["fn", ["n"], ["if", ["==", "n", 0], false, ["call", "isEven", ["-", "n", 1]]]]],
      ],
      ["call", "isEven", 4],
    ];
    expect(evaluate(expr)).toEqual(ok(bool(true)));
  });
});

describe("get / set", () => {
  // In Marinada, bare strings in non-op position are variable references.
  // To pass a string key, the string must be held in a variable.
  it("get field from record via string key variable", () => {
    const expr: Expr = ["get", "rec", "nameKey"];
    const env = EMPTY_ENV.extend({ rec: rec({ name: str("alice") }), nameKey: str("name") });
    expect(evaluate(expr, env)).toEqual(ok(str("alice")));
  });

  it("get missing field returns null", () => {
    const expr: Expr = ["get", "rec", "missingKey"];
    const env = EMPTY_ENV.extend({
      rec: rec({ name: str("alice") }),
      missingKey: str("noSuchField"),
    });
    expect(evaluate(expr, env)).toEqual(ok(NULL));
  });

  it("get array element by int index literal", () => {
    const expr: Expr = ["get", "a", 1];
    const env = EMPTY_ENV.extend({ a: arr(int(10), int(20), int(30)) });
    expect(evaluate(expr, env)).toEqual(ok(int(20)));
  });

  it("get out-of-bounds array returns null", () => {
    const expr: Expr = ["get", "a", 5];
    const env = EMPTY_ENV.extend({ a: arr(int(1)) });
    expect(evaluate(expr, env)).toEqual(ok(NULL));
  });

  it("get type error: string key on array", () => {
    const expr: Expr = ["get", "a", "notAnIndex"];
    const env = EMPTY_ENV.extend({
      a: arr(int(1)),
      notAnIndex: str("bad"),
    });
    expect(evaluate(expr, env)).toEqual(err("TYPE_ERROR"));
  });

  it("set field on record returns new record", () => {
    const expr: Expr = ["set", "rec", "ageKey", 30];
    const env = EMPTY_ENV.extend({ rec: rec({ name: str("bob") }), ageKey: str("age") });
    const result = evalOk(expr, env);
    expect(result.kind).toBe("record");
    const m = (result as { kind: "record"; value: Map<string, Value> }).value;
    expect(m.get("age")).toEqual(int(30));
    expect(m.get("name")).toEqual(str("bob"));
  });

  it("set on array returns new array", () => {
    const expr: Expr = ["set", "a", 1, 99];
    const env = EMPTY_ENV.extend({ a: arr(int(0), int(1), int(2)) });
    const result = evalOk(expr, env);
    expect(result).toEqual(arr(int(0), int(99), int(2)));
  });

  it("get-in nested record via path variable", () => {
    const inner = rec({ z: int(42) });
    const outer = rec({ inner });
    // Path must be an array value — held in a variable
    const path = arr(str("inner"), str("z"));
    const env = EMPTY_ENV.extend({ obj: outer, path });
    const expr: Expr = ["get-in", "obj", "path"];
    expect(evaluate(expr, env)).toEqual(ok(int(42)));
  });

  it("set-in nested via path variable", () => {
    const inner = rec({ z: int(0) });
    const outer = rec({ inner });
    const path = arr(str("inner"), str("z"));
    const env = EMPTY_ENV.extend({ obj: outer, path });
    const expr: Expr = ["set-in", "obj", "path", 99];
    const result = evalOk(expr, env);
    expect(result.kind).toBe("record");
    const newInner = (result as { kind: "record"; value: Map<string, Value> }).value.get("inner")!;
    expect((newInner as { kind: "record"; value: Map<string, Value> }).value.get("z")).toEqual(
      int(99),
    );
  });
});

describe("type ops", () => {
  it("is int true", () => {
    expect(evaluate(["is", "int", 42])).toEqual(ok(bool(true)));
  });

  it("is int false for float", () => {
    expect(evaluate(["is", "int", 3.14])).toEqual(ok(bool(false)));
  });

  it("is string true", () => {
    expect(evaluate(["is", "string", "x"], EMPTY_ENV.extend({ x: str("hi") }))).toEqual(
      ok(bool(true)),
    );
  });

  it("is null", () => {
    expect(evaluate(["is", "null", null])).toEqual(ok(bool(true)));
  });

  it("as correct type passes through", () => {
    expect(evaluate(["as", "int", 42])).toEqual(ok(int(42)));
  });

  it("as wrong type returns error", () => {
    expect(evaluate(["as", "int", 3.14])).toEqual(err("TYPE_ERROR"));
  });

  it("untyped is identity", () => {
    expect(evaluate(["untyped", 42])).toEqual(ok(int(42)));
  });
});

describe("collections", () => {
  it("map doubles each element", () => {
    // [1, 2, 3] as array literal: we need to wrap it properly
    // Actually in Marinada [1,2,3] is a call with op=1 (number) — not valid.
    // We need to pass the array as a variable.
    const env = EMPTY_ENV.extend({ nums: arr(int(1), int(2), int(3)) });
    const expr2: Expr = ["map", ["fn", ["x"], ["*", "x", 2]], "nums"];
    expect(evaluate(expr2, env)).toEqual(ok(arr(int(2), int(4), int(6))));
  });

  it("filter keeps matching elements", () => {
    const env = EMPTY_ENV.extend({ nums: arr(int(1), int(2), int(3), int(4)) });
    const expr: Expr = ["filter", ["fn", ["x"], ["==", ["%", "x", 2], 0]], "nums"];
    expect(evaluate(expr, env)).toEqual(ok(arr(int(2), int(4))));
  });

  it("reduce sums array", () => {
    const env = EMPTY_ENV.extend({ nums: arr(int(1), int(2), int(3), int(4)) });
    const expr: Expr = ["reduce", ["fn", ["acc", "x"], ["+", "acc", "x"]], 0, "nums"];
    expect(evaluate(expr, env)).toEqual(ok(int(10)));
  });

  it("count array", () => {
    const env = EMPTY_ENV.extend({ nums: arr(int(1), int(2), int(3)) });
    expect(evaluate(["count", "nums"], env)).toEqual(ok(int(3)));
  });

  it("count record", () => {
    const env = EMPTY_ENV.extend({ rec: rec({ a: int(1), b: int(2) }) });
    expect(evaluate(["count", "rec"], env)).toEqual(ok(int(2)));
  });

  it("merge records, r2 overrides r1", () => {
    const r1 = rec({ a: int(1), b: int(2) });
    const r2 = rec({ b: int(99), c: int(3) });
    const env = EMPTY_ENV.extend({ r1, r2 });
    const result = evalOk(["merge", "r1", "r2"], env);
    expect(result.kind).toBe("record");
    const m = (result as { kind: "record"; value: Map<string, Value> }).value;
    expect(m.get("a")).toEqual(int(1));
    expect(m.get("b")).toEqual(int(99));
    expect(m.get("c")).toEqual(int(3));
  });

  it("keys returns array of strings", () => {
    const env = EMPTY_ENV.extend({ rec: rec({ a: int(1), b: int(2) }) });
    const result = evalOk(["keys", "rec"], env);
    expect(result.kind).toBe("array");
    const keys = (result as { kind: "array"; value: Value[] }).value.map(
      (v) => (v as { kind: "string"; value: string }).value,
    );
    expect(keys.sort()).toEqual(["a", "b"]);
  });

  it("vals returns array of values", () => {
    const env = EMPTY_ENV.extend({ rec: rec({ x: int(10) }) });
    const result = evalOk(["vals", "rec"], env);
    expect(result).toEqual(arr(int(10)));
  });

  it("map type error: non-array", () => {
    const env = EMPTY_ENV.extend({ x: int(5) });
    expect(evaluate(["map", ["fn", ["v"], "v"], "x"], env)).toEqual(err("TYPE_ERROR"));
  });

  it("filter type error: predicate returns non-bool", () => {
    const env = EMPTY_ENV.extend({ nums: arr(int(1)) });
    const expr: Expr = ["filter", ["fn", ["x"], "x"], "nums"];
    expect(evaluate(expr, env)).toEqual(err("TYPE_ERROR"));
  });
});

describe("string ops", () => {
  it("concat strings", () => {
    const env = EMPTY_ENV.extend({ a: str("hello"), b: str(" world") });
    expect(evaluate(["concat", "a", "b"], env)).toEqual(ok(str("hello world")));
  });

  it("concat multiple strings", () => {
    const env = EMPTY_ENV.extend({ a: str("a"), b: str("b"), c: str("c") });
    expect(evaluate(["concat", "a", "b", "c"], env)).toEqual(ok(str("abc")));
  });

  it("slice string", () => {
    const env = EMPTY_ENV.extend({ s: str("hello world") });
    expect(evaluate(["slice", "s", 0, 5], env)).toEqual(ok(str("hello")));
  });

  it("to-string int", () => {
    expect(evaluate(["to-string", 42])).toEqual(ok(str("42")));
  });

  it("to-string float", () => {
    expect(evaluate(["to-string", 3.14])).toEqual(ok(str("3.14")));
  });

  it("to-string bool", () => {
    expect(evaluate(["to-string", true])).toEqual(ok(str("true")));
  });

  it("to-string null", () => {
    expect(evaluate(["to-string", null])).toEqual(ok(str("null")));
  });

  it("parse-number integer string", () => {
    const env = EMPTY_ENV.extend({ s: str("42") });
    expect(evaluate(["parse-number", "s"], env)).toEqual(ok(int(42)));
  });

  it("parse-number float string", () => {
    const env = EMPTY_ENV.extend({ s: str("3.14") });
    const result = evalOk(["parse-number", "s"], env);
    expect(result.kind).toBe("float");
    expect((result as { kind: "float"; value: number }).value).toBeCloseTo(3.14);
  });

  it("parse-number invalid returns null", () => {
    const env = EMPTY_ENV.extend({ s: str("nope") });
    expect(evaluate(["parse-number", "s"], env)).toEqual(ok(NULL));
  });

  it("concat type error: non-string", () => {
    const env = EMPTY_ENV.extend({ a: str("hi"), b: int(5) });
    expect(evaluate(["concat", "a", "b"], env)).toEqual(err("TYPE_ERROR"));
  });
});

describe("fn and call", () => {
  it("create and call a function", () => {
    const expr: Expr = ["call", ["fn", ["x", "y"], ["+", "x", "y"]], 3, 4];
    expect(evaluate(expr)).toEqual(ok(int(7)));
  });

  it("closure captures environment", () => {
    // let adder = fn(x) -> x + base
    const expr: Expr = [
      "let",
      [
        ["base", 10],
        ["adder", ["fn", ["x"], ["+", "x", "base"]]],
      ],
      ["call", "adder", 5],
    ];
    expect(evaluate(expr)).toEqual(ok(int(15)));
  });

  it("fn arity error", () => {
    const expr: Expr = ["call", ["fn", ["x"], "x"], 1, 2];
    expect(evaluate(expr)).toEqual(err("ARITY_ERROR"));
  });

  it("call non-fn returns TYPE_ERROR", () => {
    const env = EMPTY_ENV.extend({ x: int(5) });
    expect(evaluate(["call", "x"], env)).toEqual(err("TYPE_ERROR"));
  });

  it("fn with typed params (name only extracted)", () => {
    const expr: Expr = ["call", ["fn", [["x", "int"]], ["*", "x", 2]], 7];
    expect(evaluate(expr)).toEqual(ok(int(14)));
  });
});

describe("DU variants and match", () => {
  it("construct a zero-field variant", () => {
    expect(evaluate(["Red"])).toEqual(ok(variant("Red")));
  });

  it("construct a variant with fields", () => {
    expect(evaluate(["Circle", 1.5])).toEqual(ok(variant("Circle", float(1.5))));
  });

  it("match on variant", () => {
    const env = EMPTY_ENV.extend({ shape: variant("Circle", float(1.0)) });
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
    const r = evalOk(expr, env);
    expect(r.kind).toBe("float");
    expect((r as { kind: "float"; value: number }).value).toBeCloseTo(1.0);
  });

  it("match selects correct branch", () => {
    const env = EMPTY_ENV.extend({ shape: variant("Rect", float(3.0), float(4.0)) });
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
    const r = evalOk(expr, env);
    expect(r.kind).toBe("float");
    expect((r as { kind: "float"; value: number }).value).toBeCloseTo(12.0);
  });

  it("match zero-field variant", () => {
    const env = EMPTY_ENV.extend({ color: variant("Red") });
    const expr: Expr = ["match", "color", [["Red"], 1], [["Green"], 2], [["Blue"], 3]];
    expect(evaluate(expr, env)).toEqual(ok(int(1)));
  });

  it("non-exhaustive match returns error", () => {
    const env = EMPTY_ENV.extend({ shape: variant("Triangle") });
    const expr: Expr = ["match", "shape", [["Circle", "r"], "r"]];
    expect(evaluate(expr, env)).toEqual(err("NON_EXHAUSTIVE_MATCH"));
  });

  it("match with recursive DU", () => {
    // option: Some(v) | None
    const some = variant("Some", int(42));
    const env = EMPTY_ENV.extend({ opt: some });
    const expr: Expr = ["match", "opt", [["Some", "v"], "v"], [["None"], 0]];
    expect(evaluate(expr, env)).toEqual(ok(int(42)));
  });

  it("DU round-trip via letrec and match", () => {
    // Build a linked list and sum it
    // List = Cons(head, tail) | Nil
    const list = variant(
      "Cons",
      int(1),
      variant("Cons", int(2), variant("Cons", int(3), variant("Nil"))),
    );
    const env = EMPTY_ENV.extend({ myList: list });
    const expr: Expr = [
      "letrec",
      [
        [
          "sum",
          [
            "fn",
            ["lst"],
            [
              "match",
              "lst",
              [["Nil"], 0],
              [
                ["Cons", "head", "tail"],
                ["+", "head", ["call", "sum", "tail"]],
              ],
            ],
          ],
        ],
      ],
      ["call", "sum", "myList"],
    ];
    expect(evaluate(expr, env)).toEqual(ok(int(6)));
  });
});

describe("equality", () => {
  it("record equality", () => {
    const r1 = rec({ a: int(1), b: str("x") });
    const r2 = rec({ a: int(1), b: str("x") });
    const env = EMPTY_ENV.extend({ r1, r2 });
    expect(evaluate(["==", "r1", "r2"], env)).toEqual(ok(bool(true)));
  });

  it("array equality", () => {
    const a1 = arr(int(1), int(2));
    const a2 = arr(int(1), int(2));
    const env = EMPTY_ENV.extend({ a1, a2 });
    expect(evaluate(["==", "a1", "a2"], env)).toEqual(ok(bool(true)));
  });

  it("variant equality", () => {
    const v1 = variant("Some", int(1));
    const v2 = variant("Some", int(1));
    const env = EMPTY_ENV.extend({ v1, v2 });
    expect(evaluate(["==", "v1", "v2"], env)).toEqual(ok(bool(true)));
  });

  it("variant inequality different tag", () => {
    const v1 = variant("Some", int(1));
    const v2 = variant("None");
    const env = EMPTY_ENV.extend({ v1, v2 });
    expect(evaluate(["==", "v1", "v2"], env)).toEqual(ok(bool(false)));
  });
});

describe("error handling", () => {
  it("unknown op returns UNKNOWN_OP", () => {
    expect(evaluate(["nonexistent-op", 1])).toEqual(err("UNKNOWN_OP"));
  });

  it("empty array returns error", () => {
    expect(evaluate([])).toEqual(err("UNKNOWN_OP"));
  });

  it("error propagates path from nested expr", () => {
    const r = evaluate(["+", ["missing-var"], 1]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.path[0]).toBe(1);
    }
  });
});

describe("complex programs", () => {
  it("fibonacci via letrec", () => {
    const expr: Expr = [
      "letrec",
      [
        [
          "fib",
          [
            "fn",
            ["n"],
            [
              "if",
              ["<=", "n", 1],
              "n",
              ["+", ["call", "fib", ["-", "n", 1]], ["call", "fib", ["-", "n", 2]]],
            ],
          ],
        ],
      ],
      ["call", "fib", 10],
    ];
    expect(evaluate(expr)).toEqual(ok(int(55)));
  });

  it("map then filter then reduce", () => {
    const env = EMPTY_ENV.extend({ nums: arr(int(1), int(2), int(3), int(4), int(5)) });
    // Double, keep evens, sum
    const expr: Expr = [
      "reduce",
      ["fn", ["acc", "x"], ["+", "acc", "x"]],
      0,
      [
        "filter",
        ["fn", ["x"], ["==", ["%", "x", 2], 0]],
        ["map", ["fn", ["x"], ["*", "x", 2]], "nums"],
      ],
    ];
    // doubled: 2,4,6,8,10; evens: 2,4,6,8,10; sum: 30
    expect(evaluate(expr, env)).toEqual(ok(int(30)));
  });

  it("nested let with closures", () => {
    const expr: Expr = [
      "let",
      [["make-adder", ["fn", ["n"], ["fn", ["x"], ["+", "n", "x"]]]]],
      ["let", [["add5", ["call", "make-adder", 5]]], ["call", "add5", 10]],
    ];
    expect(evaluate(expr)).toEqual(ok(int(15)));
  });

  it("to-string on int in concat", () => {
    const expr: Expr = ["concat", "hello", ["to-string", 42]];
    const env = EMPTY_ENV.extend({ hello: str("hello") });
    expect(evaluate(expr, env)).toEqual(ok(str("hello42")));
  });
});

// Helper to allow env parameter in evalOk
function evalOk(expr: Expr, env = EMPTY_ENV): Value {
  const r = evaluate(expr, env);
  if (!r.ok) throw new Error(`Expected ok, got error: ${JSON.stringify(r.error)}`);
  return r.value;
}
