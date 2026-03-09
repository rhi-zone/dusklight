import { describe, it, expect } from "bun:test";
import { evaluateModule, typecheckModule } from "./module.ts";
import type { Module } from "./types.ts";
import type { Value } from "./value.ts";

// --- Value helpers ---

function int(n: number | bigint): Value {
  return { kind: "int", value: typeof n === "bigint" ? n : BigInt(n) };
}

function variant(tag: string, ...fields: Value[]): Value {
  return { kind: "variant", tag, fields };
}

const NULL: Value = { kind: "null" };

// --- evaluateModule ---

describe("evaluateModule", () => {
  it("evaluates main for a module with no imports and no types", () => {
    const module: Module = {
      main: ["+", 1, 2],
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: int(3) });
  });

  it("evaluates a null literal main", () => {
    const module: Module = {
      main: null,
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: NULL });
  });

  it("bare string main fails as undefined variable (strings are variable references)", () => {
    const module: Module = {
      main: "hello",
    };
    // bare string = variable lookup; undefined var is an error
    const result = evaluateModule(module);
    expect(result).toMatchObject({ ok: false });
  });

  it("evaluates a module with type definitions — variant constructors work in main", () => {
    const module: Module = {
      types: [
        {
          name: "Shape",
          variants: [
            { tag: "Circle", fields: [["radius", "float"]] },
            {
              tag: "Rect",
              fields: [
                ["width", "float"],
                ["height", "float"],
              ],
            },
          ],
        },
      ],
      main: ["Circle", 1.5],
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: variant("Circle", { kind: "float", value: 1.5 }) });
  });

  it("evaluates a module with no-field variant constructor", () => {
    const module: Module = {
      types: [
        {
          name: "Color",
          variants: [{ tag: "Red" }, { tag: "Green" }, { tag: "Blue" }],
        },
      ],
      main: ["Red"],
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: variant("Red") });
  });

  it("evaluates lib:std import — None tag works", () => {
    const module: Module = {
      imports: [{ from: "lib:std", import: ["None", "Some", "Ok", "Err"] }],
      main: ["None"],
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: variant("None") });
  });

  it("evaluates lib:std import — Some tag works", () => {
    const module: Module = {
      imports: [{ from: "lib:std", import: ["Some"] }],
      main: ["Some", 42],
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: variant("Some", int(42)) });
  });

  it("evaluates lib:std import — Ok and Err tags work", () => {
    const okModule: Module = {
      imports: [{ from: "lib:std", import: ["Ok", "Err"] }],
      main: ["Ok", 1],
    };
    const errModule: Module = {
      imports: [{ from: "lib:std", import: ["Ok", "Err"] }],
      main: ["Err", 0],
    };
    expect(evaluateModule(okModule)).toEqual({
      ok: true,
      value: variant("Ok", int(1)),
    });
    expect(evaluateModule(errModule)).toEqual({
      ok: true,
      value: variant("Err", int(0)),
    });
  });

  it("does not error on unknown import scheme — imports typed as unknown", () => {
    const module: Module = {
      imports: [
        { from: "local:./my-types.json", import: ["MyType"] },
        { from: "https://example.com/types.json", import: ["OtherType"] },
      ],
      // main doesn't use the imports — just verify no crash
      main: 99,
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: int(99) });
  });

  it("does not error on unknown lib: scheme", () => {
    const module: Module = {
      imports: [{ from: "lib:matrix", import: ["MatrixEvent"] }],
      main: 0,
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: int(0) });
  });

  it("exports list is stored on the module and accessible", () => {
    const module: Module = {
      exports: ["Foo", "bar"],
      main: 1,
    };
    expect(module.exports).toEqual(["Foo", "bar"]);
    const result = evaluateModule(module);
    expect(result).toMatchObject({ ok: true });
  });

  it("uses match with a variant from type defs", () => {
    const module: Module = {
      types: [
        {
          name: "Shape",
          variants: [
            { tag: "Circle", fields: [["radius", "float"]] },
            {
              tag: "Rect",
              fields: [
                ["width", "float"],
                ["height", "float"],
              ],
            },
          ],
        },
      ],
      main: [
        "match",
        ["Circle", 3.5],
        [
          ["Circle", "r"],
          ["*", "r", "r"],
        ],
        [
          ["Rect", "w", "h"],
          ["*", "w", "h"],
        ],
      ],
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: { kind: "float", value: 12.25 } });
  });
});

// --- typecheckModule ---

describe("typecheckModule", () => {
  it("type-checks a simple main with no imports or types", () => {
    const module: Module = {
      main: ["+", 1, 2],
    };
    const result = typecheckModule(module);
    expect(result).toEqual({ ok: true, type: { kind: "int" } });
  });

  it("type-checks a null literal", () => {
    const module: Module = {
      main: null,
    };
    expect(typecheckModule(module)).toEqual({ ok: true, type: { kind: "null" } });
  });

  it("reports error for undefined variable in main", () => {
    const module: Module = {
      main: "unknownVar",
    };
    const result = typecheckModule(module);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("UNDEFINED_VAR");
    }
  });

  it("type-checks module with type definitions — variant constructor is known in env", () => {
    const module: Module = {
      types: [
        {
          name: "Color",
          variants: [{ tag: "Red" }, { tag: "Green" }, { tag: "Blue" }],
        },
      ],
      // Using "Red" as a variable reference — it's in the type env as a variant type
      main: "Red",
    };
    const result = typecheckModule(module);
    // "Red" resolves to { kind: 'variant', tag: 'Red', fields: [] } from type defs
    expect(result).toEqual({
      ok: true,
      type: { kind: "variant", tag: "Red", fields: [] },
    });
  });

  it("type-checks variant constructor call with type defs in scope", () => {
    const module: Module = {
      types: [
        {
          name: "Shape",
          variants: [{ tag: "Circle", fields: [["radius", "float"]] }],
        },
      ],
      main: ["Circle", 1.5],
    };
    const result = typecheckModule(module);
    // variant call returns unknown in the current type checker (no per-tag inference yet)
    expect(result).toMatchObject({ ok: true });
  });

  it("type-checks module with lib:std import — None in scope", () => {
    const module: Module = {
      imports: [{ from: "lib:std", import: ["None"] }],
      // Referencing "None" as a variable — should resolve to its variant type
      main: "None",
    };
    const result = typecheckModule(module);
    expect(result).toEqual({
      ok: true,
      type: { kind: "variant", tag: "None", fields: [] },
    });
  });

  it("type-checks module with lib:std Some import", () => {
    const module: Module = {
      imports: [{ from: "lib:std", import: ["Some"] }],
      main: "Some",
    };
    const result = typecheckModule(module);
    expect(result).toEqual({
      ok: true,
      type: { kind: "variant", tag: "Some", fields: [{ kind: "unknown" }] },
    });
  });

  it("type-checks module with unknown import scheme — imports are unknown, no error", () => {
    const module: Module = {
      imports: [{ from: "local:./foo.json", import: ["MyType"] }],
      main: 42,
    };
    const result = typecheckModule(module);
    expect(result).toEqual({ ok: true, type: { kind: "int" } });
  });

  it("type-checks module with https: import scheme — unknown, no error", () => {
    const module: Module = {
      imports: [{ from: "https://example.com/types.json", import: ["OtherType"] }],
      main: true,
    };
    const result = typecheckModule(module);
    expect(result).toEqual({ ok: true, type: { kind: "bool" } });
  });

  it("reports type error in main even with valid imports", () => {
    const module: Module = {
      imports: [{ from: "lib:std", import: ["None"] }],
      main: ["+", "notANumber", 1],
    };
    const result = typecheckModule(module);
    // "notANumber" is an undefined variable (not in env), which produces UNDEFINED_VAR not TYPE_MISMATCH
    // but arithmetic on unknown is valid (gradual typing), so errors come from UNDEFINED_VAR
    expect(result).toMatchObject({ ok: false });
  });

  it("exports list is stored and accessible — typecheckModule succeeds", () => {
    const module: Module = {
      exports: ["Foo", "bar"],
      main: 123,
    };
    const result = typecheckModule(module);
    expect(result).toEqual({ ok: true, type: { kind: "int" } });
    expect(module.exports).toEqual(["Foo", "bar"]);
  });
});
