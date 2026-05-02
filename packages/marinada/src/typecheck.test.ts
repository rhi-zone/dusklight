import { describe, it, expect } from "bun:test";
import { typecheck, typecheckModule, EMPTY_TYPE_ENV, prettyType } from "./typecheck.ts";
import type { MType } from "./typecheck.ts";
import type { Expr } from "./types.ts";

// --- Helpers ---

function ok(type: MType) {
  return expect.objectContaining({ ok: true, type });
}

function err(code: string) {
  return expect.objectContaining({
    ok: false,
    errors: expect.arrayContaining([expect.objectContaining({ code })]),
  });
}

const UNKNOWN: MType = { kind: "unknown" };
const NULL_T: MType = { kind: "null" };
const BOOL: MType = { kind: "bool" };
const INT: MType = { kind: "int" };
const FLOAT: MType = { kind: "float" };
const STRING: MType = { kind: "string" };

// --- Atoms ---

describe("atoms", () => {
  it("null → null", () => {
    expect(typecheck(null)).toEqual(ok(NULL_T));
  });

  it("true → bool", () => {
    expect(typecheck(true)).toEqual(ok(BOOL));
  });

  it("false → bool", () => {
    expect(typecheck(false)).toEqual(ok(BOOL));
  });

  it("integer → int", () => {
    expect(typecheck(42)).toEqual(ok(INT));
    expect(typecheck(0)).toEqual(ok(INT));
    expect(typecheck(-7)).toEqual(ok(INT));
  });

  it("float → float", () => {
    expect(typecheck(3.14)).toEqual(ok(FLOAT));
    expect(typecheck(-0.5)).toEqual(ok(FLOAT));
  });

  it("known variable → its type", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: INT });
    expect(typecheck("x", env)).toEqual(ok(INT));
  });

  it("unknown variable → error", () => {
    const result = typecheck("missing");
    expect(result).toEqual(err("UNDEFINED_VAR"));
  });
});

// --- Arithmetic ---

describe("arithmetic", () => {
  it("int + int → int", () => {
    expect(typecheck(["+", 1, 2])).toEqual(ok(INT));
  });

  it("float + float → float", () => {
    expect(typecheck(["+", 1.5, 2.5])).toEqual(ok(FLOAT));
  });

  // Phase 1 design: NO int→float widening. `1 + 1.5` is a TYPE_MISMATCH.
  // Use `["as", "float", 1]` to widen explicitly.
  it("int + float → TYPE_MISMATCH (no widening)", () => {
    expect(typecheck(["+", 1, 2.5])).toEqual(err("TYPE_MISMATCH"));
  });

  it("float + int → TYPE_MISMATCH (no widening)", () => {
    expect(typecheck(["+", 1.5, 2])).toEqual(err("TYPE_MISMATCH"));
  });

  // Gradual: `unknown` consistent-unifies silently. Result type follows the
  // OTHER side under HM (not unknown — that would poison inference).
  it("unknown + int → int (consistent unification, no error)", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    expect(typecheck(["+", "x", 1], env)).toEqual(ok(INT));
    expect(typecheck(["+", 1, "x"], env)).toEqual(ok(INT));
  });

  it("unknown + unknown → unknown (no error)", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    expect(typecheck(["+", "x", "x"], env)).toEqual(ok(UNKNOWN));
  });

  it("string in arithmetic → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["+", "s", 1], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("string right operand → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["+", 1, "s"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("subtraction", () => {
    expect(typecheck(["-", 10, 3])).toEqual(ok(INT));
  });

  it("multiplication", () => {
    expect(typecheck(["*", 4, 5])).toEqual(ok(INT));
  });

  it("division", () => {
    expect(typecheck(["/", 10, 2])).toEqual(ok(INT));
    // No widening: both must be the same numeric type
    expect(typecheck(["/", 10.5, 0.5])).toEqual(ok(FLOAT));
  });

  it("modulo", () => {
    expect(typecheck(["%", 10, 3])).toEqual(ok(INT));
  });

  it("unary minus on int → int", () => {
    expect(typecheck(["-", 5])).toEqual(ok(INT));
  });

  it("arity error", () => {
    expect(typecheck(["+", 1])).toEqual(err("ARITY_ERROR"));
    expect(typecheck(["+", 1, 2, 3])).toEqual(err("ARITY_ERROR"));
  });

  it("explicit widening: as float makes int + float work", () => {
    expect(typecheck(["+", ["as", "float", 1], 2.5])).toEqual(ok(FLOAT));
  });
});

// --- Comparison ---

describe("comparison", () => {
  it("== same types → bool", () => {
    expect(typecheck(["==", 1, 2])).toEqual(ok(BOOL));
    expect(typecheck(["==", true, false])).toEqual(ok(BOOL));
  });

  it("!= same types → bool", () => {
    expect(typecheck(["!=", 1, 2])).toEqual(ok(BOOL));
  });

  it("< with ints → bool", () => {
    expect(typecheck(["<", 1, 2])).toEqual(ok(BOOL));
  });

  it("< with unknown → bool (no error)", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    expect(typecheck(["<", "x", 1], env)).toEqual(ok(BOOL));
  });

  it("< with string → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["<", "s", 1], env)).toEqual(err("TYPE_MISMATCH"));
  });
});

// --- Logic ---

describe("logic", () => {
  it("and bool bool → bool", () => {
    expect(typecheck(["and", true, false])).toEqual(ok(BOOL));
  });

  it("or bool bool → bool", () => {
    expect(typecheck(["or", true, false])).toEqual(ok(BOOL));
  });

  it("not bool → bool", () => {
    expect(typecheck(["not", true])).toEqual(ok(BOOL));
  });

  it("and with unknown → bool (no error)", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    expect(typecheck(["and", "x", true], env)).toEqual(ok(BOOL));
  });

  it("and with int → TYPE_MISMATCH", () => {
    expect(typecheck(["and", 1, true])).toEqual(err("TYPE_MISMATCH"));
  });

  it("not with int → TYPE_MISMATCH", () => {
    expect(typecheck(["not", 42])).toEqual(err("TYPE_MISMATCH"));
  });
});

// --- Control flow ---

describe("if", () => {
  it("if with bool cond, same branch types → branch type", () => {
    expect(typecheck(["if", true, 1, 2])).toEqual(ok(INT));
  });

  // Phase 1 design: no `union` type. Branch joins unify against a fresh var,
  // so different branch types is now a TYPE_MISMATCH.
  it("if with different branch types → TYPE_MISMATCH", () => {
    expect(typecheck(["if", true, 1, 1.5])).toEqual(err("TYPE_MISMATCH"));
  });

  it("if with unknown cond → no error", () => {
    const env = EMPTY_TYPE_ENV.extend({ c: UNKNOWN });
    expect(typecheck(["if", "c", 1, 2], env)).toEqual(ok(INT));
  });

  it("if with non-bool cond → TYPE_MISMATCH", () => {
    expect(typecheck(["if", 1, 2, 3])).toEqual(err("TYPE_MISMATCH"));
  });

  it("if arity error", () => {
    expect(typecheck(["if", true, 1])).toEqual(err("ARITY_ERROR"));
  });

  it("if branch with unknown silently coexists", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    expect(typecheck(["if", true, "x", 1], env)).toEqual(ok(INT));
  });
});

describe("do", () => {
  it("do returns type of last expr", () => {
    expect(typecheck(["do", 1, true, 3.14])).toEqual(ok(FLOAT));
  });

  it("do arity error", () => {
    expect(typecheck(["do"])).toEqual(err("ARITY_ERROR"));
  });
});

// --- let ---

describe("let", () => {
  it("let binding type propagates to body", () => {
    expect(typecheck(["let", [["x", 42]], "x"])).toEqual(ok(INT));
  });

  it("let with float binding", () => {
    expect(typecheck(["let", [["x", 3.14]], "x"])).toEqual(ok(FLOAT));
  });

  it("let binding used in arithmetic", () => {
    expect(
      typecheck([
        "let",
        [
          ["x", 1],
          ["y", 2],
        ],
        ["+", "x", "y"],
      ]),
    ).toEqual(ok(INT));
  });

  it("let with string binding in arithmetic → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({ strVal: STRING });
    expect(typecheck(["let", [["s", "strVal"]], ["+", "s", 1]], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("let sequential binding (second can use first)", () => {
    expect(
      typecheck([
        "let",
        [
          ["x", 1],
          ["y", ["+", "x", 1]],
        ],
        "y",
      ]),
    ).toEqual(ok(INT));
  });

  it("let-bound polymorphic identity used at two types", () => {
    // ["let", [["id", ["fn", ["x"], "x"]]], ["if", ["call", "id", true], ["call", "id", 1], 0]]
    const result = typecheck([
      "let",
      [["id", ["fn", ["x"], "x"]]],
      ["if", ["call", "id", true], ["call", "id", 1], 0],
    ]);
    expect(result).toEqual(ok(INT));
  });
});

// --- letrec ---

describe("letrec", () => {
  it("letrec self-recursive fn typechecks", () => {
    const result = typecheck(["letrec", [["f", ["fn", ["x"], ["call", "f", "x"]]]], "f"]);
    expect(result.ok).toBe(true);
  });

  it("letrec generalizes — recursive identity is polymorphic at use sites", () => {
    const result = typecheck([
      "letrec",
      [["id", ["fn", ["x"], "x"]]],
      ["if", ["call", "id", true], ["call", "id", 1], 0],
    ]);
    expect(result).toEqual(ok(INT));
  });
});

// --- fn and call ---

describe("fn", () => {
  it("fn with unannotated params is polymorphic over fresh vars", () => {
    const result = typecheck(["fn", ["x"], "x"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Identity: fn(a) -> a
      expect(prettyType(result.type)).toBe("fn(a) -> a");
    }
  });

  it("fn with annotated params infers return type", () => {
    const result = typecheck(["fn", [["x", "int"]], ["+", "x", 1]]);
    expect(result).toEqual(
      ok({
        kind: "fn",
        params: [INT],
        ret: INT,
      }),
    );
  });

  it("fn body type errors are reported", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(["fn", [["x", "int"]], ["+", "x", "s"]], env);
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });
});

describe("call", () => {
  it("call known fn → return type", () => {
    const env = EMPTY_TYPE_ENV.extend({
      f: { kind: "fn", params: [INT], ret: INT } as MType,
    });
    expect(typecheck(["call", "f", 1], env)).toEqual(ok(INT));
  });

  it("call unknown fn → fresh result var (silently passes)", () => {
    const env = EMPTY_TYPE_ENV.extend({ f: UNKNOWN });
    const result = typecheck(["call", "f", 1], env);
    expect(result.ok).toBe(true);
    // Result is a fresh type var (printed as "a" after alpha-rename).
    if (result.ok) {
      expect(prettyType(result.type)).toBe("a");
    }
  });

  it("call with wrong arity → ARITY_ERROR", () => {
    const env = EMPTY_TYPE_ENV.extend({
      f: { kind: "fn", params: [INT], ret: INT } as MType,
    });
    expect(typecheck(["call", "f", 1, 2], env)).toEqual(err("ARITY_ERROR"));
  });

  it("call with wrong arg type → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({
      f: { kind: "fn", params: [INT], ret: INT } as MType,
      s: STRING,
    });
    expect(typecheck(["call", "f", "s"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("call inline fn literal — HM unifies x with 5 → int", () => {
    // Under HM, fn(x) -> x+1 applied to 5 unifies x with int → return type int.
    const result = typecheck(["call", ["fn", ["x"], ["+", "x", 1]], 5]);
    expect(result).toEqual(ok(INT));
  });
});

// --- unknown passes through ---

describe("unknown propagation", () => {
  it("unknown in any position suppresses type errors", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    // unknown + unknown → unknown (no constraints, no errors)
    expect(typecheck(["+", "x", "x"], env)).toEqual(ok(UNKNOWN));
    // unknown and unknown → bool
    expect(typecheck(["and", "x", "x"], env)).toEqual(ok(BOOL));
  });

  it("unknown variable in if condition is ok", () => {
    const env = EMPTY_TYPE_ENV.extend({ c: UNKNOWN });
    expect(typecheck(["if", "c", 1, 2], env)).toEqual(ok(INT));
  });

  it("unknown in comparison is ok", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    expect(typecheck(["<", "x", 1], env)).toEqual(ok(BOOL));
    expect(typecheck(["==", "x", "x"], env)).toEqual(ok(BOOL));
  });
});

// --- untyped ---

describe("untyped", () => {
  it("untyped returns unknown without checking inner", () => {
    expect(typecheck(["untyped", ["+", "undefined_var", "also_undefined"]])).toEqual(ok(UNKNOWN));
  });

  it("untyped with wrong arg count → ARITY_ERROR", () => {
    expect(typecheck(["untyped"])).toEqual(err("ARITY_ERROR"));
  });
});

// --- Array primitives (Phase 1) ---

describe("array ops", () => {
  it("array of homogeneous ints → array<int>", () => {
    expect(typecheck(["array", 1, 2, 3])).toEqual(ok({ kind: "array", elem: INT }));
  });

  it("array of mixed types → TYPE_MISMATCH", () => {
    expect(typecheck(["array", 1, "x"])).toEqual(err("UNDEFINED_VAR")); // "x" var lookup
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["array", 1, "s"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("array-len → int", () => {
    const env = EMPTY_TYPE_ENV.extend({ a: { kind: "array", elem: INT } as MType });
    expect(typecheck(["array-len", "a"], env)).toEqual(ok(INT));
  });

  it("array-get → element type", () => {
    const env = EMPTY_TYPE_ENV.extend({ a: { kind: "array", elem: INT } as MType });
    expect(typecheck(["array-get", "a", 0], env)).toEqual(ok(INT));
  });

  it("array-push preserves element type", () => {
    const env = EMPTY_TYPE_ENV.extend({ a: { kind: "array", elem: INT } as MType });
    expect(typecheck(["array-push", "a", 5], env)).toEqual(ok({ kind: "array", elem: INT }));
  });

  it("array-push with wrong elem type → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({
      a: { kind: "array", elem: INT } as MType,
      s: STRING,
    });
    expect(typecheck(["array-push", "a", "s"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("array-map fn(a)->b array<a> → array<b>", () => {
    const env = EMPTY_TYPE_ENV.extend({
      f: { kind: "fn", params: [INT], ret: BOOL } as MType,
      arr: { kind: "array", elem: INT } as MType,
    });
    expect(typecheck(["array-map", "f", "arr"], env)).toEqual(ok({ kind: "array", elem: BOOL }));
  });

  it("array-map with non-array → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({
      f: { kind: "fn", params: [INT], ret: BOOL } as MType,
      x: INT,
    });
    expect(typecheck(["array-map", "f", "x"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("array-filter preserves element type", () => {
    const env = EMPTY_TYPE_ENV.extend({
      pred: { kind: "fn", params: [INT], ret: BOOL } as MType,
      arr: { kind: "array", elem: INT } as MType,
    });
    expect(typecheck(["array-filter", "pred", "arr"], env)).toEqual(
      ok({ kind: "array", elem: INT }),
    );
  });

  it("array-reduce with init type → acc type", () => {
    const env = EMPTY_TYPE_ENV.extend({
      f: { kind: "fn", params: [INT, INT], ret: INT } as MType,
      arr: { kind: "array", elem: INT } as MType,
    });
    expect(typecheck(["array-reduce", "f", 0, "arr"], env)).toEqual(ok(INT));
  });

  it("count array → int", () => {
    const env = EMPTY_TYPE_ENV.extend({ arr: { kind: "array", elem: INT } as MType });
    expect(typecheck(["count", "arr"], env)).toEqual(ok(INT));
  });

  it("count non-array → TYPE_MISMATCH", () => {
    expect(typecheck(["count", 1])).toEqual(err("TYPE_MISMATCH"));
  });
});

// --- String ops (Phase 1 — str-* family) ---

describe("string ops", () => {
  it("str-concat strings → string", () => {
    const env = EMPTY_TYPE_ENV.extend({ a: STRING, b: STRING });
    expect(typecheck(["str-concat", "a", "b"], env)).toEqual(ok(STRING));
  });

  it("str-concat non-string → TYPE_MISMATCH", () => {
    expect(typecheck(["str-concat", 1, 2])).toEqual(err("TYPE_MISMATCH"));
  });

  it("str-slice string int int → string", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["str-slice", "s", 0, 3], env)).toEqual(ok(STRING));
  });

  it("str-len string → int", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["str-len", "s"], env)).toEqual(ok(INT));
  });

  it("str-upper string → string", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["str-upper", "s"], env)).toEqual(ok(STRING));
  });

  it("str-split string string → array<string>", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING, sep: STRING });
    expect(typecheck(["str-split", "s", "sep"], env)).toEqual(ok({ kind: "array", elem: STRING }));
  });

  it("to-string any → string", () => {
    expect(typecheck(["to-string", 42])).toEqual(ok(STRING));
    expect(typecheck(["to-string", true])).toEqual(ok(STRING));
  });

  it("parse-int string → int (Phase 1: no Option type yet)", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["parse-int", "s"], env)).toEqual(ok(INT));
  });

  it("parse-int non-string → TYPE_MISMATCH", () => {
    expect(typecheck(["parse-int", 42])).toEqual(err("TYPE_MISMATCH"));
  });
});

// --- Phase 3+ ops are not-yet-implemented ---

describe("Phase 3+ ops fail loudly", () => {
  it("match → NOT_YET_IMPLEMENTED", () => {
    const env = EMPTY_TYPE_ENV.extend({ v: UNKNOWN });
    expect(typecheck(["match", "v", [["Tag"], 42]], env)).toEqual(err("NOT_YET_IMPLEMENTED"));
  });

  it("perform → NOT_YET_IMPLEMENTED", () => {
    expect(typecheck(["perform", "Async", null])).toEqual(err("NOT_YET_IMPLEMENTED"));
  });

  it("handle → NOT_YET_IMPLEMENTED", () => {
    expect(typecheck(["handle", null])).toEqual(err("NOT_YET_IMPLEMENTED"));
  });

  it("variant constructor → NOT_YET_IMPLEMENTED", () => {
    // Phase 2 will introduce variant constructor schemes from type defs.
    expect(typecheck(["Circle", 1.5])).toEqual(err("NOT_YET_IMPLEMENTED"));
  });
});

// --- Records and row polymorphism (Phase 2) ---

describe("records", () => {
  it("record literal → closed record type", () => {
    const env = EMPTY_TYPE_ENV.extend({ hello: STRING });
    const result = typecheck(["record", ["x", 1], ["y", "hello"]], env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("{x: int, y: string}");
    }
  });

  it("{} literal works as record literal", () => {
    const result = typecheck(["{}", ["a", true]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("{a: bool}");
    }
  });

  it("get on closed record returns field type", () => {
    const result = typecheck(["get", ["record", ["x", 1], ["y", 2.5]], "x"]);
    expect(result).toEqual(ok(INT));
  });

  it("get on missing field of closed record → TYPE_MISMATCH", () => {
    const result = typecheck(["get", ["record", ["x", 1]], "missing"]);
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });

  it("get with non-string key still typechecks but loses precision", () => {
    const env = EMPTY_TYPE_ENV.extend({ r: UNKNOWN, k: STRING });
    const result = typecheck(["get", "r", "k"], env);
    expect(result.ok).toBe(true);
  });

  it("set on closed record returns same record type", () => {
    const result = typecheck(["set", ["record", ["x", 1]], "x", 2]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("{x: int}");
    }
  });

  it("set with wrong value type for existing key → TYPE_MISMATCH", () => {
    const result = typecheck(["set", ["record", ["x", 1]], "x", "wrong"]);
    expect(result).toEqual(err("UNDEFINED_VAR"));
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["set", ["record", ["x", 1]], "x", "s"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("merge of two closed records produces closed merged record", () => {
    const env = EMPTY_TYPE_ENV.extend({ hi: STRING });
    const result = typecheck(["merge", ["record", ["x", 1]], ["record", ["y", "hi"]]], env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("{x: int, y: string}");
    }
  });

  it("merge: b shadows a on conflict", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(["merge", ["record", ["x", 1]], ["record", ["x", "s"]]], env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("{x: string}");
    }
  });

  it("keys on record → array<string>", () => {
    const result = typecheck(["keys", ["record", ["x", 1], ["y", 2]]]);
    expect(result).toEqual(ok({ kind: "array", elem: STRING }));
  });

  it("vals on homogeneous record → array<T>", () => {
    const result = typecheck(["vals", ["record", ["x", 1], ["y", 2]]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("array<int>");
    }
  });

  it("count on record → int", () => {
    const result = typecheck(["count", ["record", ["x", 1], ["y", 2]]]);
    expect(result).toEqual(ok(INT));
  });

  it("record-has → bool", () => {
    const result = typecheck(["record-has", ["record", ["x", 1]], "x"]);
    expect(result).toEqual(ok(BOOL));
  });

  it("record-del returns record", () => {
    const result = typecheck(["record-del", ["record", ["x", 1], ["y", 2]], "x"]);
    expect(result.ok).toBe(true);
  });
});

describe("row polymorphism", () => {
  it("function that gets `name` field works on any record with name", () => {
    // (fn (r) (get r "name"))
    const result = typecheck(["fn", ["r"], ["get", "r", "name"]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should be: fn({name: a | b}) -> a
      const s = prettyType(result.type);
      expect(s).toContain("name:");
      expect(s).toContain("->");
    }
  });

  it("polymorphic get-name applied to records with extra fields", () => {
    const env = EMPTY_TYPE_ENV.extend({ alice: STRING, bob: STRING, addr: STRING });
    const result = typecheck(
      [
        "let",
        [["getName", ["fn", ["r"], ["get", "r", "name"]]]],
        [
          "array",
          ["call", "getName", ["record", ["name", "alice"], ["age", 30]]],
          ["call", "getName", ["record", ["name", "bob"], ["email", "addr"]]],
        ],
      ],
      env,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("array<string>");
    }
  });

  it("get-in nested path", () => {
    const env = EMPTY_TYPE_ENV.extend({ alice: STRING });
    const inner: Expr = ["record", ["name", "alice"]];
    const outer: Expr = ["record", ["user", inner]];
    const result = typecheck(["get-in", outer, ["array", "user", "name"]], env);
    expect(result).toEqual(ok(STRING));
  });

  it("closed record cannot be unified with record requiring missing field", () => {
    // get "missing" on a closed record literal {x: int}
    const result = typecheck(["get", ["record", ["x", 1]], "missing"]);
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });

  it("fn that calls get and uses field as int constrains row field type", () => {
    const result = typecheck(["fn", ["r"], ["+", ["get", "r", "n"], 1]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const s = prettyType(result.type);
      // Result type should be int and parameter row should mention n: int
      expect(s).toContain("n: int");
      expect(s).toContain("-> int");
    }
  });
});

// --- Error collection (multiple errors) ---

describe("error collection", () => {
  it("collects errors from multiple subexpressions", () => {
    // Both args to + are strings. After unifying ta=tb (string=string OK),
    // we still emit the TYPE_MISMATCH for the non-numeric resolved type.
    const env = EMPTY_TYPE_ENV.extend({ a: STRING, b: STRING });
    const result = typecheck(["+", "a", "b"], env);
    expect(result.ok).toBe(false);
  });

  it("nested errors all collected", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(["if", 1, ["+", "s", 1], 2], env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("errors have path information", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(["+", "s", 1], env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // First error is at path [1] or [2] depending on order.
      expect(result.errors.some((e) => e.path.length > 0)).toBe(true);
    }
  });

  it("errors have expected/got fields", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(["+", "s", 1], env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.errors[0];
      expect(e?.expected).toBeDefined();
      expect(e?.got).toBeDefined();
    }
  });
});

// --- type ops ---

describe("type ops", () => {
  it("is T expr → bool", () => {
    expect(typecheck(["is", "int", 42])).toEqual(ok(BOOL));
  });

  it("as T expr → T type", () => {
    expect(typecheck(["as", "int", 42])).toEqual(ok(INT));
    expect(typecheck(["as", "bool", true])).toEqual(ok(BOOL));
    expect(typecheck(["as", "float", 1.5])).toEqual(ok(FLOAT));
  });
});

// --- prettyType ---

describe("prettyType", () => {
  it("renders monotypes", () => {
    expect(prettyType(INT)).toBe("int");
    expect(prettyType(STRING)).toBe("string");
    expect(prettyType({ kind: "array", elem: INT })).toBe("array<int>");
  });

  it("alpha-renames free vars to a, b, c", () => {
    const t: MType = {
      kind: "fn",
      params: [
        { kind: "var", id: 7 },
        { kind: "var", id: 12 },
      ],
      ret: { kind: "var", id: 7 },
    };
    expect(prettyType(t)).toBe("fn(a, b) -> a");
  });
});

// --- Module ---

describe("typecheckModule", () => {
  it("typechecks main expression", () => {
    const result = typecheckModule({ main: ["+", 1, 2] });
    expect(result).toEqual(ok(INT));
  });

  it("rejects int + float in main (no widening)", () => {
    expect(typecheckModule({ main: ["+", 1, 1.5] })).toEqual(err("TYPE_MISMATCH"));
  });

  it("type error in module main", () => {
    const result = typecheckModule({ main: "undefined_var" });
    expect(result).toEqual(err("UNDEFINED_VAR"));
  });
});

// --- Edge cases ---

describe("edge cases", () => {
  it("empty array → UNKNOWN_OP error", () => {
    expect(typecheck([])).toEqual(err("UNKNOWN_OP"));
  });

  it("non-string op → UNKNOWN_OP error", () => {
    expect(typecheck([1, 2, 3] as unknown as Expr)).toEqual(err("UNKNOWN_OP"));
  });

  it("unknown op → UNKNOWN_OP error", () => {
    expect(typecheck(["not-an-op", 1, 2])).toEqual(err("UNKNOWN_OP"));
  });

  it("variant constructor with subexpr errors propagated", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    // Circle is NOT_YET_IMPLEMENTED, but the inner arithmetic error is also reported.
    const result = typecheck(["Circle", ["+", "s", 1]], env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should have both NOT_YET_IMPLEMENTED and TYPE_MISMATCH
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("TYPE_MISMATCH");
    }
  });
});
