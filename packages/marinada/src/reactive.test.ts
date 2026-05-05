import { describe, it, expect, vi } from "bun:test";
import { signal } from "@rhi-zone/rainbow";
import { compileReactive } from "./reactive.ts";
import { CompileError } from "./jit.ts";

describe("compileReactive", () => {
  it("constant expression: no deps, static value", () => {
    const fn = compileReactive(["+", 3, 4]);
    const out = fn({});
    expect(out.get()).toBe(7n);
  });

  it("single signal dep: reads and updates", () => {
    const x = signal<unknown>(10n);
    const fn = compileReactive(["+", "x", 1]);
    const out = fn({ x });
    expect(out.get()).toBe(11n);
    x.set(20n);
    expect(out.get()).toBe(21n);
  });

  it("two signal deps: updates on either change", () => {
    const a = signal<unknown>(3n);
    const b = signal<unknown>(4n);
    const fn = compileReactive(["+", "a", "b"]);
    const out = fn({ a, b });
    expect(out.get()).toBe(7n);
    a.set(10n);
    expect(out.get()).toBe(14n);
    b.set(1n);
    expect(out.get()).toBe(11n);
  });

  it("subscriber notified on dep change", () => {
    const x = signal<unknown>(5n);
    const fn = compileReactive(["*", "x", 2]);
    const out = fn({ x });
    const cb = vi.fn();
    out.subscribe(cb);
    x.set(6n);
    expect(cb).toHaveBeenCalledWith(12n);
  });

  it("subscriber not notified when value unchanged", () => {
    const x = signal<unknown>(5n);
    const fn = compileReactive(["*", "x", 0]);
    const out = fn({ x });
    const cb = vi.fn();
    out.subscribe(cb);
    x.set(99n);
    expect(cb).not.toHaveBeenCalled();
  });

  it("conditional: tracks only the active branch", () => {
    const flag = signal<unknown>(true);
    const a = signal<unknown>(1n);
    const b = signal<unknown>(2n);
    const fn = compileReactive(["if", "flag", "a", "b"]);
    const out = fn({ flag, a, b });
    const cb = vi.fn();
    out.subscribe(cb);

    expect(out.get()).toBe(1n);
    a.set(10n);
    expect(out.get()).toBe(10n);
    expect(cb).toHaveBeenCalledWith(10n);
    cb.mockClear();

    flag.set(false);
    expect(out.get()).toBe(2n);
    cb.mockClear();

    // a is no longer read — changes to it should not trigger
    a.set(99n);
    expect(cb).not.toHaveBeenCalled();
    expect(out.get()).toBe(2n);

    b.set(20n);
    expect(cb).toHaveBeenCalledWith(20n);
  });

  it("let binding: reads signal inside let body", () => {
    const n = signal<unknown>(7n);
    const fn = compileReactive(["let", [["x", "n"]], ["+", "x", 1]]);
    const out = fn({ n });
    expect(out.get()).toBe(8n);
    n.set(9n);
    expect(out.get()).toBe(10n);
  });

  it("string signals: both sides reactive", () => {
    const a = signal<unknown>("hello");
    const b = signal<unknown>(" world");
    const fn = compileReactive(["str-concat", "a", "b"]);
    const out = fn({ a, b });
    expect(out.get()).toBe("hello world");
    a.set("bye");
    expect(out.get()).toBe("bye world");
  });

  it("perform throws CompileError", () => {
    expect(() => compileReactive(["perform", "IO", "x"])).toThrow(CompileError);
  });

  it("handle throws CompileError", () => {
    expect(() =>
      compileReactive([
        "handle",
        ["perform", "IO", 0],
        [["IO", "v", "k"], "v"],
        [["return", "x"], "x"],
      ]),
    ).toThrow(CompileError);
  });
});
