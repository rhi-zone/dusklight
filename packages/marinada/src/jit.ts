import type { Expr } from "./types.ts";

// A compiled Marinada expression.
// Takes an env (variable bindings) and returns a JS-native value.
export type JitFn = (env: Record<string, unknown>) => unknown;

export class CompileError extends Error {
  constructor(
    message: string,
    public readonly path: number[],
  ) {
    super(message);
    this.name = "CompileError";
  }
}

// --- Runtime helpers ---

function _eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => _eq(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    return ak.length === bk.length && ak.every((k) => _eq(ao[k], bo[k]));
  }
  return false;
}

const RUNTIME = {
  _add(a: unknown, b: unknown): unknown {
    if (typeof a === "bigint" && typeof b === "bigint") return a + b;
    return Number(a) + Number(b);
  },
  _sub(a: unknown, b: unknown): unknown {
    if (typeof a === "bigint" && typeof b === "bigint") return a - b;
    return Number(a) - Number(b);
  },
  _mul(a: unknown, b: unknown): unknown {
    if (typeof a === "bigint" && typeof b === "bigint") return a * b;
    return Number(a) * Number(b);
  },
  _div(a: unknown, b: unknown): unknown {
    if (typeof a === "bigint" && typeof b === "bigint") {
      if (b === 0n) throw new RangeError("integer division by zero");
      return a / b;
    }
    return Number(a) / Number(b);
  },
  _mod(a: unknown, b: unknown): unknown {
    if (typeof a === "bigint" && typeof b === "bigint") {
      if (b === 0n) throw new RangeError("integer modulo by zero");
      return a % b;
    }
    return Number(a) % Number(b);
  },
  _eq(a: unknown, b: unknown): boolean {
    return _eq(a, b);
  },
  _get(obj: unknown, key: unknown): unknown {
    if (Array.isArray(obj)) {
      const idx = typeof key === "bigint" ? Number(key) : (key as number);
      if (idx < 0 || idx >= obj.length) return null;
      return (obj[idx] as unknown) ?? null;
    }
    if (obj !== null && typeof obj === "object") {
      const k = String(key);
      const val = (obj as Record<string, unknown>)[k];
      return val === undefined ? null : val;
    }
    return null;
  },
  _set(obj: unknown, key: unknown, val: unknown): unknown {
    if (Array.isArray(obj)) {
      const idx = typeof key === "bigint" ? Number(key) : (key as number);
      const newArr = [...obj];
      newArr[idx] = val;
      return newArr;
    }
    if (obj !== null && typeof obj === "object") {
      return { ...(obj as object), [String(key)]: val };
    }
    return obj;
  },
  _getIn(obj: unknown, path: unknown[]): unknown {
    let current = obj;
    for (const key of path) {
      current = RUNTIME._get(current, key);
    }
    return current;
  },
  _setIn(obj: unknown, path: unknown[], val: unknown): unknown {
    if (path.length === 0) return val;
    const key = path[0]!;
    const child = RUNTIME._get(obj, key);
    const newChild = RUNTIME._setIn(child, path.slice(1), val);
    return RUNTIME._set(obj, key, newChild);
  },
  _merge(r1: unknown, r2: unknown): unknown {
    return { ...(r1 as object), ...(r2 as object) };
  },
  _keys(r: unknown): unknown[] {
    if (r !== null && typeof r === "object" && !Array.isArray(r)) {
      return Object.keys(r as object);
    }
    return [];
  },
  _vals(r: unknown): unknown[] {
    if (r !== null && typeof r === "object" && !Array.isArray(r)) {
      return Object.values(r as object);
    }
    return [];
  },
  _count(a: unknown): bigint {
    if (Array.isArray(a)) return BigInt(a.length);
    if (a !== null && typeof a === "object") return BigInt(Object.keys(a as object).length);
    return 0n;
  },
  _toStr(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") return v.toString();
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return `[${(v as unknown[]).map((x) => RUNTIME._toStr(x)).join(", ")}]`;
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const tag = o["$tag"];
      if (typeof tag === "string") {
        // variant
        const fields = Object.keys(o)
          .filter((k) => k !== "$tag")
          .map((k) => RUNTIME._toStr(o[k]));
        if (fields.length === 0) return tag;
        return `${tag}(${fields.join(", ")})`;
      }
      const entries = Object.entries(o).map(([k, val]) => `${k}: ${RUNTIME._toStr(val)}`);
      return `{${entries.join(", ")}}`;
    }
    return String(v);
  },
  _parseNum(s: unknown): unknown {
    if (typeof s !== "string") return null;
    const trimmed = s.trim();
    if (trimmed === "") return null;
    if (/^-?\d+$/.test(trimmed)) {
      try {
        return BigInt(trimmed);
      } catch {
        // fallthrough
      }
    }
    const n = Number(trimmed);
    if (!isNaN(n)) return n;
    return null;
  },
  _variant(tag: string, ...fields: unknown[]): unknown {
    const obj: Record<string, unknown> = { $tag: tag };
    for (let i = 0; i < fields.length; i++) {
      obj[`$${i}`] = fields[i];
    }
    return obj;
  },
  _slice(s: unknown, start: unknown, end: unknown): string {
    const str = s as string;
    const st = typeof start === "bigint" ? Number(start) : (start as number);
    const en = typeof end === "bigint" ? Number(end) : (end as number);
    return str.slice(st, en);
  },
  _arrayGet(arr: unknown, idx: unknown): unknown {
    if (!Array.isArray(arr)) return null;
    const i = typeof idx === "bigint" ? Number(idx) : (idx as number);
    if (i < 0 || i >= arr.length) return null;
    return (arr[i] as unknown) ?? null;
  },
  _strGet(s: unknown, idx: unknown): bigint | null {
    const str = s as string;
    const i = typeof idx === "bigint" ? Number(idx) : (idx as number);
    const cp = str.codePointAt(i);
    if (cp === undefined) return null;
    return BigInt(cp);
  },
  _strCmp(a: unknown, b: unknown): bigint {
    const sa = a as string;
    const sb = b as string;
    if (sa < sb) return -1n;
    if (sa > sb) return 1n;
    return 0n;
  },
  _parseInt(s: unknown): bigint | null {
    if (typeof s !== "string") return null;
    const n = parseInt(s, 10);
    if (isNaN(n)) return null;
    return BigInt(Math.trunc(n));
  },
  _parseFloat(s: unknown): number | null {
    if (typeof s !== "string") return null;
    const n = parseFloat(s);
    if (isNaN(n)) return null;
    return n;
  },
  _intToFloat(x: unknown): number {
    return Number(x as bigint);
  },
  _floatToInt(x: unknown): bigint {
    return BigInt(Math.trunc(x as number));
  },
  _bitNot(a: unknown): bigint {
    return ~(a as bigint);
  },
};

// --- Natives table ---

const NATIVES = {
  array_map(xs: unknown, f: unknown): unknown[] {
    return (xs as unknown[]).map((x) => (f as (v: unknown) => unknown)(x));
  },
  array_filter(xs: unknown, f: unknown): unknown[] {
    return (xs as unknown[]).filter((x) => (f as (v: unknown) => boolean)(x));
  },
  array_reduce(xs: unknown, f: unknown, init: unknown): unknown {
    return (xs as unknown[]).reduce(
      (a: unknown, b: unknown) => (f as (a: unknown, b: unknown) => unknown)(a, b),
      init,
    );
  },
  array_find(xs: unknown, f: unknown): unknown {
    return (xs as unknown[]).find((x) => (f as (v: unknown) => boolean)(x)) ?? null;
  },
  array_every(xs: unknown, f: unknown): boolean {
    return (xs as unknown[]).every((x) => (f as (v: unknown) => boolean)(x));
  },
  array_any(xs: unknown, f: unknown): boolean {
    return (xs as unknown[]).some((x) => (f as (v: unknown) => boolean)(x));
  },
  array_flat_map(xs: unknown, f: unknown): unknown[] {
    return (xs as unknown[]).flatMap((x) => (f as (v: unknown) => unknown[])(x));
  },
  array_includes(xs: unknown, v: unknown): boolean {
    return (xs as unknown[]).some((x) => _eq(x, v));
  },
  array_index_of(xs: unknown, v: unknown): bigint {
    const arr = xs as unknown[];
    for (let i = 0; i < arr.length; i++) {
      if (_eq(arr[i], v)) return BigInt(i);
    }
    return -1n;
  },
};

// --- Compiler ---

// Set of locally-bound variable names that should be referenced directly,
// not via env[...]. These are JS local variables in scope at this point.
type CompileCtx = {
  path: number[];
  locals: ReadonlySet<string>;
  /** When inside a __loop body, the loop parameter names for __continue. */
  loopParams: string[] | null;
};

function emptyCtx(): CompileCtx {
  return { path: [], locals: new Set(), loopParams: null };
}

function childCtx(ctx: CompileCtx, i: number): CompileCtx {
  return { path: [...ctx.path, i], locals: ctx.locals, loopParams: ctx.loopParams };
}

function withLocals(ctx: CompileCtx, names: string[]): CompileCtx {
  const newLocals = new Set(ctx.locals);
  for (const n of names) newLocals.add(n);
  return { path: ctx.path, locals: newLocals, loopParams: ctx.loopParams };
}

// Resolve a variable name — local JS variable or env lookup
function varRef(name: string, ctx: CompileCtx): string {
  if (ctx.locals.has(name)) return name;
  return `env[${JSON.stringify(name)}]`;
}

/** Serialize a JS value as a JS literal string, matching the JIT's value representation. */
function serializeLit(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return `[${(v as unknown[]).map(serializeLit).join(", ")}]`;
  }
  if (typeof v === "object") {
    // Plain object → JS object literal (JIT record representation)
    const o = v as Record<string, unknown>;
    const entries = Object.entries(o).map(
      ([k, val]) => `${JSON.stringify(k)}: ${serializeLit(val)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  throw new Error(`serializeLit: unsupported value type: ${typeof v}`);
}

function compileExpr(expr: Expr, ctx: CompileCtx): string {
  // Atoms
  if (expr === null) return "null";
  if (typeof expr === "boolean") return expr ? "true" : "false";
  if (typeof expr === "number") {
    if (Number.isInteger(expr) && !Object.is(expr, -0)) {
      // Distinguish 3.0 from 3: in JS source code, 3.0 and 3 are the same number.
      // In Marinada JSON: integer literals → bigint, float literals → number.
      // JSON.parse("3.0") === 3 (JS number), JSON.parse("3") === 3.
      // There's no way to distinguish 3 from 3.0 at runtime in JSON.
      // Convention: integer JS numbers → BigInt literals, non-integer → float.
      return `${expr}n`;
    } else {
      return JSON.stringify(expr);
    }
  }
  if (typeof expr === "string") {
    return varRef(expr, ctx);
  }

  // Array = call
  const arr = expr as Expr[];
  if (arr.length === 0) {
    throw new CompileError("empty expression array", ctx.path);
  }

  const opExpr = arr[0];
  if (typeof opExpr !== "string") {
    throw new CompileError("first element of call must be an op name (string)", ctx.path);
  }
  const op = opExpr;

  // Variant constructor: uppercase tag
  if (op.length > 0 && (op[0] as string) >= "A" && (op[0] as string) <= "Z") {
    const fieldArgs = arr
      .slice(1)
      .map((a, i) => compileExpr(a, childCtx(ctx, i + 1)))
      .join(", ");
    return `_rt._variant(${JSON.stringify(op)}${fieldArgs.length > 0 ? ", " + fieldArgs : ""})`;
  }

  const arg = (i: number) => compileExpr(arr[i] as Expr, childCtx(ctx, i));

  switch (op) {
    case "+":
      return `_rt._add(${arg(1)}, ${arg(2)})`;
    case "-":
      return `_rt._sub(${arg(1)}, ${arg(2)})`;
    case "*":
      return `_rt._mul(${arg(1)}, ${arg(2)})`;
    case "/":
      return `_rt._div(${arg(1)}, ${arg(2)})`;
    case "%":
      return `_rt._mod(${arg(1)}, ${arg(2)})`;

    case "==":
      return `_rt._eq(${arg(1)}, ${arg(2)})`;
    case "!=":
      return `(!_rt._eq(${arg(1)}, ${arg(2)}))`;
    case "<":
      return `(Number(${arg(1)}) < Number(${arg(2)}))`;
    case ">":
      return `(Number(${arg(1)}) > Number(${arg(2)}))`;
    case "<=":
      return `(Number(${arg(1)}) <= Number(${arg(2)}))`;
    case ">=":
      return `(Number(${arg(1)}) >= Number(${arg(2)}))`;

    case "and":
      return `(${arg(1)} && ${arg(2)})`;
    case "or":
      return `(${arg(1)} || ${arg(2)})`;
    case "not":
      return `(!${arg(1)})`;

    case "if":
      return `(${arg(1)} ? ${arg(2)} : ${arg(3)})`;

    case "do": {
      if (arr.length < 2) throw new CompileError("do requires at least 1 expr", ctx.path);
      const parts = arr.slice(1).map((e, i) => compileExpr(e, childCtx(ctx, i + 1)));
      if (parts.length === 1) return parts[0]!;
      return `(${parts.join(", ")})`;
    }

    case "let": {
      // ["let", [[name, val], ...], body]
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        throw new CompileError("let bindings must be an array", [...ctx.path, 1]);
      }
      const body = arr[2] as Expr;

      // Build nested IIFEs, tracking which names become locals as we go
      // Process from innermost outward, building up the set of locals
      let currentCtx = ctx;
      // First pass: collect binding names and their value expressions
      const bindingData: Array<{ name: string; valCode: string }> = [];
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) {
          throw new CompileError("each let binding must be [name, expr]", [...ctx.path, 1, i]);
        }
        const name = binding[0];
        if (typeof name !== "string") {
          throw new CompileError("let binding name must be a string", [...ctx.path, 1, i, 0]);
        }
        // Value is compiled in the current context (before this binding is in scope)
        const valCode = compileExpr(binding[1] as Expr, {
          path: childCtx(ctx, i).path,
          locals: currentCtx.locals,
          loopParams: ctx.loopParams,
        });
        bindingData.push({ name, valCode });
        // After this binding, name is a local
        currentCtx = withLocals(currentCtx, [name]);
      }

      // Compile body with all bindings as locals
      let bodyCode = compileExpr(body, {
        path: childCtx(ctx, 2).path,
        locals: currentCtx.locals,
        loopParams: ctx.loopParams,
      });

      // Wrap from innermost outward
      for (let i = bindingData.length - 1; i >= 0; i--) {
        const { name, valCode } = bindingData[i]!;
        bodyCode = `((${name}) => ${bodyCode})(${valCode})`;
      }
      return bodyCode;
    }

    case "letrec": {
      // ["letrec", [[name, fn], ...], body]
      // All names are in scope for all values and body
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        throw new CompileError("letrec bindings must be an array", [...ctx.path, 1]);
      }
      const body = arr[2] as Expr;

      // Collect all names first
      const names: string[] = [];
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) {
          throw new CompileError("each letrec binding must be [name, expr]", [...ctx.path, 1, i]);
        }
        const name = binding[0];
        if (typeof name !== "string") {
          throw new CompileError("letrec binding name must be a string", [...ctx.path, 1, i, 0]);
        }
        names.push(name);
      }

      // All names are locals in the recursive context
      const recCtx = withLocals(ctx, names);

      const decls = names.map((n) => `var ${n};`).join(" ");
      const assigns: string[] = [];
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i] as Expr[];
        const name = names[i]!;
        const valCode = compileExpr(binding[1] as Expr, recCtx);
        assigns.push(`${name} = ${valCode};`);
      }
      const bodyCode = compileExpr(body, recCtx);
      return `(()=>{ ${decls} ${assigns.join(" ")} return ${bodyCode}; })()`;
    }

    case "fn": {
      // ["fn", params, body]
      const paramsExpr = arr[1];
      if (!Array.isArray(paramsExpr)) {
        throw new CompileError("fn params must be an array", [...ctx.path, 1]);
      }
      const params: string[] = [];
      for (let i = 0; i < paramsExpr.length; i++) {
        const p = paramsExpr[i];
        if (typeof p === "string") {
          params.push(p);
        } else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") {
          params.push(p[0]);
        } else {
          throw new CompileError("fn param must be a string or [name, type] pair", [
            ...ctx.path,
            1,
            i,
          ]);
        }
      }
      // fn body: params are locals. fn creates a new scope, so __continue from an outer
      // loop cannot appear inside fn body — reset loopParams to null.
      const fnCtx = withLocals(ctx, params);
      const bodyCode = compileExpr(arr[2] as Expr, {
        path: childCtx(ctx, 2).path,
        locals: fnCtx.locals,
        loopParams: null,
      });
      return `((${params.join(", ")}) => ${bodyCode})`;
    }

    case "call": {
      // ["call", fn, arg1, arg2, ...]
      const fnCode = arg(1);
      const argCodes = arr.slice(2).map((e, i) => compileExpr(e, childCtx(ctx, i + 2)));
      return `${fnCode}(${argCodes.join(", ")})`;
    }

    case "get":
      return `_rt._get(${arg(1)}, ${arg(2)})`;

    case "get-in":
      return `_rt._getIn(${arg(1)}, ${arg(2)})`;

    case "set":
      return `_rt._set(${arg(1)}, ${arg(2)}, ${arg(3)})`;

    case "set-in":
      return `_rt._setIn(${arg(1)}, ${arg(2)}, ${arg(3)})`;

    case "count":
      return `_rt._count(${arg(1)})`;

    case "merge":
      return `_rt._merge(${arg(1)}, ${arg(2)})`;

    case "keys":
      return `_rt._keys(${arg(1)})`;

    case "vals":
      return `_rt._vals(${arg(1)})`;

    // --- Array primitives ---
    case "array": {
      const elems = arr.slice(1).map((e, i) => compileExpr(e, childCtx(ctx, i + 1)));
      return `[${elems.join(", ")}]`;
    }

    case "array-get":
      return `_rt._arrayGet(${arg(1)}, ${arg(2)})`;

    case "array-push":
      return `[...${arg(1)}, ${arg(2)}]`;

    case "array-slice": {
      if (arr.length === 3) {
        return `(${arg(1)}).slice(Number(${arg(2)}))`;
      }
      return `(${arg(1)}).slice(Number(${arg(2)}), Number(${arg(3)}))`;
    }

    // --- Record aliases ---
    case "record-get":
      return `_rt._get(${arg(1)}, ${arg(2)})`;

    case "record-set":
      return `_rt._set(${arg(1)}, ${arg(2)}, ${arg(3)})`;

    case "record-del": {
      const rCode = arg(1);
      const kCode = arg(2);
      return `((_$r, _$k) => { const _$o = {..._$r}; delete _$o[_$k]; return _$o; })(${rCode}, ${kCode})`;
    }

    case "record-keys":
      return `_rt._keys(${arg(1)})`;

    case "record-vals":
      return `_rt._vals(${arg(1)})`;

    case "record-merge":
      return `_rt._merge(${arg(1)}, ${arg(2)})`;

    // --- String primitives ---
    case "str-len":
      return `BigInt(${arg(1)}.length)`;

    case "str-get":
      return `_rt._strGet(${arg(1)}, ${arg(2)})`;

    case "str-concat":
      return `(${arg(1)} + ${arg(2)})`;

    case "str-slice":
      return `(${arg(1)}).slice(Number(${arg(2)}), Number(${arg(3)}))`;

    case "str-cmp":
      return `_rt._strCmp(${arg(1)}, ${arg(2)})`;

    case "parse-int":
      return `_rt._parseInt(${arg(1)})`;

    case "parse-float":
      return `_rt._parseFloat(${arg(1)})`;

    // --- Math primitives ---
    case "floor":
      return `(typeof (${arg(1)}) === "bigint" ? ${arg(1)} : Math.floor(${arg(1)}))`;

    case "ceil":
      return `(typeof (${arg(1)}) === "bigint" ? ${arg(1)} : Math.ceil(${arg(1)}))`;

    case "round":
      return `(typeof (${arg(1)}) === "bigint" ? ${arg(1)} : Math.round(${arg(1)}))`;

    case "abs":
      return `(typeof (${arg(1)}) === "bigint" ? (${arg(1)} < 0n ? -(${arg(1)}) : ${arg(1)}) : Math.abs(${arg(1)}))`;

    case "min":
      return `(typeof (${arg(1)}) === "bigint" && typeof (${arg(2)}) === "bigint" ? ((${arg(1)}) < (${arg(2)}) ? ${arg(1)} : ${arg(2)}) : Math.min(Number(${arg(1)}), Number(${arg(2)})))`;

    case "max":
      return `(typeof (${arg(1)}) === "bigint" && typeof (${arg(2)}) === "bigint" ? ((${arg(1)}) > (${arg(2)}) ? ${arg(1)} : ${arg(2)}) : Math.max(Number(${arg(1)}), Number(${arg(2)})))`;

    case "pow":
      return `Math.pow(Number(${arg(1)}), Number(${arg(2)}))`;

    case "sqrt":
      return `Math.sqrt(Number(${arg(1)}))`;

    case "int->float":
      return `_rt._intToFloat(${arg(1)})`;

    case "float->int":
      return `_rt._floatToInt(${arg(1)})`;

    // --- Bitwise primitives ---
    case "bit-and":
      return `((${arg(1)}) & (${arg(2)}))`;

    case "bit-or":
      return `((${arg(1)}) | (${arg(2)}))`;

    case "bit-xor":
      return `((${arg(1)}) ^ (${arg(2)}))`;

    case "bit-not":
      return `_rt._bitNot(${arg(1)})`;

    case "bit-shl":
      return `((${arg(1)}) << (${arg(2)}))`;

    case "bit-shr":
      return `((${arg(1)}) >> (${arg(2)}))`;

    case "concat": {
      if (arr.length < 2) throw new CompileError("concat requires at least 1 arg", ctx.path);
      const parts = arr.slice(1).map((e, i) => compileExpr(e, childCtx(ctx, i + 1)));
      if (parts.length === 1) return parts[0]!;
      return `(${parts.join("+")})`;
    }

    case "slice":
      return `_rt._slice(${arg(1)}, ${arg(2)}, ${arg(3)})`;

    case "to-string":
      return `_rt._toStr(${arg(1)})`;

    case "parse-number":
      return `_rt._parseNum(${arg(1)})`;

    case "untyped":
      return arg(1);

    case "match": {
      // ["match", scrutinee, [pattern, body], ...]
      const scrutCode = arg(1);
      const clauses = arr.slice(2);
      const clauseCodes: string[] = [];
      for (let i = 0; i < clauses.length; i++) {
        const clause = clauses[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          throw new CompileError("match clause must be [pattern, body]", [...ctx.path, i + 2]);
        }
        const pattern = clause[0];
        const body = clause[1] as Expr;
        if (!Array.isArray(pattern) || pattern.length < 1) {
          throw new CompileError("match pattern must be an array starting with a tag", [
            ...ctx.path,
            i + 2,
            0,
          ]);
        }
        const tag = pattern[0];
        if (typeof tag !== "string") {
          throw new CompileError("match pattern tag must be a string", [...ctx.path, i + 2, 0]);
        }
        const bindingNames = pattern.slice(1) as string[];
        // Compile body with binding names as locals
        const bodyCtx = withLocals(ctx, bindingNames);
        const bindings = bindingNames.map((name, fi) => `var ${name}=$s.$${fi};`).join("");
        const bodyCode = compileExpr(body, {
          path: childCtx(ctx, i + 2).path,
          locals: bodyCtx.locals,
          loopParams: ctx.loopParams,
        });
        clauseCodes.push(`if($s.$tag===${JSON.stringify(tag)}){${bindings}return ${bodyCode}}`);
      }
      return `(($s)=>{${clauseCodes.join("")}throw new Error("non-exhaustive match")})(${scrutCode})`;
    }

    case "cond": {
      // ["cond", [test1, expr1], [test2, expr2], ["else", exprN]]
      if (arr.length < 2) throw new CompileError("cond requires at least 1 clause", ctx.path);
      const clauses = arr.slice(1);
      let result = `(()=>{throw new Error("non-exhaustive cond")})()`;
      for (let i = clauses.length - 1; i >= 0; i--) {
        const clause = clauses[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          throw new CompileError("cond clause must be [test, expr]", [...ctx.path, i + 1]);
        }
        const test = clause[0];
        const clauseExpr = clause[1] as Expr;
        const exprCode = compileExpr(clauseExpr, childCtx(ctx, i + 1));
        if (test === "else") {
          result = exprCode;
        } else {
          const testCode = compileExpr(test as Expr, childCtx(ctx, i + 1));
          result = `(${testCode} ? ${exprCode} : ${result})`;
        }
      }
      return result;
    }

    case "is": {
      const typStr = arr[1];
      if (typeof typStr !== "string") {
        throw new CompileError("is requires a type name string as first arg", [...ctx.path, 1]);
      }
      const valCode = arg(2);
      return compileIsCheck(typStr, valCode);
    }

    case "as": {
      const typStr = arr[1];
      if (typeof typStr !== "string") {
        throw new CompileError("as requires a type name string as first arg", [...ctx.path, 1]);
      }
      const valCode = arg(2);
      const checkCode = compileIsCheck(typStr, "_$v");
      return `((_$v)=>{ if(!(${checkCode})) throw new TypeError("expected ${typStr}"); return _$v; })(${valCode})`;
    }

    case "perform":
      throw new CompileError("perform cannot be compiled (use interpreter for effects)", ctx.path);

    case "handle":
      throw new CompileError("handle cannot be compiled (use interpreter for effects)", ctx.path);

    case "__native": {
      // ["__native", name, ...args]
      const name = arr[1];
      if (typeof name !== "string") {
        throw new CompileError("__native: first arg must be a function name string", ctx.path);
      }
      const argCodes = arr.slice(2).map((e, i) => compileExpr(e as Expr, childCtx(ctx, i + 2)));
      return `_nat.${name}(${argCodes.join(", ")})`;
    }

    case "__lit": {
      // ["__lit", value]
      if (arr.length !== 2) {
        throw new CompileError("__lit: requires exactly one argument", ctx.path);
      }
      return serializeLit(arr[1]);
    }

    case "__loop": {
      // ["__loop", params, initArgs, body]
      // Uses a sentinel exception (_LoopContinue) so __continue works from any expression depth.
      // Emits:
      //   (()=>{ let p1=init1, ...; while(true){ try{ return (body) }catch(_lc){ if(_lc instanceof _LoopContinue){ p1=_lc._v[0]; ...; continue } throw _lc } } })()
      const params = arr[1];
      const initArgs = arr[2];
      const body = arr[3] as Expr;
      if (!Array.isArray(params) || !Array.isArray(initArgs)) {
        throw new CompileError("__loop: params and initArgs must be arrays", ctx.path);
      }
      if (params.length !== initArgs.length) {
        throw new CompileError("__loop: params and initArgs must have the same length", ctx.path);
      }
      const paramNames: string[] = [];
      for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (typeof p !== "string") {
          throw new CompileError("__loop: param names must be strings", ctx.path);
        }
        paramNames.push(p);
      }
      const initCodes = (initArgs as Expr[]).map((e, i) => compileExpr(e, childCtx(ctx, i + 2)));
      const decls = paramNames.map((p, i) => `let ${p} = ${initCodes[i] as string}`).join("; ");
      const bodyCtx: CompileCtx = {
        path: childCtx(ctx, 3).path,
        locals: withLocals(ctx, paramNames).locals,
        loopParams: paramNames,
      };
      const bodyCode = compileExpr(body, bodyCtx);
      const assigns = paramNames.map((p, i) => `${p} = _lc._v[${i}]`).join("; ");
      return `(()=>{ ${decls}; while(true){ try{ return (${bodyCode}) }catch(_lc){ if(_lc instanceof _LoopContinue){ ${assigns}; continue } throw _lc } } })()`;
    }

    case "__continue": {
      // ["__continue", ...newArgs]
      // Throws a LoopContinue sentinel carrying the new loop variable values.
      // Only valid inside __loop body.
      if (ctx.loopParams === null) {
        throw new CompileError("__continue outside __loop", ctx.path);
      }
      const loopParams = ctx.loopParams;
      const newArgCodes = arr.slice(1).map((e, i) => compileExpr(e as Expr, childCtx(ctx, i + 1)));
      if (newArgCodes.length !== loopParams.length) {
        throw new CompileError(
          `__continue: expected ${loopParams.length} args, got ${newArgCodes.length}`,
          ctx.path,
        );
      }
      return `(()=>{ throw new _LoopContinue([${newArgCodes.join(", ")}]); })()`;
    }

    default:
      throw new CompileError(`unknown op: ${op}`, ctx.path);
  }
}

function compileIsCheck(typStr: string, valExpr: string): string {
  switch (typStr) {
    case "null":
      return `(${valExpr} === null)`;
    case "bool":
    case "boolean":
      return `(typeof ${valExpr} === "boolean")`;
    case "int":
      return `(typeof ${valExpr} === "bigint")`;
    case "float":
      return `(typeof ${valExpr} === "number")`;
    case "number":
      return `(typeof ${valExpr} === "bigint" || typeof ${valExpr} === "number")`;
    case "string":
      return `(typeof ${valExpr} === "string")`;
    case "array":
      return `Array.isArray(${valExpr})`;
    case "record":
      return `(${valExpr} !== null && typeof ${valExpr} === "object" && !Array.isArray(${valExpr}))`;
    case "variant":
      return `(${valExpr} !== null && typeof ${valExpr} === "object" && typeof ${valExpr}.$tag === "string")`;
    default:
      return "false";
  }
}

// Sentinel class for __loop/__continue: thrown by __continue, caught by __loop.
class _LoopContinue {
  constructor(public readonly _v: unknown[]) {}
}

// Compile a Marinada expression to a native JS function.
// Throws CompileError if the expression cannot be compiled (e.g. uses effects).
export function compile(expr: Expr): JitFn {
  const body = compileExpr(expr, emptyCtx());
  // eslint-disable-next-line no-new-func
  const raw = new Function("env", "_rt", "_nat", "_LoopContinue", `return (${body})`);
  return (env: Record<string, unknown>) => raw(env, RUNTIME, NATIVES, _LoopContinue);
}
