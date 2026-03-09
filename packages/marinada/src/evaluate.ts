import type { Expr } from "./types.ts";
import { Env, EMPTY_ENV } from "./env.ts";
import { type Value, NULL, bool, valEqual, typeName, valueToString } from "./value.ts";

export type EvalError = {
  code: string;
  path: number[];
  message: string;
};

export type EvalResult = { ok: true; value: Value } | { ok: false; error: EvalError };

// --- Result helpers ---

function ok(value: Value): EvalResult {
  return { ok: true, value };
}

function err(code: string, path: number[], message: string): EvalResult {
  return { ok: false, error: { code, path, message } };
}

function prependPath(result: EvalResult, idx: number): EvalResult {
  if (result.ok) return result;
  return { ok: false, error: { ...result.error, path: [idx, ...result.error.path] } };
}

// Safe array access — callers guarantee index is in bounds after length checks.
// Using `as Expr` cast instead of `!` to satisfy no-non-null-assertion rule.
function at(arr: Expr[], i: number): Expr {
  return arr[i] as Expr;
}

// --- Type guards ---

function isInt(v: Value): v is { kind: "int"; value: bigint } {
  return v.kind === "int";
}

function isNumeric(
  v: Value,
): v is { kind: "int"; value: bigint } | { kind: "float"; value: number } {
  return v.kind === "int" || v.kind === "float";
}

// Convert int to float for mixed arithmetic
function toFloat(v: { kind: "int"; value: bigint } | { kind: "float"; value: number }): number {
  if (v.kind === "float") return v.value;
  return Number(v.value);
}

// --- Arithmetic helpers ---

type ArithOp = "+" | "-" | "*" | "/" | "%";

function applyArith(op: ArithOp, a: Value, b: Value, path: number[]): EvalResult {
  if (!isNumeric(a)) {
    return err(
      "TYPE_ERROR",
      path,
      "arithmetic requires number, got " + typeName(a) + " for left operand",
    );
  }
  if (!isNumeric(b)) {
    return err(
      "TYPE_ERROR",
      path,
      "arithmetic requires number, got " + typeName(b) + " for right operand",
    );
  }

  // int op int = int; anything with float = float
  if (isInt(a) && isInt(b)) {
    const av = a.value;
    const bv = b.value;
    switch (op) {
      case "+":
        return ok({ kind: "int", value: av + bv });
      case "-":
        return ok({ kind: "int", value: av - bv });
      case "*":
        return ok({ kind: "int", value: av * bv });
      case "/":
        if (bv === 0n) return err("DIVISION_BY_ZERO", path, "integer division by zero");
        return ok({ kind: "int", value: av / bv });
      case "%":
        if (bv === 0n) return err("DIVISION_BY_ZERO", path, "integer modulo by zero");
        return ok({ kind: "int", value: av % bv });
    }
  } else {
    const av = toFloat(a);
    const bv = toFloat(b);
    switch (op) {
      case "+":
        return ok({ kind: "float", value: av + bv });
      case "-":
        return ok({ kind: "float", value: av - bv });
      case "*":
        return ok({ kind: "float", value: av * bv });
      case "/":
        return ok({ kind: "float", value: av / bv });
      case "%":
        return ok({ kind: "float", value: av % bv });
    }
  }
}

// --- Comparison helpers ---

type CmpOp = "<" | ">" | "<=" | ">=";

function applyNumericCmp(op: CmpOp, a: Value, b: Value, path: number[]): EvalResult {
  if (!isNumeric(a)) {
    return err("TYPE_ERROR", path, "comparison requires number, got " + typeName(a));
  }
  if (!isNumeric(b)) {
    return err("TYPE_ERROR", path, "comparison requires number, got " + typeName(b));
  }
  // Promote to float for mixed comparison to keep things consistent
  const av = toFloat(a);
  const bv = toFloat(b);
  switch (op) {
    case "<":
      return ok(bool(av < bv));
    case ">":
      return ok(bool(av > bv));
    case "<=":
      return ok(bool(av <= bv));
    case ">=":
      return ok(bool(av >= bv));
  }
}

// --- get / set helpers ---

function getIn(obj: Value, path: Value[], pathPrefix: number[]): EvalResult {
  let current = obj;
  for (let i = 0; i < path.length; i++) {
    const key = path[i] as Value;
    const result = getField(current, key, [...pathPrefix, i]);
    if (!result.ok) return result;
    current = result.value;
  }
  return ok(current);
}

function getField(obj: Value, key: Value, errPath: number[]): EvalResult {
  if (obj.kind === "record") {
    if (key.kind !== "string") {
      return err("TYPE_ERROR", errPath, "record key must be string, got " + typeName(key));
    }
    const val = obj.value.get(key.value);
    if (val === undefined) {
      return ok(NULL);
    }
    return ok(val);
  } else if (obj.kind === "array") {
    if (key.kind !== "int") {
      return err("TYPE_ERROR", errPath, "array index must be int, got " + typeName(key));
    }
    const idx = Number(key.value);
    if (idx < 0 || idx >= obj.value.length) {
      return ok(NULL);
    }
    return ok(obj.value[idx] as Value);
  } else {
    return err("TYPE_ERROR", errPath, "get requires record or array, got " + typeName(obj));
  }
}

function setField(obj: Value, key: Value, val: Value, errPath: number[]): EvalResult {
  if (obj.kind === "record") {
    if (key.kind !== "string") {
      return err("TYPE_ERROR", errPath, "record key must be string, got " + typeName(key));
    }
    const newMap = new Map(obj.value);
    newMap.set(key.value, val);
    return ok({ kind: "record", value: newMap });
  } else if (obj.kind === "array") {
    if (key.kind !== "int") {
      return err("TYPE_ERROR", errPath, "array index must be int, got " + typeName(key));
    }
    const idx = Number(key.value);
    if (idx < 0 || idx > obj.value.length) {
      return err(
        "TYPE_ERROR",
        errPath,
        "array index " + String(idx) + " out of bounds (length " + String(obj.value.length) + ")",
      );
    }
    const newArr = [...obj.value];
    newArr[idx] = val;
    return ok({ kind: "array", value: newArr });
  } else {
    return err("TYPE_ERROR", errPath, "set requires record or array, got " + typeName(obj));
  }
}

function setIn(obj: Value, path: Value[], val: Value, pathPrefix: number[]): EvalResult {
  if (path.length === 0) return ok(val);
  const key = path[0] as Value;
  // Get current child
  const childResult = getField(obj, key, pathPrefix);
  if (!childResult.ok) return childResult;
  // Recurse
  const newChildResult = setIn(childResult.value, path.slice(1), val, [...pathPrefix, 0]);
  if (!newChildResult.ok) return newChildResult;
  return setField(obj, key, newChildResult.value, pathPrefix);
}

// --- Call a fn value ---

function callFn(fn: Value, args: Value[], callPath: number[]): EvalResult {
  if (fn.kind !== "fn") {
    return err("TYPE_ERROR", callPath, "call requires fn, got " + typeName(fn));
  }
  if (args.length !== fn.params.length) {
    return err(
      "ARITY_ERROR",
      callPath,
      "fn expects " + String(fn.params.length) + " args, got " + String(args.length),
    );
  }
  const bindings: Record<string, Value> = {};
  for (let i = 0; i < fn.params.length; i++) {
    bindings[fn.params[i] as string] = args[i] as Value;
  }
  return evalExpr(fn.body, fn.env.extend(bindings));
}

// --- isVariantTag: string starting with uppercase ---

function isUpperCase(s: string): boolean {
  return s.length > 0 && (s[0] as string) >= "A" && (s[0] as string) <= "Z";
}

// --- Main evaluator ---

function evalExpr(expr: Expr, env: Env): EvalResult {
  // Atoms
  if (expr === null) return ok(NULL);
  if (typeof expr === "boolean") return ok(bool(expr));
  if (typeof expr === "number") {
    if (Number.isInteger(expr)) {
      return ok({ kind: "int", value: BigInt(expr) });
    } else {
      return ok({ kind: "float", value: expr });
    }
  }
  if (typeof expr === "string") {
    // Bare strings are variable references
    const val = env.lookup(expr);
    if (val === undefined) {
      return err("UNDEFINED_VAR", [], "undefined variable: " + expr);
    }
    return ok(val);
  }

  // Array = call
  const arr = expr;
  if (arr.length === 0) {
    return err("UNKNOWN_OP", [], "empty expression array");
  }

  const opExpr = arr[0];
  if (typeof opExpr !== "string") {
    return err("UNKNOWN_OP", [], "first element of call must be an op name (string)");
  }
  const op = opExpr;

  // --- Variant constructor: uppercase tag ---
  if (isUpperCase(op)) {
    const fields: Value[] = [];
    for (let i = 1; i < arr.length; i++) {
      const r = prependPath(evalExpr(at(arr, i), env), i);
      if (!r.ok) return r;
      fields.push(r.value);
    }
    return ok({ kind: "variant", tag: op, fields });
  }

  switch (op) {
    // --- Data access ---
    case "get": {
      if (arr.length !== 3)
        return err("ARITY_ERROR", [], "get requires 2 args, got " + String(arr.length - 1));
      const objR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!objR.ok) return objR;
      const keyR = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!keyR.ok) return keyR;
      return getField(objR.value, keyR.value, [2]);
    }

    case "get-in": {
      if (arr.length !== 3)
        return err("ARITY_ERROR", [], "get-in requires 2 args, got " + String(arr.length - 1));
      const objR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!objR.ok) return objR;
      const pathR = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!pathR.ok) return pathR;
      if (pathR.value.kind !== "array") {
        return err("TYPE_ERROR", [2], "get-in path must be array, got " + typeName(pathR.value));
      }
      return getIn(objR.value, pathR.value.value, [1]);
    }

    case "set": {
      if (arr.length !== 4)
        return err("ARITY_ERROR", [], "set requires 3 args, got " + String(arr.length - 1));
      const objR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!objR.ok) return objR;
      const keyR = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!keyR.ok) return keyR;
      const valR = prependPath(evalExpr(at(arr, 3), env), 3);
      if (!valR.ok) return valR;
      return setField(objR.value, keyR.value, valR.value, [2]);
    }

    case "set-in": {
      if (arr.length !== 4)
        return err("ARITY_ERROR", [], "set-in requires 3 args, got " + String(arr.length - 1));
      const objR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!objR.ok) return objR;
      const pathR = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!pathR.ok) return pathR;
      if (pathR.value.kind !== "array") {
        return err("TYPE_ERROR", [2], "set-in path must be array, got " + typeName(pathR.value));
      }
      const valR = prependPath(evalExpr(at(arr, 3), env), 3);
      if (!valR.ok) return valR;
      return setIn(objR.value, pathR.value.value, valR.value, [1]);
    }

    // --- Arithmetic ---
    case "+":
    case "-":
    case "*":
    case "/":
    case "%": {
      if (arr.length !== 3)
        return err("ARITY_ERROR", [], op + " requires 2 args, got " + String(arr.length - 1));
      const ar = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      const br = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!br.ok) return br;
      return applyArith(op, ar.value, br.value, []);
    }

    // --- Comparison ---
    case "==": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "== requires 2 args");
      const ar = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      const br = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!br.ok) return br;
      return ok(bool(valEqual(ar.value, br.value)));
    }

    case "!=": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "!= requires 2 args");
      const ar = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      const br = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!br.ok) return br;
      return ok(bool(!valEqual(ar.value, br.value)));
    }

    case "<":
    case ">":
    case "<=":
    case ">=": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], op + " requires 2 args");
      const ar = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      const br = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!br.ok) return br;
      return applyNumericCmp(op, ar.value, br.value, []);
    }

    // --- Logic ---
    case "and": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "and requires 2 args");
      const ar = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      if (ar.value.kind !== "bool") {
        return err("TYPE_ERROR", [1], "and requires bool, got " + typeName(ar.value));
      }
      const br = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!br.ok) return br;
      if (br.value.kind !== "bool") {
        return err("TYPE_ERROR", [2], "and requires bool, got " + typeName(br.value));
      }
      return ok(bool(ar.value.value && br.value.value));
    }

    case "or": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "or requires 2 args");
      const ar = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      if (ar.value.kind !== "bool") {
        return err("TYPE_ERROR", [1], "or requires bool, got " + typeName(ar.value));
      }
      const br = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!br.ok) return br;
      if (br.value.kind !== "bool") {
        return err("TYPE_ERROR", [2], "or requires bool, got " + typeName(br.value));
      }
      return ok(bool(ar.value.value || br.value.value));
    }

    case "not": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "not requires 1 arg");
      const ar = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      if (ar.value.kind !== "bool") {
        return err("TYPE_ERROR", [1], "not requires bool, got " + typeName(ar.value));
      }
      return ok(bool(!ar.value.value));
    }

    // --- Control flow ---
    case "if": {
      if (arr.length !== 4) return err("ARITY_ERROR", [], "if requires 3 args (cond, then, else)");
      const condR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!condR.ok) return condR;
      if (condR.value.kind !== "bool") {
        return err("TYPE_ERROR", [1], "if condition must be bool, got " + typeName(condR.value));
      }
      if (condR.value.value) {
        return prependPath(evalExpr(at(arr, 2), env), 2);
      } else {
        return prependPath(evalExpr(at(arr, 3), env), 3);
      }
    }

    case "do": {
      if (arr.length < 2) return err("ARITY_ERROR", [], "do requires at least 1 expr");
      let last: EvalResult = ok(NULL);
      for (let i = 1; i < arr.length; i++) {
        last = prependPath(evalExpr(at(arr, i), env), i);
        if (!last.ok) return last;
      }
      return last;
    }

    case "let": {
      // ["let", [[name, val], ...], expr]
      if (arr.length !== 3) return err("ARITY_ERROR", [], "let requires 2 args");
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        return err("TYPE_ERROR", [1], "let bindings must be an array");
      }
      let currentEnv = env;
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) {
          return err("TYPE_ERROR", [1, i], "each let binding must be [name, expr]");
        }
        const name = binding[0];
        if (typeof name !== "string") {
          return err("TYPE_ERROR", [1, i, 0], "let binding name must be a string");
        }
        const valR = prependPath(evalExpr(binding[1] as Expr, currentEnv), i);
        if (!valR.ok) return valR;
        currentEnv = currentEnv.extend({ [name]: valR.value });
      }
      return prependPath(evalExpr(at(arr, 2), currentEnv), 2);
    }

    case "letrec": {
      // ["letrec", [[name, val], ...], expr]
      // All bindings are in scope for all values (supports mutual recursion)
      if (arr.length !== 3) return err("ARITY_ERROR", [], "letrec requires 2 args");
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        return err("TYPE_ERROR", [1], "letrec bindings must be an array");
      }
      // Create a frame with placeholder nulls, then fill in
      const placeholders: Record<string, Value> = {};
      const names: string[] = [];
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) {
          return err("TYPE_ERROR", [1, i], "each letrec binding must be [name, expr]");
        }
        const name = binding[0];
        if (typeof name !== "string") {
          return err("TYPE_ERROR", [1, i, 0], "letrec binding name must be a string");
        }
        names.push(name);
        placeholders[name] = NULL;
      }
      const recEnv = env.extend(placeholders);
      // Now evaluate each binding in the recursive env and mutate the frame
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i] as Expr[];
        const valR = prependPath(evalExpr(binding[1] as Expr, recEnv), i);
        if (!valR.ok) return valR;
        recEnv.set(names[i] as string, valR.value);
      }
      return prependPath(evalExpr(at(arr, 2), recEnv), 2);
    }

    // --- Type ops ---
    case "is": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "is requires 2 args");
      const typStr = arr[1];
      if (typeof typStr !== "string") {
        return err("TYPE_ERROR", [1], "is requires a type name string as first arg");
      }
      const valR = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!valR.ok) return valR;
      return ok(bool(checkType(valR.value, typStr)));
    }

    case "as": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "as requires 2 args");
      const typStr = arr[1];
      if (typeof typStr !== "string") {
        return err("TYPE_ERROR", [1], "as requires a type name string as first arg");
      }
      const valR = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!valR.ok) return valR;
      if (!checkType(valR.value, typStr)) {
        return err("TYPE_ERROR", [2], "expected " + typStr + ", got " + typeName(valR.value));
      }
      return valR;
    }

    case "untyped": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "untyped requires 1 arg");
      return prependPath(evalExpr(at(arr, 1), env), 1);
    }

    // --- Collections ---
    case "map": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "map requires 2 args");
      const fnR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!fnR.ok) return fnR;
      const arrR = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!arrR.ok) return arrR;
      if (arrR.value.kind !== "array") {
        return err("TYPE_ERROR", [2], "map requires array, got " + typeName(arrR.value));
      }
      const results: Value[] = [];
      for (const item of arrR.value.value) {
        const r = callFn(fnR.value, [item], [1]);
        if (!r.ok) return r;
        results.push(r.value);
      }
      return ok({ kind: "array", value: results });
    }

    case "filter": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "filter requires 2 args");
      const fnR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!fnR.ok) return fnR;
      const arrR = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!arrR.ok) return arrR;
      if (arrR.value.kind !== "array") {
        return err("TYPE_ERROR", [2], "filter requires array, got " + typeName(arrR.value));
      }
      const results: Value[] = [];
      for (const item of arrR.value.value) {
        const r = callFn(fnR.value, [item], [1]);
        if (!r.ok) return r;
        if (r.value.kind !== "bool") {
          return err(
            "TYPE_ERROR",
            [1],
            "filter predicate must return bool, got " + typeName(r.value),
          );
        }
        if (r.value.value) results.push(item);
      }
      return ok({ kind: "array", value: results });
    }

    case "reduce": {
      if (arr.length !== 4) return err("ARITY_ERROR", [], "reduce requires 3 args");
      const fnR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!fnR.ok) return fnR;
      const initR = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!initR.ok) return initR;
      const arrR = prependPath(evalExpr(at(arr, 3), env), 3);
      if (!arrR.ok) return arrR;
      if (arrR.value.kind !== "array") {
        return err("TYPE_ERROR", [3], "reduce requires array, got " + typeName(arrR.value));
      }
      let acc = initR.value;
      for (const item of arrR.value.value) {
        const r = callFn(fnR.value, [acc, item], [1]);
        if (!r.ok) return r;
        acc = r.value;
      }
      return ok(acc);
    }

    case "count": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "count requires 1 arg");
      const arrR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!arrR.ok) return arrR;
      if (arrR.value.kind === "array") {
        return ok({ kind: "int", value: BigInt(arrR.value.value.length) });
      } else if (arrR.value.kind === "record") {
        return ok({ kind: "int", value: BigInt(arrR.value.value.size) });
      } else {
        return err(
          "TYPE_ERROR",
          [1],
          "count requires array or record, got " + typeName(arrR.value),
        );
      }
    }

    case "merge": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "merge requires 2 args");
      const r1R = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!r1R.ok) return r1R;
      const r2R = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!r2R.ok) return r2R;
      if (r1R.value.kind !== "record") {
        return err("TYPE_ERROR", [1], "merge requires record, got " + typeName(r1R.value));
      }
      if (r2R.value.kind !== "record") {
        return err("TYPE_ERROR", [2], "merge requires record, got " + typeName(r2R.value));
      }
      const merged = new Map(r1R.value.value);
      for (const [k, v] of r2R.value.value) {
        merged.set(k, v);
      }
      return ok({ kind: "record", value: merged });
    }

    case "keys": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "keys requires 1 arg");
      const recR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!recR.ok) return recR;
      if (recR.value.kind !== "record") {
        return err("TYPE_ERROR", [1], "keys requires record, got " + typeName(recR.value));
      }
      const keys: Value[] = [...recR.value.value.keys()].map((k) => ({
        kind: "string" as const,
        value: k,
      }));
      return ok({ kind: "array", value: keys });
    }

    case "vals": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "vals requires 1 arg");
      const recR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!recR.ok) return recR;
      if (recR.value.kind !== "record") {
        return err("TYPE_ERROR", [1], "vals requires record, got " + typeName(recR.value));
      }
      return ok({ kind: "array", value: [...recR.value.value.values()] });
    }

    // --- String ops ---
    case "concat": {
      if (arr.length < 2) return err("ARITY_ERROR", [], "concat requires at least 1 arg");
      let result = "";
      for (let i = 1; i < arr.length; i++) {
        const r = prependPath(evalExpr(at(arr, i), env), i);
        if (!r.ok) return r;
        if (r.value.kind !== "string") {
          return err("TYPE_ERROR", [i], "concat requires string, got " + typeName(r.value));
        }
        result += r.value.value;
      }
      return ok({ kind: "string", value: result });
    }

    case "slice": {
      if (arr.length !== 4) return err("ARITY_ERROR", [], "slice requires 3 args");
      const sR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!sR.ok) return sR;
      if (sR.value.kind !== "string") {
        return err("TYPE_ERROR", [1], "slice requires string, got " + typeName(sR.value));
      }
      const startR = prependPath(evalExpr(at(arr, 2), env), 2);
      if (!startR.ok) return startR;
      if (!isInt(startR.value)) {
        return err("TYPE_ERROR", [2], "slice start must be int, got " + typeName(startR.value));
      }
      const endR = prependPath(evalExpr(at(arr, 3), env), 3);
      if (!endR.ok) return endR;
      if (!isInt(endR.value)) {
        return err("TYPE_ERROR", [3], "slice end must be int, got " + typeName(endR.value));
      }
      const s = sR.value.value;
      const start = Number(startR.value.value);
      const end = Number(endR.value.value);
      return ok({ kind: "string", value: s.slice(start, end) });
    }

    case "to-string": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "to-string requires 1 arg");
      const valR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!valR.ok) return valR;
      return ok({ kind: "string", value: valueToString(valR.value) });
    }

    case "parse-number": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "parse-number requires 1 arg");
      const valR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!valR.ok) return valR;
      if (valR.value.kind !== "string") {
        return err("TYPE_ERROR", [1], "parse-number requires string, got " + typeName(valR.value));
      }
      const s = valR.value.value.trim();
      if (s === "") return ok(NULL);
      // Try integer first
      if (/^-?\d+$/.test(s)) {
        try {
          return ok({ kind: "int", value: BigInt(s) });
        } catch {
          // fallthrough
        }
      }
      // Try float
      const n = Number(s);
      if (!isNaN(n)) {
        return ok({ kind: "float", value: n });
      }
      return ok(NULL);
    }

    // --- Functions ---
    case "fn": {
      // ["fn", params, body]  params is array of strings (or [name, type] pairs — we take name only)
      if (arr.length !== 3) return err("ARITY_ERROR", [], "fn requires 2 args");
      const paramsExpr = arr[1];
      if (!Array.isArray(paramsExpr)) {
        return err("TYPE_ERROR", [1], "fn params must be an array");
      }
      const params: string[] = [];
      for (let i = 0; i < paramsExpr.length; i++) {
        const p = paramsExpr[i];
        if (typeof p === "string") {
          params.push(p);
        } else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") {
          // [name, type] annotation — take just the name
          params.push(p[0]);
        } else {
          return err("TYPE_ERROR", [1, i], "fn param must be a string or [name, type] pair");
        }
      }
      return ok({ kind: "fn", params, body: at(arr, 2), env });
    }

    case "call": {
      // ["call", fn, arg1, arg2, ...]
      if (arr.length < 2) return err("ARITY_ERROR", [], "call requires at least 1 arg");
      const fnR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!fnR.ok) return fnR;
      const args: Value[] = [];
      for (let i = 2; i < arr.length; i++) {
        const r = prependPath(evalExpr(at(arr, i), env), i);
        if (!r.ok) return r;
        args.push(r.value);
      }
      return callFn(fnR.value, args, []);
    }

    // --- Match ---
    case "match": {
      // ["match", expr, [["Tag", "b1", ...], body], ...]
      if (arr.length < 3) return err("ARITY_ERROR", [], "match requires at least 2 args");
      const scrutR = prependPath(evalExpr(at(arr, 1), env), 1);
      if (!scrutR.ok) return scrutR;
      const scrutVal = scrutR.value;

      for (let i = 2; i < arr.length; i++) {
        const clause = arr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          return err("TYPE_ERROR", [i], "match clause must be [pattern, body]");
        }
        const pattern = clause[0];
        const body = clause[1] as Expr;
        if (!Array.isArray(pattern) || pattern.length < 1) {
          return err("TYPE_ERROR", [i, 0], "match pattern must be an array starting with a tag");
        }
        const tag = pattern[0];
        if (typeof tag !== "string") {
          return err("TYPE_ERROR", [i, 0], "match pattern tag must be a string");
        }
        // Check if scrutinee matches this pattern
        if (scrutVal.kind !== "variant" || scrutVal.tag !== tag) continue;
        // Check field count
        const bindingNames = pattern.slice(1);
        if (bindingNames.length !== scrutVal.fields.length) {
          return err(
            "ARITY_ERROR",
            [i, 0],
            "pattern " +
              tag +
              " expects " +
              String(bindingNames.length) +
              " bindings, variant has " +
              String(scrutVal.fields.length) +
              " fields",
          );
        }
        // Bind fields
        const bindings: Record<string, Value> = {};
        for (let j = 0; j < bindingNames.length; j++) {
          const bName = bindingNames[j];
          if (typeof bName !== "string") {
            return err("TYPE_ERROR", [i, 0, j + 1], "match binding name must be a string");
          }
          bindings[bName] = scrutVal.fields[j] as Value;
        }
        return prependPath(evalExpr(body, env.extend(bindings)), i);
      }

      // No pattern matched
      if (scrutVal.kind === "variant") {
        return err(
          "NON_EXHAUSTIVE_MATCH",
          [],
          "non-exhaustive match: no clause for variant " + scrutVal.tag,
        );
      }
      return err("NON_EXHAUSTIVE_MATCH", [], "non-exhaustive match: no clause matched");
    }

    default:
      return err("UNKNOWN_OP", [], "unknown op: " + op);
  }
}

// --- Type checking for "is" / "as" ---

function checkType(v: Value, typStr: string): boolean {
  switch (typStr) {
    case "null":
      return v.kind === "null";
    case "bool":
    case "boolean":
      return v.kind === "bool";
    case "int":
      return v.kind === "int";
    case "float":
      return v.kind === "float";
    case "number":
      return v.kind === "int" || v.kind === "float";
    case "string":
      return v.kind === "string";
    case "array":
      return v.kind === "array";
    case "record":
      return v.kind === "record";
    case "bytes":
      return v.kind === "bytes";
    case "fn":
      return v.kind === "fn";
    case "variant":
      return v.kind === "variant";
    case "cap":
      return v.kind === "cap";
    default:
      return false;
  }
}

// --- Public API ---

export { Env, EMPTY_ENV };
export type { Value };

export function evaluate(expr: Expr, env: Env = EMPTY_ENV): EvalResult {
  return evalExpr(expr, env);
}

/** Convenience: build a record Value from a plain object. */
export function recordValue(obj: Record<string, Value>): Value {
  return { kind: "record", value: new Map(Object.entries(obj)) };
}
