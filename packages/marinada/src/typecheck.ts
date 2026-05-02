import type { Expr, Module, TypeDef } from "./types.ts";

// ---------------------------------------------------------------------------
// MType — Hindley-Milner monotypes plus a few non-HM extras carried through.
// ---------------------------------------------------------------------------

export type MType =
  | { kind: "var"; id: number }
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
  | { kind: "linear"; inner: MType }
  | { kind: "affine"; inner: MType }
  | { kind: "variant"; tag: string; fields: MType[] }
  | { kind: "named"; name: string }
  | { kind: "scheme"; quantified: number[]; body: MType };

// Singletons for atomic types
const UNKNOWN: MType = { kind: "unknown" };
const NULL_T: MType = { kind: "null" };
const BOOL: MType = { kind: "bool" };
const INT: MType = { kind: "int" };
const FLOAT: MType = { kind: "float" };
const STRING: MType = { kind: "string" };
const BYTES: MType = { kind: "bytes" };

// ---------------------------------------------------------------------------
// Substitution + fresh var supply
// ---------------------------------------------------------------------------

type Substitution = Map<number, MType>;

class State {
  readonly subst: Substitution = new Map();
  private nextId = 0;
  freshVar(): MType {
    return { kind: "var", id: this.nextId++ };
  }
  freshId(): number {
    return this.nextId++;
  }
}

/** Walk substitution chain. Returns the underlying type with var ids mapped. */
function find(t: MType, subst: Substitution): MType {
  let cur = t;
  while (cur.kind === "var") {
    const next = subst.get(cur.id);
    if (next === undefined) return cur;
    cur = next;
  }
  return cur;
}

/** Fully resolve type by substituting recursively. Pure; does not mutate. */
function zonk(t: MType, subst: Substitution): MType {
  const r = find(t, subst);
  switch (r.kind) {
    case "var":
    case "unknown":
    case "null":
    case "bool":
    case "int":
    case "float":
    case "string":
    case "bytes":
    case "named":
      return r;
    case "array":
      return { kind: "array", elem: zonk(r.elem, subst) };
    case "record": {
      const fields = new Map<string, MType>();
      for (const [k, v] of r.fields) fields.set(k, zonk(v, subst));
      return { kind: "record", fields };
    }
    case "fn":
      return {
        kind: "fn",
        params: r.params.map((p) => zonk(p, subst)),
        ret: zonk(r.ret, subst),
      };
    case "linear":
      return { kind: "linear", inner: zonk(r.inner, subst) };
    case "affine":
      return { kind: "affine", inner: zonk(r.inner, subst) };
    case "variant":
      return {
        kind: "variant",
        tag: r.tag,
        fields: r.fields.map((f) => zonk(f, subst)),
      };
    case "scheme":
      return { kind: "scheme", quantified: r.quantified, body: zonk(r.body, subst) };
  }
}

// ---------------------------------------------------------------------------
// Free type variables (after substitution)
// ---------------------------------------------------------------------------

function ftv(t: MType, subst: Substitution, out: Set<number>): void {
  const r = find(t, subst);
  switch (r.kind) {
    case "var":
      out.add(r.id);
      return;
    case "unknown":
    case "null":
    case "bool":
    case "int":
    case "float":
    case "string":
    case "bytes":
    case "named":
      return;
    case "array":
      ftv(r.elem, subst, out);
      return;
    case "record":
      for (const v of r.fields.values()) ftv(v, subst, out);
      return;
    case "fn":
      for (const p of r.params) ftv(p, subst, out);
      ftv(r.ret, subst, out);
      return;
    case "linear":
    case "affine":
      ftv(r.inner, subst, out);
      return;
    case "variant":
      for (const f of r.fields) ftv(f, subst, out);
      return;
    case "scheme": {
      const inner = new Set<number>();
      ftv(r.body, subst, inner);
      for (const q of r.quantified) inner.delete(q);
      for (const id of inner) out.add(id);
      return;
    }
  }
}

function ftvOfEnv(env: TypeEnv, subst: Substitution): Set<number> {
  const out = new Set<number>();
  for (const t of env.allBindings()) ftv(t, subst, out);
  return out;
}

// ---------------------------------------------------------------------------
// TypeEnv (stores schemes — mono types are degenerate schemes with no quantifiers)
// ---------------------------------------------------------------------------

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

  /** All bindings reachable via parent chain (for ftv computation). */
  *allBindings(): IterableIterator<MType> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let e: TypeEnv | null = this;
    while (e !== null) {
      for (const t of e.bindings.values()) yield t;
      e = e.parent;
    }
  }
}

export const EMPTY_TYPE_ENV = new TypeEnv();

// ---------------------------------------------------------------------------
// Errors / result
// ---------------------------------------------------------------------------

export type TypecheckError = {
  code: string;
  path: number[];
  message: string;
  expected?: string;
  got?: string;
  suggestion?: string;
};

export type TypecheckResult = { ok: true; type: MType } | { ok: false; errors: TypecheckError[] };

type Ctx = {
  errors: TypecheckError[];
  path: number[];
  state: State;
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
  const sub: Ctx = { errors: ctx.errors, path: [...ctx.path, idx], state: ctx.state };
  return fn(sub);
}

function at(arr: Expr[], i: number): Expr {
  return arr[i] as Expr;
}

// ---------------------------------------------------------------------------
// Type rendering
// ---------------------------------------------------------------------------

function typeName(t: MType): string {
  switch (t.kind) {
    case "var":
      return "t" + String(t.id);
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
    case "linear":
      return "linear " + typeName(t.inner);
    case "affine":
      return "affine " + typeName(t.inner);
    case "variant":
      return t.fields.length === 0 ? t.tag : t.tag + "(" + t.fields.map(typeName).join(", ") + ")";
    case "named":
      return t.name;
    case "scheme":
      return (
        "forall " + t.quantified.map((id) => "t" + String(id)).join(",") + ". " + typeName(t.body)
      );
  }
}

/**
 * Pretty-print a type for stable test assertions.
 *
 * Zonks the type via the resolution layer (callers pass already-zonked types
 * normally), then alpha-renames any remaining free type variables to a, b, c,
 * ... in left-to-right encounter order.
 */
export function prettyType(t: MType): string {
  const seen = new Map<number, string>();
  let nextChar = 0;
  function name(id: number): string {
    const existing = seen.get(id);
    if (existing !== undefined) return existing;
    // a..z, then a1, b1, ...
    const n = nextChar++;
    const letter = String.fromCharCode("a".charCodeAt(0) + (n % 26));
    const suffix = n >= 26 ? String(Math.floor(n / 26)) : "";
    const fresh = letter + suffix;
    seen.set(id, fresh);
    return fresh;
  }
  function go(t: MType): string {
    switch (t.kind) {
      case "var":
        return name(t.id);
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
        return "array<" + go(t.elem) + ">";
      case "record":
        return "record";
      case "fn":
        return "fn(" + t.params.map(go).join(", ") + ") -> " + go(t.ret);
      case "linear":
        return "linear " + go(t.inner);
      case "affine":
        return "affine " + go(t.inner);
      case "variant":
        return t.fields.length === 0 ? t.tag : t.tag + "(" + t.fields.map(go).join(", ") + ")";
      case "named":
        return t.name;
      case "scheme":
        return "forall " + t.quantified.map((id) => name(id)).join(",") + ". " + go(t.body);
    }
  }
  return go(t);
}

// ---------------------------------------------------------------------------
// Occurs check + unification
// ---------------------------------------------------------------------------

function occurs(id: number, t: MType, subst: Substitution): boolean {
  const r = find(t, subst);
  switch (r.kind) {
    case "var":
      return r.id === id;
    case "unknown":
    case "null":
    case "bool":
    case "int":
    case "float":
    case "string":
    case "bytes":
    case "named":
      return false;
    case "array":
      return occurs(id, r.elem, subst);
    case "record":
      for (const v of r.fields.values()) if (occurs(id, v, subst)) return true;
      return false;
    case "fn":
      for (const p of r.params) if (occurs(id, p, subst)) return true;
      return occurs(id, r.ret, subst);
    case "linear":
    case "affine":
      return occurs(id, r.inner, subst);
    case "variant":
      for (const f of r.fields) if (occurs(id, f, subst)) return true;
      return false;
    case "scheme":
      // schemes shouldn't appear inside monotypes during unification, but be safe
      return occurs(id, r.body, subst);
  }
}

type UnifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Unify two types eagerly. Mutates the substitution.
 *
 * Gradual typing: `unknown` consistent-unifies with anything silently. It does
 * NOT bind any vars and does NOT propagate — the other side keeps its shape.
 */
function unify(a: MType, b: MType, subst: Substitution): UnifyResult {
  const ra = find(a, subst);
  const rb = find(b, subst);

  // Consistent-unify with unknown — succeed silently, bind nothing.
  if (ra.kind === "unknown" || rb.kind === "unknown") return { ok: true };

  if (ra.kind === "var") {
    if (rb.kind === "var" && ra.id === rb.id) return { ok: true };
    if (occurs(ra.id, rb, subst)) {
      return { ok: false, reason: "occurs check failed" };
    }
    subst.set(ra.id, rb);
    return { ok: true };
  }
  if (rb.kind === "var") {
    if (occurs(rb.id, ra, subst)) {
      return { ok: false, reason: "occurs check failed" };
    }
    subst.set(rb.id, ra);
    return { ok: true };
  }

  if (ra.kind !== rb.kind) {
    return { ok: false, reason: typeName(ra) + " vs " + typeName(rb) };
  }

  switch (ra.kind) {
    case "null":
    case "bool":
    case "int":
    case "float":
    case "string":
    case "bytes":
      return { ok: true };
    case "named":
      if (ra.name === (rb as { kind: "named"; name: string }).name) return { ok: true };
      return { ok: false, reason: ra.name + " vs " + (rb as { name: string }).name };
    case "array":
      return unify(ra.elem, (rb as { kind: "array"; elem: MType }).elem, subst);
    case "fn": {
      const fb = rb as { kind: "fn"; params: MType[]; ret: MType };
      if (ra.params.length !== fb.params.length) {
        return {
          ok: false,
          reason: "arity " + String(ra.params.length) + " vs " + String(fb.params.length),
        };
      }
      for (let i = 0; i < ra.params.length; i++) {
        const r = unify(ra.params[i] as MType, fb.params[i] as MType, subst);
        if (!r.ok) return r;
      }
      return unify(ra.ret, fb.ret, subst);
    }
    case "record": {
      const rbR = rb as { kind: "record"; fields: Map<string, MType> };
      if (ra.fields.size !== rbR.fields.size) {
        return { ok: false, reason: "record field count differs" };
      }
      for (const [k, v] of ra.fields) {
        const bv = rbR.fields.get(k);
        if (bv === undefined) return { ok: false, reason: "missing field " + k };
        const r = unify(v, bv, subst);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case "linear":
      return unify(ra.inner, (rb as { kind: "linear"; inner: MType }).inner, subst);
    case "affine":
      return unify(ra.inner, (rb as { kind: "affine"; inner: MType }).inner, subst);
    case "variant": {
      const vb = rb as { kind: "variant"; tag: string; fields: MType[] };
      if (ra.tag !== vb.tag || ra.fields.length !== vb.fields.length) {
        return { ok: false, reason: "variant " + ra.tag + " vs " + vb.tag };
      }
      for (let i = 0; i < ra.fields.length; i++) {
        const r = unify(ra.fields[i] as MType, vb.fields[i] as MType, subst);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case "scheme":
      return { ok: false, reason: "cannot unify with scheme" };
  }
}

/**
 * Unify and emit an error if it fails. Returns whether unification succeeded.
 */
function unifyOrError(ctx: Ctx, expected: MType, got: MType, message: string): boolean {
  const r = unify(expected, got, ctx.state.subst);
  if (r.ok) return true;
  const ze = zonk(expected, ctx.state.subst);
  const zg = zonk(got, ctx.state.subst);
  addError(ctx, "TYPE_MISMATCH", message + ": " + r.reason, {
    expected: typeName(ze),
    got: typeName(zg),
  });
  return false;
}

// ---------------------------------------------------------------------------
// Generalization + instantiation
// ---------------------------------------------------------------------------

/**
 * Generalize: quantify over free vars in `t` that are NOT free in the env.
 */
function generalize(t: MType, env: TypeEnv, subst: Substitution): MType {
  const tVars = new Set<number>();
  ftv(t, subst, tVars);
  if (tVars.size === 0) return t;
  const envVars = ftvOfEnv(env, subst);
  const quantified: number[] = [];
  for (const id of tVars) if (!envVars.has(id)) quantified.push(id);
  if (quantified.length === 0) return t;
  return { kind: "scheme", quantified, body: zonk(t, subst) };
}

/**
 * Instantiate a scheme with fresh type vars. Non-schemes pass through unchanged.
 */
function instantiate(t: MType, state: State): MType {
  const r = t.kind === "scheme" ? t : null;
  if (r === null) return t;
  const mapping = new Map<number, MType>();
  for (const id of r.quantified) mapping.set(id, state.freshVar());
  return substVars(r.body, mapping);
}

/** Substitute a mapping of var-id → MType through a type. Used by instantiate. */
function substVars(t: MType, mapping: Map<number, MType>): MType {
  switch (t.kind) {
    case "var": {
      const m = mapping.get(t.id);
      return m ?? t;
    }
    case "unknown":
    case "null":
    case "bool":
    case "int":
    case "float":
    case "string":
    case "bytes":
    case "named":
      return t;
    case "array":
      return { kind: "array", elem: substVars(t.elem, mapping) };
    case "record": {
      const fields = new Map<string, MType>();
      for (const [k, v] of t.fields) fields.set(k, substVars(v, mapping));
      return { kind: "record", fields };
    }
    case "fn":
      return {
        kind: "fn",
        params: t.params.map((p) => substVars(p, mapping)),
        ret: substVars(t.ret, mapping),
      };
    case "linear":
      return { kind: "linear", inner: substVars(t.inner, mapping) };
    case "affine":
      return { kind: "affine", inner: substVars(t.inner, mapping) };
    case "variant":
      return {
        kind: "variant",
        tag: t.tag,
        fields: t.fields.map((f) => substVars(f, mapping)),
      };
    case "scheme": {
      // shadow quantified vars
      const innerMap = new Map(mapping);
      for (const q of t.quantified) innerMap.delete(q);
      return { kind: "scheme", quantified: t.quantified, body: substVars(t.body, innerMap) };
    }
  }
}

// ---------------------------------------------------------------------------
// Type annotation parsing (very small grammar — Phase 1)
// ---------------------------------------------------------------------------

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
    case "string":
      return STRING;
    case "bytes":
      return BYTES;
    case "unknown":
      return UNKNOWN;
    default:
      // Phase 1: unrecognized annotations fall back to unknown
      return UNKNOWN;
  }
}

function isUpperCase(s: string): boolean {
  return s.length > 0 && (s[0] as string) >= "A" && (s[0] as string) <= "Z";
}

// ---------------------------------------------------------------------------
// Helpers for emitting NOT_YET_IMPLEMENTED
// ---------------------------------------------------------------------------

function notYetImplemented(ctx: Ctx, op: string): MType {
  addError(ctx, "NOT_YET_IMPLEMENTED", "op not yet implemented in Phase 1: " + op);
  return ctx.state.freshVar();
}

// ---------------------------------------------------------------------------
// Op signature helpers
// ---------------------------------------------------------------------------

function expectArity(ctx: Ctx, op: string, arr: Expr[], n: number): boolean {
  if (arr.length !== n + 1) {
    addError(
      ctx,
      "ARITY_ERROR",
      op + " requires " + String(n) + " args, got " + String(arr.length - 1),
    );
    return false;
  }
  return true;
}

function expectArityRange(ctx: Ctx, op: string, arr: Expr[], min: number, max: number): boolean {
  const got = arr.length - 1;
  if (got < min || got > max) {
    addError(
      ctx,
      "ARITY_ERROR",
      op + " requires " + String(min) + "-" + String(max) + " args, got " + String(got),
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Inference (Algorithm W)
// ---------------------------------------------------------------------------

function infer(expr: Expr, env: TypeEnv, ctx: Ctx): MType {
  // Atoms
  if (expr === null) return NULL_T;
  if (typeof expr === "boolean") return BOOL;
  if (typeof expr === "number") return Number.isInteger(expr) ? INT : FLOAT;
  if (typeof expr === "string") {
    const t = env.lookup(expr);
    if (t === undefined) {
      addError(ctx, "UNDEFINED_VAR", "undefined variable: " + expr);
      return ctx.state.freshVar();
    }
    return instantiate(t, ctx.state);
  }

  const arr = expr as Expr[];
  if (arr.length === 0) {
    addError(ctx, "UNKNOWN_OP", "empty expression array");
    return ctx.state.freshVar();
  }

  const opExpr = arr[0];
  if (typeof opExpr !== "string") {
    addError(ctx, "UNKNOWN_OP", "first element of call must be an op name (string)");
    return ctx.state.freshVar();
  }
  const op = opExpr;

  // Variant constructor (uppercase tag) — Phase 2 territory; check args, return fresh var.
  if (isUpperCase(op)) {
    for (let i = 1; i < arr.length; i++) {
      withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
    }
    return notYetImplemented(ctx, op);
  }

  return inferOp(op, arr, env, ctx);
}

function inferOp(op: string, arr: Expr[], env: TypeEnv, ctx: Ctx): MType {
  const state = ctx.state;
  const subst = state.subst;

  switch (op) {
    // -------------------- bytes literal --------------------
    case "bytes": {
      // Phase 1: ["bytes", ...args] is a bytes literal. Args (if any) are not type-checked deeply.
      return BYTES;
    }

    // -------------------- control flow --------------------
    case "if": {
      if (!expectArity(ctx, "if", arr, 3)) return state.freshVar();
      const condT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, BOOL, condT, "if condition must be bool"));
      const thenT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elseT = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      const result = state.freshVar();
      withPath(ctx, 2, (sub) => unifyOrError(sub, result, thenT, "if then-branch"));
      withPath(ctx, 3, (sub) => unifyOrError(sub, result, elseT, "if else-branch"));
      return result;
    }

    case "cond": {
      if (arr.length < 2) {
        addError(ctx, "ARITY_ERROR", "cond requires at least 1 clause");
        return state.freshVar();
      }
      const result = state.freshVar();
      let sawAny = false;
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
        if (test !== "else") {
          const testT = withPath(ctx, i, (sub) =>
            withPath(sub, 0, (sub2) => infer(test as Expr, env, sub2)),
          );
          withPath(ctx, i, (sub) =>
            withPath(sub, 0, (sub2) => unifyOrError(sub2, BOOL, testT, "cond test must be bool")),
          );
        }
        const branchT = withPath(ctx, i, (sub) =>
          withPath(sub, 1, (sub2) => infer(body, env, sub2)),
        );
        withPath(ctx, i, (sub) =>
          withPath(sub, 1, (sub2) => unifyOrError(sub2, result, branchT, "cond branch")),
        );
        sawAny = true;
      }
      if (!sawAny) return state.freshVar();
      return result;
    }

    case "do": {
      if (arr.length < 2) {
        addError(ctx, "ARITY_ERROR", "do requires at least 1 expr");
        return state.freshVar();
      }
      let last: MType = state.freshVar();
      for (let i = 1; i < arr.length; i++) {
        last = withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
      }
      return last;
    }

    // -------------------- let / letrec --------------------
    case "let": {
      if (!expectArity(ctx, "let", arr, 2)) return state.freshVar();
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        withPath(ctx, 1, (sub) => addError(sub, "TYPE_MISMATCH", "let bindings must be an array"));
        return state.freshVar();
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
          withPath(sub, i, (sub2) => infer(binding[1] as Expr, currentEnv, sub2)),
        );
        const generalized = generalize(valT, currentEnv, subst);
        currentEnv = currentEnv.extend({ [name]: generalized });
      }
      return withPath(ctx, 2, (sub) => infer(at(arr, 2), currentEnv, sub));
    }

    case "letrec": {
      if (!expectArity(ctx, "letrec", arr, 2)) return state.freshVar();
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "letrec bindings must be an array"),
        );
        return state.freshVar();
      }
      // 1) Pre-bind every name to a fresh type var.
      const placeholders: Record<string, MType> = {};
      const names: string[] = [];
      const vars: MType[] = [];
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) continue;
        const name = binding[0];
        if (typeof name !== "string") continue;
        const v = state.freshVar();
        placeholders[name] = v;
        names.push(name);
        vars.push(v);
      }
      const recEnv = env.extend(placeholders);
      // 2) Infer each body and unify with its placeholder.
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) continue;
        const name = binding[0];
        if (typeof name !== "string") continue;
        const idx = names.indexOf(name);
        const bodyT = withPath(ctx, 1, (sub) =>
          withPath(sub, i, (sub2) => infer(binding[1] as Expr, recEnv, sub2)),
        );
        withPath(ctx, 1, (sub) =>
          withPath(sub, i, (sub2) =>
            unifyOrError(sub2, vars[idx] as MType, bodyT, "letrec binding " + name),
          ),
        );
      }
      // 3) Generalize all bindings together against the OUTER env.
      const finalEnv = env.extend(
        Object.fromEntries(
          names.map((n, i) => [n, generalize(vars[i] as MType, env, subst)] as const),
        ),
      );
      return withPath(ctx, 2, (sub) => infer(at(arr, 2), finalEnv, sub));
    }

    // -------------------- functions --------------------
    case "fn": {
      if (!expectArity(ctx, "fn", arr, 2)) {
        return { kind: "fn", params: [], ret: state.freshVar() };
      }
      const paramsExpr = arr[1];
      if (!Array.isArray(paramsExpr)) {
        withPath(ctx, 1, (sub) => addError(sub, "TYPE_MISMATCH", "fn params must be an array"));
        return { kind: "fn", params: [], ret: state.freshVar() };
      }
      const paramTypes: MType[] = [];
      const paramBindings: Record<string, MType> = {};
      for (let i = 0; i < paramsExpr.length; i++) {
        const p = paramsExpr[i];
        if (typeof p === "string") {
          const v = state.freshVar();
          paramTypes.push(v);
          paramBindings[p] = v;
        } else if (Array.isArray(p) && p.length >= 2 && typeof p[0] === "string") {
          const annotated = parseTypeAnnotation(p[1] as string);
          paramTypes.push(annotated);
          paramBindings[p[0] as string] = annotated;
        } else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") {
          const v = state.freshVar();
          paramTypes.push(v);
          paramBindings[p[0] as string] = v;
        } else {
          withPath(ctx, 1, (sub) =>
            withPath(sub, i, (sub2) =>
              addError(sub2, "TYPE_MISMATCH", "fn param must be a string or [name, type] pair"),
            ),
          );
          paramTypes.push(state.freshVar());
        }
      }
      const fnEnv = env.extend(paramBindings);
      const retT = withPath(ctx, 2, (sub) => infer(at(arr, 2), fnEnv, sub));
      return { kind: "fn", params: paramTypes, ret: retT };
    }

    case "call": {
      if (arr.length < 2) {
        addError(ctx, "ARITY_ERROR", "call requires at least 1 arg");
        return state.freshVar();
      }
      const fnT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const argTypes: MType[] = [];
      for (let i = 2; i < arr.length; i++) {
        argTypes.push(withPath(ctx, i, (sub) => infer(at(arr, i), env, sub)));
      }
      const ret = state.freshVar();
      const expected: MType = { kind: "fn", params: argTypes, ret };
      // If the resolved fn is a known fn type, check arity explicitly so we get
      // ARITY_ERROR (not TYPE_MISMATCH) when arities differ.
      const resolved = find(fnT, subst);
      if (resolved.kind === "fn" && resolved.params.length !== argTypes.length) {
        addError(
          ctx,
          "ARITY_ERROR",
          "fn expects " + String(resolved.params.length) + " args, got " + String(argTypes.length),
        );
        return resolved.ret;
      }
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, expected, fnT, "call: function/argument mismatch"),
      );
      return ret;
    }

    // -------------------- logic --------------------
    case "and":
    case "or": {
      if (!expectArity(ctx, op, arr, 2)) return BOOL;
      const ta = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const tb = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, BOOL, ta, op + " requires bool"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, BOOL, tb, op + " requires bool"));
      return BOOL;
    }

    case "not": {
      if (!expectArity(ctx, "not", arr, 1)) return BOOL;
      const ta = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, BOOL, ta, "not requires bool"));
      return BOOL;
    }

    // -------------------- comparison --------------------
    case "==":
    case "!=": {
      if (!expectArity(ctx, op, arr, 2)) return BOOL;
      const ta = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const tb = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      // Both sides must have the same type, but any type.
      withPath(ctx, 2, (sub) => unifyOrError(sub, ta, tb, op + " requires same-typed operands"));
      return BOOL;
    }

    case "<":
    case "<=":
    case ">":
    case ">=": {
      if (!expectArity(ctx, op, arr, 2)) return BOOL;
      const ta = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const tb = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      // Numeric: must unify with same numeric type (no widening).
      // Allow either int or float; both sides must agree.
      withPath(ctx, 2, (sub) => unifyOrError(sub, ta, tb, op + " requires matching numeric types"));
      // ta must be numeric (int or float). We can't enforce via unification of
      // a sum type, but we can require the resolved type to be int/float/var/unknown.
      const rta = find(ta, subst);
      if (
        rta.kind !== "int" &&
        rta.kind !== "float" &&
        rta.kind !== "var" &&
        rta.kind !== "unknown"
      ) {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " requires number, got " + typeName(rta), {
            expected: "int | float",
            got: typeName(rta),
          }),
        );
      }
      return BOOL;
    }

    // -------------------- arithmetic --------------------
    case "+":
    case "-":
    case "*":
    case "/":
    case "%":
    case "**": {
      // Unary minus is handled with one arg.
      if (op === "-" && arr.length === 2) {
        const ta = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
        const rta = find(ta, subst);
        if (
          rta.kind === "int" ||
          rta.kind === "float" ||
          rta.kind === "var" ||
          rta.kind === "unknown"
        ) {
          return ta;
        }
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "unary - requires number, got " + typeName(rta), {
            expected: "int | float",
            got: typeName(rta),
          }),
        );
        return state.freshVar();
      }
      if (!expectArity(ctx, op, arr, 2)) return state.freshVar();
      const ta = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const tb = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      // Both operands must be the same numeric type (no widening).
      withPath(ctx, 2, (sub) => unifyOrError(sub, ta, tb, op + " requires matching numeric types"));
      // Check resolved type is numeric.
      const rta = find(ta, subst);
      const rtb = find(tb, subst);
      const aOk =
        rta.kind === "int" || rta.kind === "float" || rta.kind === "var" || rta.kind === "unknown";
      const bOk =
        rtb.kind === "int" || rtb.kind === "float" || rtb.kind === "var" || rtb.kind === "unknown";
      if (!aOk) {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " requires number, got " + typeName(rta), {
            expected: "int | float",
            got: typeName(rta),
          }),
        );
      }
      if (!bOk) {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " requires number, got " + typeName(rtb), {
            expected: "int | float",
            got: typeName(rtb),
          }),
        );
      }
      // Prefer the more concrete side: if one operand is unknown, return the other.
      if (rta.kind === "unknown") return tb;
      return ta;
    }

    // -------------------- type ops --------------------
    case "as": {
      if (!expectArity(ctx, "as", arr, 2)) return state.freshVar();
      const typStr = arr[1];
      if (typeof typStr !== "string") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "as requires a type name string as first arg"),
        );
        return state.freshVar();
      }
      withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      return parseTypeAnnotation(typStr);
    }

    case "is": {
      if (!expectArity(ctx, "is", arr, 2)) return BOOL;
      withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      return BOOL;
    }

    case "untyped": {
      if (arr.length !== 2) {
        addError(ctx, "ARITY_ERROR", "untyped requires 1 arg");
      }
      // Skip type-checking the inner expr entirely.
      return UNKNOWN;
    }

    // -------------------- string ops --------------------
    case "str-len": {
      if (!expectArity(ctx, "str-len", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, t, "str-len requires string"));
      return INT;
    }
    case "str-concat": {
      if (!expectArity(ctx, "str-concat", arr, 2)) return STRING;
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const b = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, a, "str-concat requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, b, "str-concat requires string"));
      return STRING;
    }
    case "str-slice": {
      if (!expectArity(ctx, "str-slice", arr, 3)) return STRING;
      const s = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const a = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const b = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, s, "str-slice requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, INT, a, "str-slice index must be int"));
      withPath(ctx, 3, (sub) => unifyOrError(sub, INT, b, "str-slice index must be int"));
      return STRING;
    }
    case "str-index": {
      if (!expectArity(ctx, "str-index", arr, 2)) return INT;
      const s = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const sub2T = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, s, "str-index requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, sub2T, "str-index requires string"));
      return INT;
    }
    case "str-contains":
    case "str-starts-with":
    case "str-ends-with": {
      if (!expectArity(ctx, op, arr, 2)) return BOOL;
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const b = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, a, op + " requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, b, op + " requires string"));
      return BOOL;
    }
    case "str-upper":
    case "str-lower":
    case "str-trim": {
      if (!expectArity(ctx, op, arr, 1)) return STRING;
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, a, op + " requires string"));
      return STRING;
    }
    case "str-split": {
      if (!expectArity(ctx, "str-split", arr, 2)) return { kind: "array", elem: STRING };
      const s = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const sep = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, s, "str-split requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, sep, "str-split requires string"));
      return { kind: "array", elem: STRING };
    }
    case "str-replace": {
      if (!expectArity(ctx, "str-replace", arr, 3)) return STRING;
      const s = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const a = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const b = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, s, "str-replace requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, a, "str-replace requires string"));
      withPath(ctx, 3, (sub) => unifyOrError(sub, STRING, b, "str-replace requires string"));
      return STRING;
    }

    // -------------------- array ops --------------------
    case "array": {
      const elem = state.freshVar();
      for (let i = 1; i < arr.length; i++) {
        const t = withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
        withPath(ctx, i, (sub) => unifyOrError(sub, elem, t, "array elements must share a type"));
      }
      return { kind: "array", elem };
    }
    case "array-len": {
      if (!expectArity(ctx, "array-len", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, t, "array-len requires array"),
      );
      return INT;
    }
    case "array-get": {
      if (!expectArity(ctx, "array-get", arr, 2)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const i = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, t, "array-get requires array"),
      );
      withPath(ctx, 2, (sub) => unifyOrError(sub, INT, i, "array-get index must be int"));
      return elem;
    }
    case "array-push": {
      if (!expectArity(ctx, "array-push", arr, 2)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const elemT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, t, "array-push requires array"),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, elem, elemT, "array-push: element type mismatch"),
      );
      return { kind: "array", elem };
    }
    case "array-pop": {
      if (!expectArity(ctx, "array-pop", arr, 1)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, t, "array-pop requires array"),
      );
      return { kind: "array", elem };
    }
    case "array-slice": {
      if (!expectArityRange(ctx, "array-slice", arr, 2, 3)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const a = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, t, "array-slice requires array"),
      );
      withPath(ctx, 2, (sub) => unifyOrError(sub, INT, a, "array-slice index must be int"));
      if (arr.length === 4) {
        const b = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
        withPath(ctx, 3, (sub) => unifyOrError(sub, INT, b, "array-slice index must be int"));
      }
      return { kind: "array", elem };
    }
    case "array-concat": {
      if (!expectArity(ctx, "array-concat", arr, 2)) return state.freshVar();
      const t1 = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const t2 = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      const arrT: MType = { kind: "array", elem };
      withPath(ctx, 1, (sub) => unifyOrError(sub, arrT, t1, "array-concat requires array"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, arrT, t2, "array-concat requires array"));
      return arrT;
    }
    case "array-map": {
      if (!expectArity(ctx, "array-map", arr, 2)) return state.freshVar();
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const aT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const inElem = state.freshVar();
      const outElem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(
          sub,
          { kind: "fn", params: [inElem], ret: outElem },
          fT,
          "array-map: expected fn",
        ),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, { kind: "array", elem: inElem }, aT, "array-map: expected array"),
      );
      return { kind: "array", elem: outElem };
    }
    case "array-filter": {
      if (!expectArity(ctx, "array-filter", arr, 2)) return state.freshVar();
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const aT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(
          sub,
          { kind: "fn", params: [elem], ret: BOOL },
          fT,
          "array-filter: expected fn(_) -> bool",
        ),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, aT, "array-filter: expected array"),
      );
      return { kind: "array", elem };
    }
    case "array-reduce": {
      if (!expectArity(ctx, "array-reduce", arr, 3)) return state.freshVar();
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const initT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const aT = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      const acc = state.freshVar();
      const elem = state.freshVar();
      withPath(ctx, 2, (sub) => unifyOrError(sub, acc, initT, "array-reduce init type"));
      withPath(ctx, 1, (sub) =>
        unifyOrError(
          sub,
          { kind: "fn", params: [acc, elem], ret: acc },
          fT,
          "array-reduce: expected fn(acc, elem) -> acc",
        ),
      );
      withPath(ctx, 3, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, aT, "array-reduce: expected array"),
      );
      return acc;
    }
    case "array-find": {
      if (!expectArity(ctx, "array-find", arr, 2)) return state.freshVar();
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const aT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(
          sub,
          { kind: "fn", params: [elem], ret: BOOL },
          fT,
          "array-find: expected fn(_) -> bool",
        ),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, aT, "array-find: expected array"),
      );
      // Phase 1: returns elem (Option<T> is a Phase 2 concern).
      return elem;
    }
    case "array-index-of": {
      if (!expectArity(ctx, "array-index-of", arr, 2)) return INT;
      const aT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const eT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, aT, "array-index-of: expected array"),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, elem, eT, "array-index-of: element type mismatch"),
      );
      return INT;
    }
    case "array-includes": {
      if (!expectArity(ctx, "array-includes", arr, 2)) return BOOL;
      const aT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const eT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, aT, "array-includes: expected array"),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, elem, eT, "array-includes: element type mismatch"),
      );
      return BOOL;
    }
    case "array-every":
    case "array-some": {
      if (!expectArity(ctx, op, arr, 2)) return BOOL;
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const aT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(
          sub,
          { kind: "fn", params: [elem], ret: BOOL },
          fT,
          op + ": expected fn(_) -> bool",
        ),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, aT, op + ": expected array"),
      );
      return BOOL;
    }
    case "array-flat-map": {
      if (!expectArity(ctx, "array-flat-map", arr, 2)) return state.freshVar();
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const aT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const inElem = state.freshVar();
      const outElem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(
          sub,
          { kind: "fn", params: [inElem], ret: { kind: "array", elem: outElem } },
          fT,
          "array-flat-map: expected fn(_) -> array",
        ),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, { kind: "array", elem: inElem }, aT, "array-flat-map: expected array"),
      );
      return { kind: "array", elem: outElem };
    }
    case "array-reverse": {
      if (!expectArity(ctx, "array-reverse", arr, 1)) return state.freshVar();
      const aT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const elem = state.freshVar();
      const arrT: MType = { kind: "array", elem };
      withPath(ctx, 1, (sub) => unifyOrError(sub, arrT, aT, "array-reverse: expected array"));
      return arrT;
    }
    case "array-sort": {
      if (!expectArityRange(ctx, "array-sort", arr, 1, 2)) return state.freshVar();
      const aT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const elem = state.freshVar();
      const arrT: MType = { kind: "array", elem };
      withPath(ctx, 1, (sub) => unifyOrError(sub, arrT, aT, "array-sort: expected array"));
      if (arr.length === 3) {
        const fT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
        withPath(ctx, 2, (sub) =>
          unifyOrError(
            sub,
            { kind: "fn", params: [elem, elem], ret: INT },
            fT,
            "array-sort: comparator must be fn(a,b) -> int",
          ),
        );
      }
      return arrT;
    }

    // -------------------- math ops --------------------
    case "floor":
    case "ceil":
    case "round": {
      if (!expectArity(ctx, op, arr, 1)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const r = find(t, subst);
      if (r.kind !== "int" && r.kind !== "float" && r.kind !== "var" && r.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " requires number, got " + typeName(r), {
            expected: "int | float",
            got: typeName(r),
          }),
        );
        return state.freshVar();
      }
      // floor/ceil/round of int = int, of float = int.
      if (r.kind === "int") return INT;
      if (r.kind === "float") return INT;
      // var/unknown: return INT (these ops produce int in standard semantics).
      return INT;
    }
    case "abs": {
      if (!expectArity(ctx, "abs", arr, 1)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const r = find(t, subst);
      if (r.kind !== "int" && r.kind !== "float" && r.kind !== "var" && r.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "abs requires number, got " + typeName(r), {
            expected: "int | float",
            got: typeName(r),
          }),
        );
        return state.freshVar();
      }
      return t;
    }
    case "sign": {
      if (!expectArity(ctx, "sign", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const r = find(t, subst);
      if (r.kind !== "int" && r.kind !== "float" && r.kind !== "var" && r.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "sign requires number, got " + typeName(r), {
            expected: "int | float",
            got: typeName(r),
          }),
        );
      }
      return INT;
    }
    case "sqrt":
    case "exp":
    case "log":
    case "log2":
    case "log10": {
      if (!expectArity(ctx, op, arr, 1)) return FLOAT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, FLOAT, t, op + " requires float"));
      return FLOAT;
    }
    case "pow": {
      if (!expectArity(ctx, "pow", arr, 2)) return FLOAT;
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const b = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, FLOAT, a, "pow requires float"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, FLOAT, b, "pow requires float"));
      return FLOAT;
    }
    case "min":
    case "max": {
      if (!expectArity(ctx, op, arr, 2)) return state.freshVar();
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const b = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 2, (sub) => unifyOrError(sub, a, b, op + " requires matching numeric types"));
      const ra = find(a, subst);
      if (ra.kind !== "int" && ra.kind !== "float" && ra.kind !== "var" && ra.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " requires number, got " + typeName(ra), {
            expected: "int | float",
            got: typeName(ra),
          }),
        );
      }
      return a;
    }
    case "clamp": {
      if (!expectArity(ctx, "clamp", arr, 3)) return state.freshVar();
      const x = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const lo = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const hi = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      withPath(ctx, 2, (sub) => unifyOrError(sub, x, lo, "clamp: type mismatch"));
      withPath(ctx, 3, (sub) => unifyOrError(sub, x, hi, "clamp: type mismatch"));
      const r = find(x, subst);
      if (r.kind !== "int" && r.kind !== "float" && r.kind !== "var" && r.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "clamp requires number, got " + typeName(r), {
            expected: "int | float",
            got: typeName(r),
          }),
        );
      }
      return x;
    }

    // -------------------- conversion ops --------------------
    case "count": {
      if (!expectArity(ctx, "count", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      // Accept array<_>; record support deferred to Phase 2.
      const r = find(t, subst);
      if (r.kind === "array" || r.kind === "var" || r.kind === "unknown") {
        return INT;
      }
      withPath(ctx, 1, (sub) =>
        addError(sub, "TYPE_MISMATCH", "count requires array, got " + typeName(r), {
          expected: "array",
          got: typeName(r),
        }),
      );
      return INT;
    }
    case "type-of": {
      if (!expectArity(ctx, "type-of", arr, 1)) return STRING;
      withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      return STRING;
    }
    case "to-string": {
      if (!expectArity(ctx, "to-string", arr, 1)) return STRING;
      withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      return STRING;
    }
    case "to-int": {
      if (!expectArity(ctx, "to-int", arr, 1)) return INT;
      withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      return INT;
    }
    case "to-float": {
      if (!expectArity(ctx, "to-float", arr, 1)) return FLOAT;
      withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      return FLOAT;
    }
    case "parse-int": {
      if (!expectArity(ctx, "parse-int", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, t, "parse-int requires string"));
      return INT;
    }
    case "parse-float": {
      if (!expectArity(ctx, "parse-float", arr, 1)) return FLOAT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, t, "parse-float requires string"));
      return FLOAT;
    }

    // -------------------- bitwise ops --------------------
    case "bit-and":
    case "bit-or":
    case "bit-xor":
    case "bit-shl":
    case "bit-shr":
    case "bit-ushr": {
      if (!expectArity(ctx, op, arr, 2)) return INT;
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const b = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, INT, a, op + " requires int"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, INT, b, op + " requires int"));
      return INT;
    }
    case "bit-not": {
      if (!expectArity(ctx, "bit-not", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, INT, t, "bit-not requires int"));
      return INT;
    }

    // -------------------- Phase 2+ ops --------------------
    case "get":
    case "get-in":
    case "set":
    case "set-in":
    case "merge":
    case "keys":
    case "vals":
    case "record-get":
    case "record-set":
    case "record-del":
    case "record-keys":
    case "record-vals":
    case "record-merge":
    case "match":
    case "perform":
    case "handle":
    case "call.method":
    case "?":
    case "map":
    case "filter":
    case "reduce":
    case "concat":
    case "slice":
    case "str-get":
    case "str-cmp":
    case "parse-number":
    case "int->float":
    case "float->int": {
      // Still type-check sub-exprs to collect useful errors, but flag this op as not-yet-impl.
      for (let i = 1; i < arr.length; i++) {
        withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
      }
      return notYetImplemented(ctx, op);
    }

    default: {
      addError(ctx, "UNKNOWN_OP", "unknown op: " + op);
      return ctx.state.freshVar();
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function typecheck(expr: Expr, env?: TypeEnv): TypecheckResult {
  const state = new State();
  const ctx: Ctx = { errors: [], path: [], state };
  const t = infer(expr, env ?? EMPTY_TYPE_ENV, ctx);
  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }
  return { ok: true, type: zonk(t, state.subst) };
}

// ---------------------------------------------------------------------------
// Module typechecking (Phase 1: minimal — main expression with import stubs).
// ---------------------------------------------------------------------------

const STD_TYPE_BINDINGS: Record<string, MType> = {
  // Phase 2 will replace these with proper polymorphic schemes.
  None: { kind: "variant", tag: "None", fields: [] },
  Some: { kind: "variant", tag: "Some", fields: [UNKNOWN] },
  Ok: { kind: "variant", tag: "Ok", fields: [UNKNOWN] },
  Err: { kind: "variant", tag: "Err", fields: [UNKNOWN] },
};

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

function resolveImportBindings(imports: Module["imports"]): Record<string, MType> {
  const bindings: Record<string, MType> = {};
  for (const imp of imports ?? []) {
    if (imp.from === "lib:std") {
      for (const name of imp.import) {
        const t = STD_TYPE_BINDINGS[name];
        bindings[name] = t ?? UNKNOWN;
      }
    } else {
      for (const name of imp.import) {
        bindings[name] = UNKNOWN;
      }
    }
  }
  return bindings;
}

export function typecheckModule(module: Module): TypecheckResult {
  const state = new State();
  const ctx: Ctx = { errors: [], path: [], state };
  const importBindings = resolveImportBindings(module.imports);
  const typeDefBindings = typeDefsToBindings(module.types ?? []);
  const moduleEnv = EMPTY_TYPE_ENV.extend({ ...importBindings, ...typeDefBindings });
  const t = infer(module.main, moduleEnv, ctx);
  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }
  return { ok: true, type: zonk(t, state.subst) };
}
