import type { Expr, Module, TypeDef } from "./types.ts";

// --- MType ---

export type MType =
  | { kind: "unknown" }
  | { kind: "null" }
  | { kind: "bool" }
  | { kind: "int" }
  | { kind: "float" }
  | { kind: "string" }
  | { kind: "bytes" }
  | { kind: "array"; elem: MType }
  | { kind: "record"; fields: Map<string, MType> }
  | { kind: "fn"; params: MType[]; ret: MType }
  | { kind: "union"; types: MType[] }
  | { kind: "linear"; inner: MType }
  | { kind: "affine"; inner: MType }
  | { kind: "variant"; tag: string; fields: MType[] }
  | { kind: "named"; name: string };

// Singleton constants
const UNKNOWN: MType = { kind: "unknown" };
const NULL_T: MType = { kind: "null" };
const BOOL: MType = { kind: "bool" };
const INT: MType = { kind: "int" };
const FLOAT: MType = { kind: "float" };
const STRING: MType = { kind: "string" };

// --- TypeEnv ---

export class TypeEnv {
  private readonly bindings: Map<string, MType>;
  private readonly parent: TypeEnv | null;

  constructor(bindings: Map<string, MType> = new Map(), parent: TypeEnv | null = null) {
    this.bindings = bindings;
    this.parent = parent;
  }

  lookup(name: string): MType | undefined {
    const t = this.bindings.get(name);
    if (t !== undefined) return t;
    return this.parent?.lookup(name);
  }

  extend(bindings: Record<string, MType>): TypeEnv {
    return new TypeEnv(new Map(Object.entries(bindings)), this);
  }

  set(name: string, t: MType): void {
    this.bindings.set(name, t);
  }
}

export const EMPTY_TYPE_ENV = new TypeEnv();

// --- Error types ---

export type TypecheckError = {
  code: string;
  path: number[];
  message: string;
  expected?: string;
  got?: string;
  suggestion?: string;
};

export type TypecheckResult = { ok: true; type: MType } | { ok: false; errors: TypecheckError[] };

// --- Helpers ---

function isNumeric(t: MType): boolean {
  return t.kind === "int" || t.kind === "float" || t.kind === "unknown";
}

function isBoolLike(t: MType): boolean {
  return t.kind === "bool" || t.kind === "unknown";
}

function typeName(t: MType): string {
  switch (t.kind) {
    case "unknown":
      return "unknown";
    case "null":
      return "null";
    case "bool":
      return "bool";
    case "int":
      return "int";
    case "float":
      return "float";
    case "string":
      return "string";
    case "bytes":
      return "bytes";
    case "array":
      return "array<" + typeName(t.elem) + ">";
    case "record":
      return "record";
    case "fn":
      return "fn(" + t.params.map(typeName).join(", ") + ") -> " + typeName(t.ret);
    case "union":
      return t.types.map(typeName).join(" | ");
    case "linear":
      return "linear " + typeName(t.inner);
    case "affine":
      return "affine " + typeName(t.inner);
    case "variant":
      return t.fields.length === 0 ? t.tag : t.tag + "(" + t.fields.map(typeName).join(", ") + ")";
    case "named":
      return t.name;
  }
}

/** Build a union of two types, flattening and deduplicating. */
function makeUnion(a: MType, b: MType): MType {
  if (typesEqual(a, b)) return a;
  if (a.kind === "unknown" || b.kind === "unknown") return UNKNOWN;
  const flatA = a.kind === "union" ? a.types : [a];
  const flatB = b.kind === "union" ? b.types : [b];
  const merged: MType[] = [...flatA];
  for (const t of flatB) {
    if (!merged.some((m) => typesEqual(m, t))) merged.push(t);
  }
  if (merged.length === 1) return merged[0] as MType;
  return { kind: "union", types: merged };
}

function typesEqual(a: MType, b: MType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "unknown":
    case "null":
    case "bool":
    case "int":
    case "float":
    case "string":
    case "bytes":
      return true;
    case "array":
      return typesEqual(a.elem, (b as { kind: "array"; elem: MType }).elem);
    case "record": {
      const br = b as { kind: "record"; fields: Map<string, MType> };
      if (a.fields.size !== br.fields.size) return false;
      for (const [k, v] of a.fields) {
        const bv = br.fields.get(k);
        if (bv === undefined || !typesEqual(v, bv)) return false;
      }
      return true;
    }
    case "fn": {
      const bf = b as { kind: "fn"; params: MType[]; ret: MType };
      if (a.params.length !== bf.params.length) return false;
      for (let i = 0; i < a.params.length; i++) {
        if (!typesEqual(a.params[i] as MType, bf.params[i] as MType)) return false;
      }
      return typesEqual(a.ret, bf.ret);
    }
    case "union": {
      const bu = b as { kind: "union"; types: MType[] };
      if (a.types.length !== bu.types.length) return false;
      return a.types.every((t, i) => typesEqual(t, bu.types[i] as MType));
    }
    case "linear":
      return typesEqual(a.inner, (b as { kind: "linear"; inner: MType }).inner);
    case "affine":
      return typesEqual(a.inner, (b as { kind: "affine"; inner: MType }).inner);
    case "variant": {
      const bv = b as { kind: "variant"; tag: string; fields: MType[] };
      if (a.tag !== bv.tag || a.fields.length !== bv.fields.length) return false;
      return a.fields.every((f, i) => typesEqual(f, bv.fields[i] as MType));
    }
    case "named":
      return a.name === (b as { kind: "named"; name: string }).name;
  }
}

/** Arithmetic result type for two numeric types. */
function arithResult(a: MType, b: MType): MType | null {
  if (a.kind === "unknown" || b.kind === "unknown") return UNKNOWN;
  if (a.kind === "int" && b.kind === "int") return INT;
  if ((a.kind === "float" || a.kind === "int") && (b.kind === "float" || b.kind === "int"))
    return FLOAT;
  return null;
}

// --- Context for collecting errors ---

type Ctx = {
  errors: TypecheckError[];
  path: number[];
};

function addError(
  ctx: Ctx,
  code: string,
  message: string,
  extras?: { expected?: string; got?: string; suggestion?: string },
): void {
  ctx.errors.push({ code, path: [...ctx.path], message, ...extras });
}

function withPath<T>(ctx: Ctx, idx: number, fn: (sub: Ctx) => T): T {
  const sub: Ctx = { errors: ctx.errors, path: [...ctx.path, idx] };
  return fn(sub);
}

// Safe array element access
function at(arr: Expr[], i: number): Expr {
  return arr[i] as Expr;
}

// --- Parse a type annotation string to MType ---

function parseTypeAnnotation(s: string): MType {
  switch (s) {
    case "null":
      return NULL_T;
    case "bool":
    case "boolean":
      return BOOL;
    case "int":
      return INT;
    case "float":
      return FLOAT;
    case "number":
      return { kind: "union", types: [INT, FLOAT] };
    case "string":
      return STRING;
    case "bytes":
      return { kind: "bytes" };
    case "unknown":
      return UNKNOWN;
    default:
      return UNKNOWN;
  }
}

// --- Upper-case check (variant constructors) ---

function isUpperCase(s: string): boolean {
  return s.length > 0 && (s[0] as string) >= "A" && (s[0] as string) <= "Z";
}

// --- Main type-checking function ---

function inferType(expr: Expr, env: TypeEnv, ctx: Ctx): MType {
  // Atoms
  if (expr === null) return NULL_T;
  if (typeof expr === "boolean") return BOOL;
  if (typeof expr === "number") {
    return Number.isInteger(expr) ? INT : FLOAT;
  }
  if (typeof expr === "string") {
    // Bare string = variable reference
    const t = env.lookup(expr);
    if (t === undefined) {
      // In gradual typing, unknown variable is unknown rather than hard error
      // (could be in scope at runtime). But UNDEFINED_VAR is a useful signal.
      addError(ctx, "UNDEFINED_VAR", "undefined variable: " + expr);
      return UNKNOWN;
    }
    return t;
  }

  // Array = call
  const arr = expr as Expr[];
  if (arr.length === 0) {
    addError(ctx, "UNKNOWN_OP", "empty expression array");
    return UNKNOWN;
  }

  const opExpr = arr[0];
  if (typeof opExpr !== "string") {
    addError(ctx, "UNKNOWN_OP", "first element of call must be an op name (string)");
    return UNKNOWN;
  }
  const op = opExpr;

  // Variant constructor (uppercase tag)
  if (isUpperCase(op)) {
    // Type each field arg but result type is unknown (no type defs inline)
    for (let i = 1; i < arr.length; i++) {
      withPath(ctx, i, (sub) => inferType(at(arr, i), env, sub));
    }
    return UNKNOWN;
  }

  switch (op) {
    // --- Data access ---
    case "get": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", "get requires 2 args, got " + String(arr.length - 1));
        return UNKNOWN;
      }
      withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      return UNKNOWN;
    }

    case "get-in": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", "get-in requires 2 args, got " + String(arr.length - 1));
        return UNKNOWN;
      }
      withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      return UNKNOWN;
    }

    case "set": {
      if (arr.length !== 4) {
        addError(ctx, "ARITY_ERROR", "set requires 3 args, got " + String(arr.length - 1));
        return UNKNOWN;
      }
      withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      withPath(ctx, 3, (sub) => inferType(at(arr, 3), env, sub));
      return UNKNOWN;
    }

    case "set-in": {
      if (arr.length !== 4) {
        addError(ctx, "ARITY_ERROR", "set-in requires 3 args, got " + String(arr.length - 1));
        return UNKNOWN;
      }
      withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      withPath(ctx, 3, (sub) => inferType(at(arr, 3), env, sub));
      return UNKNOWN;
    }

    // --- Arithmetic ---
    case "+":
    case "-":
    case "*":
    case "/":
    case "%": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", op + " requires 2 args, got " + String(arr.length - 1));
        return UNKNOWN;
      }
      const ta = withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      const tb = withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      const result = arithResult(ta, tb);
      if (result === null) {
        if (!isNumeric(ta)) {
          withPath(ctx, 1, (sub) =>
            addError(sub, "TYPE_MISMATCH", "arithmetic requires number, got " + typeName(ta), {
              expected: "int | float",
              got: typeName(ta),
            }),
          );
        }
        if (!isNumeric(tb)) {
          withPath(ctx, 2, (sub) =>
            addError(sub, "TYPE_MISMATCH", "arithmetic requires number, got " + typeName(tb), {
              expected: "int | float",
              got: typeName(tb),
            }),
          );
        }
        return UNKNOWN;
      }
      return result;
    }

    // --- Comparison ---
    case "==":
    case "!=": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", op + " requires 2 args");
        return BOOL;
      }
      withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      return BOOL;
    }

    case "<":
    case ">":
    case "<=":
    case ">=": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", op + " requires 2 args");
        return BOOL;
      }
      const ta = withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      const tb = withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      if (!isNumeric(ta)) {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "comparison requires number, got " + typeName(ta), {
            expected: "int | float",
            got: typeName(ta),
          }),
        );
      }
      if (!isNumeric(tb)) {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", "comparison requires number, got " + typeName(tb), {
            expected: "int | float",
            got: typeName(tb),
          }),
        );
      }
      return BOOL;
    }

    // --- Logic ---
    case "and":
    case "or": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", op + " requires 2 args");
        return BOOL;
      }
      const ta = withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      const tb = withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      if (!isBoolLike(ta)) {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " requires bool, got " + typeName(ta), {
            expected: "bool",
            got: typeName(ta),
          }),
        );
      }
      if (!isBoolLike(tb)) {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " requires bool, got " + typeName(tb), {
            expected: "bool",
            got: typeName(tb),
          }),
        );
      }
      return BOOL;
    }

    case "not": {
      if (arr.length !== 2) {
        addError(ctx, "ARITY_ERROR", "not requires 1 arg");
        return BOOL;
      }
      const ta = withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      if (!isBoolLike(ta)) {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "not requires bool, got " + typeName(ta), {
            expected: "bool",
            got: typeName(ta),
          }),
        );
      }
      return BOOL;
    }

    // --- Control flow ---
    case "if": {
      if (arr.length !== 4) {
        addError(ctx, "ARITY_ERROR", "if requires 3 args (cond, then, else)");
        return UNKNOWN;
      }
      const condT = withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      if (!isBoolLike(condT)) {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "if condition must be bool, got " + typeName(condT), {
            expected: "bool",
            got: typeName(condT),
          }),
        );
      }
      const thenT = withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      const elseT = withPath(ctx, 3, (sub) => inferType(at(arr, 3), env, sub));
      return makeUnion(thenT, elseT);
    }

    case "do": {
      if (arr.length < 2) {
        addError(ctx, "ARITY_ERROR", "do requires at least 1 expr");
        return UNKNOWN;
      }
      let last: MType = UNKNOWN;
      for (let i = 1; i < arr.length; i++) {
        last = withPath(ctx, i, (sub) => inferType(at(arr, i), env, sub));
      }
      return last;
    }

    case "let": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", "let requires 2 args");
        return UNKNOWN;
      }
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        withPath(ctx, 1, (sub) => addError(sub, "TYPE_MISMATCH", "let bindings must be an array"));
        return UNKNOWN;
      }
      let currentEnv = env;
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) {
          withPath(ctx, 1, (sub) =>
            withPath(sub, i, (sub2) =>
              addError(sub2, "TYPE_MISMATCH", "each let binding must be [name, expr]"),
            ),
          );
          continue;
        }
        const name = binding[0];
        if (typeof name !== "string") {
          withPath(ctx, 1, (sub) =>
            withPath(sub, i, (sub2) =>
              addError(sub2, "TYPE_MISMATCH", "let binding name must be a string"),
            ),
          );
          continue;
        }
        const valT = withPath(ctx, 1, (sub) =>
          withPath(sub, i, (sub2) => inferType(binding[1] as Expr, currentEnv, sub2)),
        );
        currentEnv = currentEnv.extend({ [name]: valT });
      }
      return withPath(ctx, 2, (sub) => inferType(at(arr, 2), currentEnv, sub));
    }

    case "letrec": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", "letrec requires 2 args");
        return UNKNOWN;
      }
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "letrec bindings must be an array"),
        );
        return UNKNOWN;
      }
      // All bindings initially unknown (recursive refs)
      const placeholders: Record<string, MType> = {};
      const names: string[] = [];
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) continue;
        const name = binding[0];
        if (typeof name !== "string") continue;
        names.push(name);
        placeholders[name] = UNKNOWN;
      }
      const recEnv = env.extend(placeholders);
      // Check each binding body in the recursive env
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i] as Expr[];
        withPath(ctx, 1, (sub) =>
          withPath(sub, i, (sub2) => inferType(binding[1] as Expr, recEnv, sub2)),
        );
      }
      return withPath(ctx, 2, (sub) => inferType(at(arr, 2), recEnv, sub));
    }

    // --- Type ops ---
    case "is": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", "is requires 2 args");
        return BOOL;
      }
      // arg1 is the type name string (not evaluated as expr), arg2 is the value
      withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      return BOOL;
    }

    case "as": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", "as requires 2 args");
        return UNKNOWN;
      }
      const typStr = arr[1];
      if (typeof typStr !== "string") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "as requires a type name string as first arg"),
        );
        return UNKNOWN;
      }
      withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      return parseTypeAnnotation(typStr);
    }

    case "untyped": {
      if (arr.length !== 2) {
        addError(ctx, "ARITY_ERROR", "untyped requires 1 arg");
      }
      // Skip type-checking the inner expr entirely
      return UNKNOWN;
    }

    // --- Collections ---
    case "map": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", "map requires 2 args");
        return UNKNOWN;
      }
      const fnT = withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      const arrT = withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      if (arrT.kind !== "array" && arrT.kind !== "unknown") {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", "map requires array, got " + typeName(arrT), {
            expected: "array",
            got: typeName(arrT),
          }),
        );
        return UNKNOWN;
      }
      // Infer return type from fn
      if (fnT.kind === "fn") {
        return { kind: "array", elem: fnT.ret };
      }
      return { kind: "array", elem: UNKNOWN };
    }

    case "filter": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", "filter requires 2 args");
        return UNKNOWN;
      }
      withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      const arrT = withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      if (arrT.kind !== "array" && arrT.kind !== "unknown") {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", "filter requires array, got " + typeName(arrT), {
            expected: "array",
            got: typeName(arrT),
          }),
        );
        return UNKNOWN;
      }
      // filter preserves element type
      return arrT.kind === "array" ? arrT : { kind: "array", elem: UNKNOWN };
    }

    case "reduce": {
      if (arr.length !== 4) {
        addError(ctx, "ARITY_ERROR", "reduce requires 3 args");
        return UNKNOWN;
      }
      withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      const initT = withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      const arrT = withPath(ctx, 3, (sub) => inferType(at(arr, 3), env, sub));
      if (arrT.kind !== "array" && arrT.kind !== "unknown") {
        withPath(ctx, 3, (sub) =>
          addError(sub, "TYPE_MISMATCH", "reduce requires array, got " + typeName(arrT), {
            expected: "array",
            got: typeName(arrT),
          }),
        );
        return UNKNOWN;
      }
      // Return type is type of init (or unknown)
      return initT;
    }

    case "count": {
      if (arr.length !== 2) {
        addError(ctx, "ARITY_ERROR", "count requires 1 arg");
        return INT;
      }
      const arrT = withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      if (arrT.kind !== "array" && arrT.kind !== "record" && arrT.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "count requires array or record, got " + typeName(arrT), {
            expected: "array | record",
            got: typeName(arrT),
          }),
        );
      }
      return INT;
    }

    case "merge": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", "merge requires 2 args");
        return UNKNOWN;
      }
      const r1T = withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      const r2T = withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      if (r1T.kind !== "record" && r1T.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "merge requires record, got " + typeName(r1T), {
            expected: "record",
            got: typeName(r1T),
          }),
        );
      }
      if (r2T.kind !== "record" && r2T.kind !== "unknown") {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", "merge requires record, got " + typeName(r2T), {
            expected: "record",
            got: typeName(r2T),
          }),
        );
      }
      // Merge known fields, conflicts become unknown
      if (r1T.kind === "record" && r2T.kind === "record") {
        const merged = new Map(r1T.fields);
        for (const [k, v] of r2T.fields) {
          const existing = merged.get(k);
          if (existing !== undefined && !typesEqual(existing, v)) {
            merged.set(k, UNKNOWN);
          } else {
            merged.set(k, v);
          }
        }
        return { kind: "record", fields: merged };
      }
      return { kind: "record", fields: new Map() };
    }

    case "keys": {
      if (arr.length !== 2) {
        addError(ctx, "ARITY_ERROR", "keys requires 1 arg");
        return { kind: "array", elem: STRING };
      }
      const recT = withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      if (recT.kind !== "record" && recT.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "keys requires record, got " + typeName(recT), {
            expected: "record",
            got: typeName(recT),
          }),
        );
      }
      return { kind: "array", elem: STRING };
    }

    case "vals": {
      if (arr.length !== 2) {
        addError(ctx, "ARITY_ERROR", "vals requires 1 arg");
        return { kind: "array", elem: UNKNOWN };
      }
      const recT = withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      if (recT.kind !== "record" && recT.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "vals requires record, got " + typeName(recT), {
            expected: "record",
            got: typeName(recT),
          }),
        );
      }
      return { kind: "array", elem: UNKNOWN };
    }

    // --- String ops ---
    case "concat": {
      if (arr.length < 2) {
        addError(ctx, "ARITY_ERROR", "concat requires at least 1 arg");
        return STRING;
      }
      for (let i = 1; i < arr.length; i++) {
        const t = withPath(ctx, i, (sub) => inferType(at(arr, i), env, sub));
        if (t.kind !== "string" && t.kind !== "unknown") {
          withPath(ctx, i, (sub) =>
            addError(sub, "TYPE_MISMATCH", "concat requires string, got " + typeName(t), {
              expected: "string",
              got: typeName(t),
            }),
          );
        }
      }
      return STRING;
    }

    case "slice": {
      if (arr.length !== 4) {
        addError(ctx, "ARITY_ERROR", "slice requires 3 args");
        return STRING;
      }
      const sT = withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      const startT = withPath(ctx, 2, (sub) => inferType(at(arr, 2), env, sub));
      const endT = withPath(ctx, 3, (sub) => inferType(at(arr, 3), env, sub));
      if (sT.kind !== "string" && sT.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "slice requires string, got " + typeName(sT), {
            expected: "string",
            got: typeName(sT),
          }),
        );
      }
      if (startT.kind !== "int" && startT.kind !== "unknown") {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", "slice start must be int, got " + typeName(startT), {
            expected: "int",
            got: typeName(startT),
          }),
        );
      }
      if (endT.kind !== "int" && endT.kind !== "unknown") {
        withPath(ctx, 3, (sub) =>
          addError(sub, "TYPE_MISMATCH", "slice end must be int, got " + typeName(endT), {
            expected: "int",
            got: typeName(endT),
          }),
        );
      }
      return STRING;
    }

    case "to-string": {
      if (arr.length !== 2) {
        addError(ctx, "ARITY_ERROR", "to-string requires 1 arg");
        return STRING;
      }
      withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      return STRING;
    }

    case "parse-number": {
      if (arr.length !== 2) {
        addError(ctx, "ARITY_ERROR", "parse-number requires 1 arg");
        return makeUnion(INT, makeUnion(FLOAT, NULL_T));
      }
      const t = withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      if (t.kind !== "string" && t.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "parse-number requires string, got " + typeName(t), {
            expected: "string",
            got: typeName(t),
          }),
        );
      }
      return makeUnion(INT, makeUnion(FLOAT, NULL_T));
    }

    // --- Functions ---
    case "fn": {
      if (arr.length !== 3) {
        addError(ctx, "ARITY_ERROR", "fn requires 2 args");
        return { kind: "fn", params: [], ret: UNKNOWN };
      }
      const paramsExpr = arr[1];
      if (!Array.isArray(paramsExpr)) {
        withPath(ctx, 1, (sub) => addError(sub, "TYPE_MISMATCH", "fn params must be an array"));
        return { kind: "fn", params: [], ret: UNKNOWN };
      }
      const paramTypes: MType[] = [];
      const paramBindings: Record<string, MType> = {};
      for (let i = 0; i < paramsExpr.length; i++) {
        const p = paramsExpr[i];
        if (typeof p === "string") {
          paramTypes.push(UNKNOWN);
          paramBindings[p] = UNKNOWN;
        } else if (Array.isArray(p) && p.length >= 2 && typeof p[0] === "string") {
          const paramType = parseTypeAnnotation(p[1] as string);
          paramTypes.push(paramType);
          paramBindings[p[0] as string] = paramType;
        } else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") {
          paramTypes.push(UNKNOWN);
          paramBindings[p[0] as string] = UNKNOWN;
        } else {
          withPath(ctx, 1, (sub) =>
            withPath(sub, i, (sub2) =>
              addError(sub2, "TYPE_MISMATCH", "fn param must be a string or [name, type] pair"),
            ),
          );
          paramTypes.push(UNKNOWN);
        }
      }
      const fnEnv = env.extend(paramBindings);
      const retT = withPath(ctx, 2, (sub) => inferType(at(arr, 2), fnEnv, sub));
      return { kind: "fn", params: paramTypes, ret: retT };
    }

    case "call": {
      if (arr.length < 2) {
        addError(ctx, "ARITY_ERROR", "call requires at least 1 arg");
        return UNKNOWN;
      }
      const fnT = withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      const argTypes: MType[] = [];
      for (let i = 2; i < arr.length; i++) {
        argTypes.push(withPath(ctx, i, (sub) => inferType(at(arr, i), env, sub)));
      }
      if (fnT.kind === "fn") {
        if (argTypes.length !== fnT.params.length) {
          addError(
            ctx,
            "ARITY_ERROR",
            "fn expects " + String(fnT.params.length) + " args, got " + String(argTypes.length),
          );
          return fnT.ret;
        }
        // Check each arg against param type
        for (let i = 0; i < fnT.params.length; i++) {
          const paramT = fnT.params[i] as MType;
          const argT = argTypes[i] as MType;
          if (paramT.kind !== "unknown" && argT.kind !== "unknown" && !typesEqual(paramT, argT)) {
            withPath(ctx, i + 2, (sub) =>
              addError(
                sub,
                "TYPE_MISMATCH",
                "arg " + String(i) + ": expected " + typeName(paramT) + ", got " + typeName(argT),
                { expected: typeName(paramT), got: typeName(argT) },
              ),
            );
          }
        }
        return fnT.ret;
      }
      // unknown fn type: pass through
      return UNKNOWN;
    }

    // --- Match ---
    case "match": {
      if (arr.length < 3) {
        addError(ctx, "ARITY_ERROR", "match requires at least 2 args");
        return UNKNOWN;
      }
      withPath(ctx, 1, (sub) => inferType(at(arr, 1), env, sub));
      let resultType: MType | null = null;
      for (let i = 2; i < arr.length; i++) {
        const clause = arr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          withPath(ctx, i, (sub) =>
            addError(sub, "TYPE_MISMATCH", "match clause must be [pattern, body]"),
          );
          continue;
        }
        const pattern = clause[0];
        const body = clause[1] as Expr;
        if (!Array.isArray(pattern) || pattern.length < 1) {
          withPath(ctx, i, (sub) =>
            withPath(sub, 0, (sub2) =>
              addError(sub2, "TYPE_MISMATCH", "match pattern must be an array starting with a tag"),
            ),
          );
          continue;
        }
        // Bind pattern variables as unknown
        const patternBindings: Record<string, MType> = {};
        for (let j = 1; j < pattern.length; j++) {
          const bName = pattern[j];
          if (typeof bName === "string") {
            patternBindings[bName] = UNKNOWN;
          }
        }
        const branchEnv = env.extend(patternBindings);
        const branchT = withPath(ctx, i, (sub) =>
          withPath(sub, 1, (sub2) => inferType(body, branchEnv, sub2)),
        );
        resultType = resultType === null ? branchT : makeUnion(resultType, branchT);
      }
      return resultType ?? UNKNOWN;
    }

    case "cond": {
      if (arr.length < 2) {
        addError(ctx, "ARITY_ERROR", "cond requires at least 1 clause");
        return UNKNOWN;
      }
      let resultType: MType | null = null;
      for (let i = 1; i < arr.length; i++) {
        const clause = arr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          withPath(ctx, i, (sub) =>
            addError(sub, "TYPE_MISMATCH", "cond clause must be [test, expr]"),
          );
          continue;
        }
        const test = clause[0];
        const body = clause[1] as Expr;
        if (test === "else") {
          // else clause — no condition to check
        } else {
          const testT = withPath(ctx, i, (sub) =>
            withPath(sub, 0, (sub2) => inferType(test as Expr, env, sub2)),
          );
          if (!isBoolLike(testT)) {
            withPath(ctx, i, (sub) =>
              withPath(sub, 0, (sub2) =>
                addError(sub2, "TYPE_MISMATCH", "cond test must be bool, got " + typeName(testT), {
                  expected: "bool",
                  got: typeName(testT),
                }),
              ),
            );
          }
        }
        const branchT = withPath(ctx, i, (sub) =>
          withPath(sub, 1, (sub2) => inferType(body, env, sub2)),
        );
        resultType = resultType === null ? branchT : makeUnion(resultType, branchT);
      }
      return resultType ?? UNKNOWN;
    }

    default:
      addError(ctx, "UNKNOWN_OP", "unknown op: " + op);
      return UNKNOWN;
  }
}

// --- Public API ---

export function typecheck(expr: Expr, env?: TypeEnv): TypecheckResult {
  const ctx: Ctx = { errors: [], path: [] };
  const type = inferType(expr, env ?? EMPTY_TYPE_ENV, ctx);
  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }
  return { ok: true, type };
}

// --- lib:std definitions ---

// lib:std exports option<T> and result<T, E> as variant constructors with unknown fields.
// Tags: None (0 fields), Some (1 field), Ok (1 field), Err (1 field).
const STD_TYPE_BINDINGS: Record<string, MType> = {
  None: { kind: "variant", tag: "None", fields: [] },
  Some: { kind: "variant", tag: "Some", fields: [UNKNOWN] },
  Ok: { kind: "variant", tag: "Ok", fields: [UNKNOWN] },
  Err: { kind: "variant", tag: "Err", fields: [UNKNOWN] },
};

/** Load type defs from a TypeDef[] into a Record of name→MType bindings. */
function typeDefsToBindings(defs: TypeDef[]): Record<string, MType> {
  const bindings: Record<string, MType> = {};
  for (const def of defs) {
    for (const variant of def.variants) {
      const fields: MType[] = (variant.fields ?? []).map(([, typeName_]) =>
        parseTypeAnnotation(typeName_),
      );
      bindings[variant.tag] = { kind: "variant", tag: variant.tag, fields };
    }
  }
  return bindings;
}

/** Resolve imports for a module into type env bindings. Unknown schemes → all unknown. */
function resolveImportBindings(imports: Module["imports"]): Record<string, MType> {
  const bindings: Record<string, MType> = {};
  for (const imp of imports ?? []) {
    if (imp.from === "lib:std") {
      for (const name of imp.import) {
        const t = STD_TYPE_BINDINGS[name];
        if (t !== undefined) {
          bindings[name] = t;
        } else {
          // Known lib:std but not a variant constructor — treat as unknown
          bindings[name] = UNKNOWN;
        }
      }
    } else {
      // local:, https:, or unknown lib: — stub: all imports are unknown
      for (const name of imp.import) {
        bindings[name] = UNKNOWN;
      }
    }
  }
  return bindings;
}

export function typecheckModule(module: Module): TypecheckResult {
  const ctx: Ctx = { errors: [], path: [] };

  // Build type env: start with import bindings, then layer type def bindings on top
  const importBindings = resolveImportBindings(module.imports);
  const typeDefBindings = typeDefsToBindings(module.types ?? []);
  const moduleEnv = EMPTY_TYPE_ENV.extend({ ...importBindings, ...typeDefBindings });

  const type = inferType(module.main, moduleEnv, ctx);
  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }
  return { ok: true, type };
}
