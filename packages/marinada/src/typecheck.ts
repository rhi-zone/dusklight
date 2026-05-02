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
  | { kind: "row"; fields: Map<string, MType>; rest: number | "empty" }
  | { kind: "record"; row: MType }
  | { kind: "fn"; params: MType[]; ret: MType }
  | { kind: "linear"; inner: MType }
  | { kind: "affine"; inner: MType }
  | { kind: "variant"; tag: string; fields: MType[] }
  | { kind: "named"; name: string; args: MType[] }
  | { kind: "scheme"; quantified: number[]; body: MType };

// ---------------------------------------------------------------------------
// Type definitions (DUs)
// ---------------------------------------------------------------------------

/**
 * A type definition: a parameterised DU. Variants map tag → list of field types,
 * where any free type vars in those types come from `params` (one fresh var
 * is allocated per param at instantiation time).
 */
export type TypeDefInfo = {
  /** Type parameter names, in order. */
  params: string[];
  /** Variants. Each variant has a list of field types referencing params. */
  variants: Map<string, MType[]>;
};

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

/** Resolve a row's tail through the substitution. Used when iterating row fields. */
function resolveRow(t: MType, subst: Substitution): MType {
  let cur = find(t, subst);
  while (cur.kind === "row" && typeof cur.rest === "number") {
    const next = subst.get(cur.rest);
    if (next === undefined) return cur;
    const nextR = find(next, subst);
    if (nextR.kind !== "row") {
      // tail bound to a non-row (e.g. another var) — leave as is
      return cur;
    }
    // Merge: combine fields with tail's fields. Local wins in case of duplicates
    // (caller must ensure no duplicates via row unification).
    const merged = new Map<string, MType>(nextR.fields);
    for (const [k, v] of cur.fields) merged.set(k, v);
    cur = { kind: "row", fields: merged, rest: nextR.rest };
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
      return r;
    case "named":
      return {
        kind: "named",
        name: r.name,
        args: r.args.map((a) => zonk(a, subst)),
      };
    case "array":
      return { kind: "array", elem: zonk(r.elem, subst) };
    case "row": {
      const flat = resolveRow(r, subst);
      if (flat.kind !== "row") return zonk(flat, subst);
      const fields = new Map<string, MType>();
      for (const [k, v] of flat.fields) fields.set(k, zonk(v, subst));
      return { kind: "row", fields, rest: flat.rest };
    }
    case "record":
      return { kind: "record", row: zonk(r.row, subst) };
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
      return {
        kind: "scheme",
        quantified: r.quantified,
        body: zonk(r.body, subst),
      };
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
      return;
    case "named":
      for (const a of r.args) ftv(a, subst, out);
      return;
    case "array":
      ftv(r.elem, subst, out);
      return;
    case "row": {
      const flat = resolveRow(r, subst);
      if (flat.kind !== "row") {
        ftv(flat, subst, out);
        return;
      }
      for (const v of flat.fields.values()) ftv(v, subst, out);
      if (typeof flat.rest === "number") {
        // The tail var, if unbound, is free.
        const tailVar: MType = { kind: "var", id: flat.rest };
        const tr = find(tailVar, subst);
        if (tr.kind === "var") out.add(tr.id);
        else ftv(tr, subst, out);
      }
      return;
    }
    case "record":
      ftv(r.row, subst, out);
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
// TypeEnv
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
  /** Type definition table — keyed by type name (e.g. "option", "Shape"). */
  typeDefs: Map<string, TypeDefInfo>;
  /** Constructor index: tag → declaring type name. */
  ctors: Map<string, string>;
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
  const sub: Ctx = {
    errors: ctx.errors,
    path: [...ctx.path, idx],
    state: ctx.state,
    typeDefs: ctx.typeDefs,
    ctors: ctx.ctors,
  };
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
    case "row": {
      const parts: string[] = [];
      for (const [k, v] of t.fields) parts.push(k + ": " + typeName(v));
      if (typeof t.rest === "number") parts.push("...r" + String(t.rest));
      return "{" + parts.join(", ") + "}";
    }
    case "record":
      return "record" + typeName(t.row);
    case "fn":
      return "fn(" + t.params.map(typeName).join(", ") + ") -> " + typeName(t.ret);
    case "linear":
      return "linear " + typeName(t.inner);
    case "affine":
      return "affine " + typeName(t.inner);
    case "variant":
      return t.fields.length === 0 ? t.tag : t.tag + "(" + t.fields.map(typeName).join(", ") + ")";
    case "named":
      return t.args.length === 0 ? t.name : t.name + "<" + t.args.map(typeName).join(", ") + ">";
    case "scheme":
      return (
        "forall " + t.quantified.map((id) => "t" + String(id)).join(",") + ". " + typeName(t.body)
      );
  }
}

/** Pretty-print a type for stable test assertions. */
export function prettyType(t: MType): string {
  const seen = new Map<number, string>();
  let nextChar = 0;
  function name(id: number): string {
    const existing = seen.get(id);
    if (existing !== undefined) return existing;
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
      case "row": {
        const parts: string[] = [];
        const sortedKeys = [...t.fields.keys()].sort();
        for (const k of sortedKeys) parts.push(k + ": " + go(t.fields.get(k) as MType));
        if (typeof t.rest === "number") {
          return "{" + parts.join(", ") + " | " + name(t.rest) + "}";
        }
        return "{" + parts.join(", ") + "}";
      }
      case "record":
        return go(t.row);
      case "fn":
        return "fn(" + t.params.map(go).join(", ") + ") -> " + go(t.ret);
      case "linear":
        return "linear " + go(t.inner);
      case "affine":
        return "affine " + go(t.inner);
      case "variant":
        return t.fields.length === 0 ? t.tag : t.tag + "(" + t.fields.map(go).join(", ") + ")";
      case "named":
        return t.args.length === 0 ? t.name : t.name + "<" + t.args.map(go).join(", ") + ">";
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
      return false;
    case "named":
      for (const a of r.args) if (occurs(id, a, subst)) return true;
      return false;
    case "array":
      return occurs(id, r.elem, subst);
    case "row": {
      const flat = resolveRow(r, subst);
      if (flat.kind !== "row") return occurs(id, flat, subst);
      for (const v of flat.fields.values()) if (occurs(id, v, subst)) return true;
      if (typeof flat.rest === "number") {
        if (flat.rest === id) return true;
        const tr = find({ kind: "var", id: flat.rest }, subst);
        if (tr.kind !== "var") return occurs(id, tr, subst);
      }
      return false;
    }
    case "record":
      return occurs(id, r.row, subst);
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
      return occurs(id, r.body, subst);
  }
}

type UnifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Unify two types eagerly. Mutates the substitution.
 *
 * Gradual typing: `unknown` consistent-unifies with anything silently.
 */
function unify(a: MType, b: MType, subst: Substitution, state: State): UnifyResult {
  const ra = find(a, subst);
  const rb = find(b, subst);

  if (ra.kind === "unknown" || rb.kind === "unknown") return { ok: true };

  if (ra.kind === "var") {
    if (rb.kind === "var" && ra.id === rb.id) return { ok: true };
    if (occurs(ra.id, rb, subst)) return { ok: false, reason: "occurs check failed" };
    subst.set(ra.id, rb);
    return { ok: true };
  }
  if (rb.kind === "var") {
    if (occurs(rb.id, ra, subst)) return { ok: false, reason: "occurs check failed" };
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
    case "named": {
      const nb = rb as { kind: "named"; name: string; args: MType[] };
      if (ra.name !== nb.name) {
        return { ok: false, reason: ra.name + " vs " + nb.name };
      }
      if (ra.args.length !== nb.args.length) {
        return {
          ok: false,
          reason: ra.name + " arity " + String(ra.args.length) + " vs " + String(nb.args.length),
        };
      }
      for (let i = 0; i < ra.args.length; i++) {
        const r = unify(ra.args[i] as MType, nb.args[i] as MType, subst, state);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case "array":
      return unify(ra.elem, (rb as { kind: "array"; elem: MType }).elem, subst, state);
    case "fn": {
      const fb = rb as { kind: "fn"; params: MType[]; ret: MType };
      if (ra.params.length !== fb.params.length) {
        return {
          ok: false,
          reason: "arity " + String(ra.params.length) + " vs " + String(fb.params.length),
        };
      }
      for (let i = 0; i < ra.params.length; i++) {
        const r = unify(ra.params[i] as MType, fb.params[i] as MType, subst, state);
        if (!r.ok) return r;
      }
      return unify(ra.ret, fb.ret, subst, state);
    }
    case "record":
      return unify(ra.row, (rb as { kind: "record"; row: MType }).row, subst, state);
    case "row":
      return unifyRows(ra, rb as Extract<MType, { kind: "row" }>, subst, state);
    case "linear":
      return unify(ra.inner, (rb as { kind: "linear"; inner: MType }).inner, subst, state);
    case "affine":
      return unify(ra.inner, (rb as { kind: "affine"; inner: MType }).inner, subst, state);
    case "variant": {
      const vb = rb as { kind: "variant"; tag: string; fields: MType[] };
      if (ra.tag !== vb.tag || ra.fields.length !== vb.fields.length) {
        return { ok: false, reason: "variant " + ra.tag + " vs " + vb.tag };
      }
      for (let i = 0; i < ra.fields.length; i++) {
        const r = unify(ra.fields[i] as MType, vb.fields[i] as MType, subst, state);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case "scheme":
      return { ok: false, reason: "cannot unify with scheme" };
  }
}

/**
 * Unify two row types (Leijen-style). Align field labels:
 *  - field in both: unify field types
 *  - field only in a: extend b's tail (or error if b closed)
 *  - field only in b: extend a's tail (or error if a closed)
 *  - tails: closed/closed must both be empty; open/closed binds open tail to closed empty;
 *    open/open binds both tails to a fresh shared row var.
 */
function unifyRows(
  a: Extract<MType, { kind: "row" }>,
  b: Extract<MType, { kind: "row" }>,
  subst: Substitution,
  state: State,
): UnifyResult {
  const flatA = resolveRow(a, subst);
  const flatB = resolveRow(b, subst);
  if (flatA.kind !== "row") return unify(flatA, b, subst, state);
  if (flatB.kind !== "row") return unify(a, flatB, subst, state);

  const onlyA = new Map<string, MType>();
  const onlyB = new Map<string, MType>(flatB.fields);
  for (const [k, va] of flatA.fields) {
    const vb = onlyB.get(k);
    if (vb === undefined) {
      onlyA.set(k, va);
    } else {
      const r = unify(va, vb, subst, state);
      if (!r.ok) return { ok: false, reason: "field " + k + ": " + r.reason };
      onlyB.delete(k);
    }
  }

  const aClosed = flatA.rest === "empty";
  const bClosed = flatB.rest === "empty";

  if (onlyA.size > 0) {
    // a has fields b doesn't — extend b's tail
    if (bClosed) {
      return {
        ok: false,
        reason: "closed record missing field(s): " + [...onlyA.keys()].join(","),
      };
    }
  }
  if (onlyB.size > 0) {
    if (aClosed) {
      return {
        ok: false,
        reason: "closed record missing field(s): " + [...onlyB.keys()].join(","),
      };
    }
  }

  // Now build tails.
  // Case: both closed, no extras → done
  if (aClosed && bClosed) {
    if (onlyA.size === 0 && onlyB.size === 0) return { ok: true };
    return { ok: false, reason: "closed rows differ" };
  }

  // a open: bind a.rest to a row containing onlyB + new shared tail (or empty if b closed)
  // b open: bind b.rest to a row containing onlyA + new shared tail (or empty if a closed)
  const aRest = flatA.rest;
  const bRest = flatB.rest;

  if (!aClosed && !bClosed) {
    if (typeof aRest === "number" && typeof bRest === "number" && aRest === bRest) {
      // same tail var — must have no extras
      if (onlyA.size === 0 && onlyB.size === 0) return { ok: true };
      return { ok: false, reason: "row tail aliasing prevents extension" };
    }
    // Fresh shared tail.
    const sharedId = state.freshId();
    const sharedTail: MType = { kind: "var", id: sharedId };
    if (typeof aRest === "number") {
      if (occurs(aRest, sharedTail, subst)) return { ok: false, reason: "occurs in row" };
      const newARow: MType = { kind: "row", fields: onlyB, rest: sharedId };
      subst.set(aRest, newARow);
    }
    if (typeof bRest === "number") {
      if (occurs(bRest, sharedTail, subst)) return { ok: false, reason: "occurs in row" };
      const newBRow: MType = { kind: "row", fields: onlyA, rest: sharedId };
      subst.set(bRest, newBRow);
    }
    return { ok: true };
  }

  if (!aClosed && bClosed) {
    // bind a.rest to closed row of onlyB
    if (typeof aRest === "number") {
      const newARow: MType = { kind: "row", fields: onlyB, rest: "empty" };
      subst.set(aRest, newARow);
    }
    return { ok: true };
  }

  // aClosed && !bClosed
  if (typeof bRest === "number") {
    const newBRow: MType = { kind: "row", fields: onlyA, rest: "empty" };
    subst.set(bRest, newBRow);
  }
  return { ok: true };
}

function unifyOrError(ctx: Ctx, expected: MType, got: MType, message: string): boolean {
  const r = unify(expected, got, ctx.state.subst, ctx.state);
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

function instantiate(t: MType, state: State): MType {
  const r = t.kind === "scheme" ? t : null;
  if (r === null) return t;
  const mapping = new Map<number, MType>();
  for (const id of r.quantified) mapping.set(id, state.freshVar());
  return substVars(r.body, mapping);
}

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
      return t;
    case "named":
      return {
        kind: "named",
        name: t.name,
        args: t.args.map((a) => substVars(a, mapping)),
      };
    case "array":
      return { kind: "array", elem: substVars(t.elem, mapping) };
    case "row": {
      const fields = new Map<string, MType>();
      for (const [k, v] of t.fields) fields.set(k, substVars(v, mapping));
      let rest = t.rest;
      if (typeof rest === "number") {
        const m = mapping.get(rest);
        if (m !== undefined && m.kind === "var") rest = m.id;
      }
      return { kind: "row", fields, rest };
    }
    case "record":
      return { kind: "record", row: substVars(t.row, mapping) };
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
      const innerMap = new Map(mapping);
      for (const q of t.quantified) innerMap.delete(q);
      return {
        kind: "scheme",
        quantified: t.quantified,
        body: substVars(t.body, innerMap),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Type annotation parsing
// ---------------------------------------------------------------------------

function parseTypeAnnotation(s: string, params?: Set<string>): MType {
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
      // If the annotation matches a known type parameter, return a placeholder
      // "named" sentinel that `instantiateWith` will replace with a fresh var.
      if (params !== undefined && params.has(s)) {
        return { kind: "named", name: s, args: [] };
      }
      return UNKNOWN;
  }
}

function isUpperCase(s: string): boolean {
  return s.length > 0 && (s[0] as string) >= "A" && (s[0] as string) <= "Z";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notYetImplemented(ctx: Ctx, op: string): MType {
  addError(ctx, "NOT_YET_IMPLEMENTED", "op not yet implemented: " + op);
  return ctx.state.freshVar();
}

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

/** Build an open record type with one known field, used for `get`/`set` constraints. */
function openRecordWithField(state: State, key: string, fieldT: MType): MType {
  const tailId = state.freshId();
  const fields = new Map<string, MType>([[key, fieldT]]);
  return { kind: "record", row: { kind: "row", fields, rest: tailId } };
}

/** Build a record type out of explicit row pieces. */
function recordOf(fields: Map<string, MType>, rest: number | "empty"): MType {
  return { kind: "record", row: { kind: "row", fields, rest } };
}

// ---------------------------------------------------------------------------
// Inference (Algorithm W)
// ---------------------------------------------------------------------------

function infer(expr: Expr, env: TypeEnv, ctx: Ctx): MType {
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

  if (isUpperCase(op)) {
    return inferVariantConstructor(op, arr, env, ctx);
  }

  return inferOp(op, arr, env, ctx);
}

/**
 * Look up a variant constructor and produce a `named<...>` type with fresh
 * type-parameter vars. Each field of the constructor is unified against the
 * inferred argument type.
 */
function inferVariantConstructor(tag: string, arr: Expr[], env: TypeEnv, ctx: Ctx): MType {
  const typeName_ = ctx.ctors.get(tag);
  if (typeName_ === undefined) {
    // Still typecheck arguments so inner errors surface, then error.
    for (let i = 1; i < arr.length; i++) {
      withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
    }
    addError(ctx, "UNKNOWN_VARIANT", "unknown variant constructor: " + tag);
    return ctx.state.freshVar();
  }
  const def = ctx.typeDefs.get(typeName_) as TypeDefInfo;
  // Allocate fresh vars for each type parameter.
  const paramVars = new Map<string, MType>();
  const paramArgs: MType[] = [];
  for (const p of def.params) {
    const v = ctx.state.freshVar();
    paramVars.set(p, v);
    paramArgs.push(v);
  }
  const fieldTypes = (def.variants.get(tag) as MType[]).map((ft) => instantiateWith(ft, paramVars));
  const argCount = arr.length - 1;
  if (argCount !== fieldTypes.length) {
    for (let i = 1; i < arr.length; i++) {
      withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
    }
    addError(
      ctx,
      "ARITY_ERROR",
      tag + " expects " + String(fieldTypes.length) + " field(s), got " + String(argCount),
    );
    return { kind: "named", name: typeName_, args: paramArgs };
  }
  for (let i = 1; i < arr.length; i++) {
    const argT = withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
    const expected = fieldTypes[i - 1] as MType;
    withPath(ctx, i, (sub) => unifyOrError(sub, expected, argT, tag + ": field " + String(i - 1)));
  }
  return { kind: "named", name: typeName_, args: paramArgs };
}

/**
 * Replace type-parameter placeholders (special "var" types stored in a map by
 * name) inside a stored field-type. Field types in TypeDefInfo use special
 * placeholder vars: {kind:"var", id: -K} where K is the index in def.params.
 * We accept the placeholder convention: we use a Map<string, MType> for fresh
 * args and identify placeholders by a separate marker. To keep things simple
 * we instead store field types using {kind:"var", id} where ids are "param
 * tokens" tracked separately. For Phase 3 we use a simpler approach: field
 * types are stored with literal `{kind:"named", name:"<paramName>", args:[]}`
 * acting as a sentinel — and `instantiateWith` rewrites those.
 */
function instantiateWith(t: MType, paramVars: Map<string, MType>): MType {
  switch (t.kind) {
    case "named": {
      const replacement = paramVars.get(t.name);
      if (replacement !== undefined && t.args.length === 0) return replacement;
      return {
        kind: "named",
        name: t.name,
        args: t.args.map((a) => instantiateWith(a, paramVars)),
      };
    }
    case "var":
    case "unknown":
    case "null":
    case "bool":
    case "int":
    case "float":
    case "string":
    case "bytes":
      return t;
    case "array":
      return { kind: "array", elem: instantiateWith(t.elem, paramVars) };
    case "row": {
      const fields = new Map<string, MType>();
      for (const [k, v] of t.fields) fields.set(k, instantiateWith(v, paramVars));
      return { kind: "row", fields, rest: t.rest };
    }
    case "record":
      return { kind: "record", row: instantiateWith(t.row, paramVars) };
    case "fn":
      return {
        kind: "fn",
        params: t.params.map((p) => instantiateWith(p, paramVars)),
        ret: instantiateWith(t.ret, paramVars),
      };
    case "linear":
      return { kind: "linear", inner: instantiateWith(t.inner, paramVars) };
    case "affine":
      return { kind: "affine", inner: instantiateWith(t.inner, paramVars) };
    case "variant":
      return {
        kind: "variant",
        tag: t.tag,
        fields: t.fields.map((f) => instantiateWith(f, paramVars)),
      };
    case "scheme":
      return {
        kind: "scheme",
        quantified: t.quantified,
        body: instantiateWith(t.body, paramVars),
      };
  }
}

/**
 * Infer the type of a `match` expression.
 *
 * Form: ["match", scrut, [pattern1, body1], [pattern2, body2], ...]
 *
 * Patterns:
 *   - ["Tag", binding1, ...] — variant pattern; bindings receive field types
 *   - "_"                    — wildcard
 *   - lowercase name         — variable binding (binds scrutinee)
 *   - literal int/string/bool — literal pattern (matches when equal)
 *
 * Exhaustiveness: if scrutinee resolves to a `named<...>` type, all variants of
 * that type must be covered (or a wildcard / variable pattern present).
 */
function inferMatch(arr: Expr[], env: TypeEnv, ctx: Ctx): MType {
  const state = ctx.state;
  if (arr.length < 3) {
    addError(ctx, "ARITY_ERROR", "match requires a scrutinee and at least 1 clause");
    return state.freshVar();
  }
  const scrutT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
  const result = state.freshVar();

  /** Tags covered by an exact tag pattern. */
  const coveredTags = new Set<string>();
  /** Whether some clause covers everything (wildcard / var pattern). */
  let sawCatchAll = false;

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

    let clauseEnv = env;

    if (pattern === "_") {
      sawCatchAll = true;
    } else if (typeof pattern === "string") {
      // Variable binding (any lowercase string acts as a fresh binding to scrutinee type)
      // or a string literal pattern (matches when scrutinee is a string).
      // Spec doesn't have a separate var-binding form; we treat lowercase identifiers as bindings.
      if (pattern.length > 0 && !isUpperCase(pattern)) {
        clauseEnv = env.extend({ [pattern]: scrutT });
        sawCatchAll = true;
      } else {
        // Treat as string literal — unify scrutinee with string.
        withPath(ctx, i, (sub) =>
          withPath(sub, 0, (sub2) =>
            unifyOrError(sub2, STRING, scrutT, "match: string literal pattern"),
          ),
        );
      }
    } else if (typeof pattern === "number") {
      const litT = Number.isInteger(pattern) ? INT : FLOAT;
      withPath(ctx, i, (sub) =>
        withPath(sub, 0, (sub2) => unifyOrError(sub2, litT, scrutT, "match: numeric literal")),
      );
    } else if (typeof pattern === "boolean") {
      withPath(ctx, i, (sub) =>
        withPath(sub, 0, (sub2) => unifyOrError(sub2, BOOL, scrutT, "match: bool literal")),
      );
    } else if (Array.isArray(pattern) && pattern.length >= 1 && typeof pattern[0] === "string") {
      const tag = pattern[0];
      const bindings = pattern.slice(1);
      const typeName_ = ctx.ctors.get(tag);
      if (typeName_ === undefined) {
        withPath(ctx, i, (sub) =>
          withPath(sub, 0, (sub2) =>
            addError(sub2, "UNKNOWN_VARIANT", "unknown variant constructor in pattern: " + tag),
          ),
        );
        continue;
      }
      const def = ctx.typeDefs.get(typeName_) as TypeDefInfo;
      const paramVars = new Map<string, MType>();
      const paramArgs: MType[] = [];
      for (const p of def.params) {
        const v = state.freshVar();
        paramVars.set(p, v);
        paramArgs.push(v);
      }
      const fieldTypes = (def.variants.get(tag) as MType[]).map((ft) =>
        instantiateWith(ft, paramVars),
      );
      // Unify scrutinee with named<...> for this DU.
      const expectedScrut: MType = {
        kind: "named",
        name: typeName_,
        args: paramArgs,
      };
      withPath(ctx, i, (sub) =>
        withPath(sub, 0, (sub2) =>
          unifyOrError(sub2, expectedScrut, scrutT, "match: scrutinee type"),
        ),
      );
      // Check binding count. Wildcards "_" allowed.
      if (bindings.length !== fieldTypes.length) {
        withPath(ctx, i, (sub) =>
          withPath(sub, 0, (sub2) =>
            addError(
              sub2,
              "ARITY_ERROR",
              tag +
                " pattern: expected " +
                String(fieldTypes.length) +
                " bindings, got " +
                String(bindings.length),
            ),
          ),
        );
      }
      const newBindings: Record<string, MType> = {};
      const n = Math.min(bindings.length, fieldTypes.length);
      for (let j = 0; j < n; j++) {
        const b = bindings[j];
        if (typeof b !== "string") {
          withPath(ctx, i, (sub) =>
            withPath(sub, 0, (sub2) =>
              addError(sub2, "TYPE_MISMATCH", "match binding name must be a string"),
            ),
          );
          continue;
        }
        if (b !== "_") newBindings[b] = fieldTypes[j] as MType;
      }
      clauseEnv = env.extend(newBindings);
      coveredTags.add(tag);
    } else {
      withPath(ctx, i, (sub) =>
        withPath(sub, 0, (sub2) => addError(sub2, "TYPE_MISMATCH", "match: invalid pattern")),
      );
      continue;
    }

    const bodyT = withPath(ctx, i, (sub) =>
      withPath(sub, 1, (sub2) => infer(body, clauseEnv, sub2)),
    );
    withPath(ctx, i, (sub) =>
      withPath(sub, 1, (sub2) => unifyOrError(sub2, result, bodyT, "match: branch result type")),
    );
  }

  // Exhaustiveness check.
  if (!sawCatchAll) {
    const resolved = find(scrutT, ctx.state.subst);
    if (resolved.kind === "named") {
      const def = ctx.typeDefs.get(resolved.name);
      if (def !== undefined) {
        const missing: string[] = [];
        for (const tag of def.variants.keys()) {
          if (!coveredTags.has(tag)) missing.push(tag);
        }
        if (missing.length > 0) {
          addError(
            ctx,
            "NON_EXHAUSTIVE_MATCH",
            "non-exhaustive match on " +
              resolved.name +
              ": missing variant(s) " +
              missing.join(", "),
          );
        }
      }
    }
  }

  return result;
}

function inferOp(op: string, arr: Expr[], env: TypeEnv, ctx: Ctx): MType {
  const state = ctx.state;
  const subst = state.subst;

  switch (op) {
    case "bytes": {
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
      withPath(ctx, 2, (sub) => unifyOrError(sub, ta, tb, op + " requires matching numeric types"));
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
      withPath(ctx, 2, (sub) => unifyOrError(sub, ta, tb, op + " requires matching numeric types"));
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
    case "str-get": {
      if (!expectArity(ctx, "str-get", arr, 2)) return INT;
      const s = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const i = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, s, "str-get requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, INT, i, "str-get index must be int"));
      return INT;
    }
    case "str-cmp": {
      if (!expectArity(ctx, "str-cmp", arr, 2)) return INT;
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const b = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, a, "str-cmp requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, b, "str-cmp requires string"));
      return INT;
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
    case "concat": {
      if (!expectArity(ctx, "concat", arr, 2)) return state.freshVar();
      const t1 = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const t2 = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      // Polymorphic over array<T> or string
      const r1 = find(t1, subst);
      if (r1.kind === "string") {
        withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, t2, "concat requires string"));
        return STRING;
      }
      if (r1.kind === "array") {
        withPath(ctx, 2, (sub) => unifyOrError(sub, t1, t2, "concat: element type mismatch"));
        return t1;
      }
      // Default: arrays.
      const elem = state.freshVar();
      const arrT: MType = { kind: "array", elem };
      withPath(ctx, 1, (sub) => unifyOrError(sub, arrT, t1, "concat requires array or string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, arrT, t2, "concat requires array or string"));
      return arrT;
    }
    case "slice": {
      if (!expectArityRange(ctx, "slice", arr, 2, 3)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const a = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 2, (sub) => unifyOrError(sub, INT, a, "slice index must be int"));
      if (arr.length === 4) {
        const b = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
        withPath(ctx, 3, (sub) => unifyOrError(sub, INT, b, "slice index must be int"));
      }
      const r = find(t, subst);
      if (r.kind === "string") return STRING;
      if (r.kind === "array") return t;
      // var/unknown: assume array<a>.
      const elem = state.freshVar();
      const arrT: MType = { kind: "array", elem };
      withPath(ctx, 1, (sub) => unifyOrError(sub, arrT, t, "slice requires array or string"));
      return arrT;
    }
    case "array-map":
    case "map": {
      if (!expectArity(ctx, op, arr, 2)) return state.freshVar();
      // map can apply to array or record.
      // We pick array by default; record support: detect resolved input type.
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const aT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const resolved = find(aT, subst);
      if (op === "map" && resolved.kind === "record") {
        // map over record: fn(v) -> v', preserves keys, all values become v'.
        const inV = state.freshVar();
        const outV = state.freshVar();
        withPath(ctx, 1, (sub) =>
          unifyOrError(sub, { kind: "fn", params: [inV], ret: outV }, fT, op + ": expected fn"),
        );
        // The input record must have all values of type inV.
        const tailIn = state.freshId();
        const allVRowIn: MType = {
          kind: "row",
          fields: new Map(),
          rest: tailIn,
        };
        // We need all fields to be inV. Walk current row, unify each field with inV.
        const flat = resolveRow(resolved.row, subst);
        if (flat.kind === "row") {
          for (const [, v] of flat.fields) {
            withPath(ctx, 2, (sub) => unifyOrError(sub, inV, v, op + ": record field type"));
          }
          // Build output record with same keys but value type outV.
          const outFields = new Map<string, MType>();
          for (const [k] of flat.fields) outFields.set(k, outV);
          return recordOf(outFields, flat.rest);
        }
        // Fallback: treat as open record with all-inV values.
        void allVRowIn;
        return {
          kind: "record",
          row: { kind: "row", fields: new Map(), rest: state.freshId() },
        };
      }
      const inElem = state.freshVar();
      const outElem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "fn", params: [inElem], ret: outElem }, fT, op + ": expected fn"),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, { kind: "array", elem: inElem }, aT, op + ": expected array"),
      );
      return { kind: "array", elem: outElem };
    }
    case "array-filter":
    case "filter": {
      if (!expectArity(ctx, op, arr, 2)) return state.freshVar();
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
      return { kind: "array", elem };
    }
    case "array-reduce":
    case "reduce": {
      if (!expectArity(ctx, op, arr, 3)) return state.freshVar();
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const initT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const aT = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      const acc = state.freshVar();
      const elem = state.freshVar();
      withPath(ctx, 2, (sub) => unifyOrError(sub, acc, initT, op + " init type"));
      withPath(ctx, 1, (sub) =>
        unifyOrError(
          sub,
          { kind: "fn", params: [acc, elem], ret: acc },
          fT,
          op + ": expected fn(acc, elem) -> acc",
        ),
      );
      withPath(ctx, 3, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, aT, op + ": expected array"),
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
          {
            kind: "fn",
            params: [inElem],
            ret: { kind: "array", elem: outElem },
          },
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
      if (r.kind === "int") return INT;
      if (r.kind === "float") return INT;
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
      const r = find(t, subst);
      if (
        r.kind === "array" ||
        r.kind === "record" ||
        r.kind === "var" ||
        r.kind === "unknown" ||
        r.kind === "string"
      ) {
        return INT;
      }
      withPath(ctx, 1, (sub) =>
        addError(sub, "TYPE_MISMATCH", "count requires array/record/string, got " + typeName(r), {
          expected: "array | record | string",
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
    case "parse-number": {
      if (!expectArity(ctx, "parse-number", arr, 1)) return FLOAT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, t, "parse-number requires string"));
      return FLOAT;
    }
    case "int->float": {
      if (!expectArity(ctx, "int->float", arr, 1)) return FLOAT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, INT, t, "int->float requires int"));
      return FLOAT;
    }
    case "float->int": {
      if (!expectArity(ctx, "float->int", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, FLOAT, t, "float->int requires float"));
      return INT;
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

    // -------------------- record / row ops --------------------
    case "record":
    case "{}": {
      // ["record", [k1, v1], [k2, v2], ...] or ["{}", ...] — closed record literal.
      const fields = new Map<string, MType>();
      for (let i = 1; i < arr.length; i++) {
        const pair = arr[i];
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") {
          withPath(ctx, i, (sub) =>
            addError(sub, "TYPE_MISMATCH", "record entry must be [key, value] with string key"),
          );
          continue;
        }
        const key = pair[0];
        const valT = withPath(ctx, i, (sub) =>
          withPath(sub, 1, (sub2) => infer(pair[1] as Expr, env, sub2)),
        );
        if (fields.has(key)) {
          withPath(ctx, i, (sub) =>
            addError(sub, "TYPE_MISMATCH", "duplicate field in record literal: " + key),
          );
        }
        fields.set(key, valT);
      }
      return recordOf(fields, "empty");
    }

    case "get":
    case "record-get": {
      if (!expectArity(ctx, op, arr, 2)) return state.freshVar();
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const keyExpr = arr[2];
      // Allow string literal key for static row constraint.
      if (typeof keyExpr !== "string") {
        // Evaluate the key (must be string), but cannot constrain the row type.
        const kT = withPath(ctx, 2, (sub) => infer(keyExpr as Expr, env, sub));
        withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, kT, op + " key must be string"));
        // Without a static key, just require a record and return unknown.
        const row = state.freshVar();
        withPath(ctx, 1, (sub) =>
          unifyOrError(sub, { kind: "record", row }, rT, op + " requires record"),
        );
        return state.freshVar();
      }
      const fieldT = state.freshVar();
      const expected = openRecordWithField(state, keyExpr, fieldT);
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, expected, rT, op + " requires record with key " + keyExpr),
      );
      return fieldT;
    }

    case "set":
    case "record-set": {
      if (!expectArity(ctx, op, arr, 3)) return state.freshVar();
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const keyExpr = arr[2];
      const valT = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      if (typeof keyExpr !== "string") {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " key must be a string literal"),
        );
        return rT;
      }
      const fieldT = state.freshVar();
      const expected = openRecordWithField(state, keyExpr, fieldT);
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, expected, rT, op + " requires record with key " + keyExpr),
      );
      withPath(ctx, 3, (sub) =>
        unifyOrError(sub, fieldT, valT, op + ": value type mismatch for key " + keyExpr),
      );
      return rT;
    }

    case "record-del": {
      if (!expectArity(ctx, "record-del", arr, 2)) return state.freshVar();
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const keyExpr = arr[2];
      // Just require record; deletion of an unknown key returns the same row (open).
      const row = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "record", row }, rT, "record-del requires record"),
      );
      if (typeof keyExpr !== "string") {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", "record-del key must be a string literal"),
        );
      }
      return rT;
    }

    case "get-in": {
      if (!expectArity(ctx, "get-in", arr, 2)) return state.freshVar();
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const pathExpr = arr[2];
      // Must be array of string|int. We can't constrain row types deeply unless
      // path is a literal array of string literals.
      if (!Array.isArray(pathExpr)) {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", "get-in path must be an array literal"),
        );
        return state.freshVar();
      }
      // If the path is a literal array (["array", k1, k2, ...] or just a JSON array literal in spec),
      // walk it. Spec uses array<string|number>. If first elem is "array", treat it like such.
      let segments: Expr[] = pathExpr;
      if (segments.length > 0 && segments[0] === "array") segments = segments.slice(1);
      // Walk through the row.
      let cur: MType = rT;
      for (const seg of segments) {
        if (typeof seg === "string") {
          const fieldT = state.freshVar();
          const expected = openRecordWithField(state, seg, fieldT);
          withPath(ctx, 1, (sub) => unifyOrError(sub, expected, cur, "get-in: missing key " + seg));
          cur = fieldT;
        } else if (typeof seg === "number") {
          const elem = state.freshVar();
          withPath(ctx, 1, (sub) =>
            unifyOrError(sub, { kind: "array", elem }, cur, "get-in: index requires array"),
          );
          cur = elem;
        } else {
          // dynamic path segment — give up structurally
          return state.freshVar();
        }
      }
      return cur;
    }

    case "set-in": {
      if (!expectArity(ctx, "set-in", arr, 3)) return state.freshVar();
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const pathExpr = arr[2];
      const valT = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      if (!Array.isArray(pathExpr)) {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", "set-in path must be an array literal"),
        );
        return rT;
      }
      let segments: Expr[] = pathExpr;
      if (segments.length > 0 && segments[0] === "array") segments = segments.slice(1);
      let cur: MType = rT;
      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];
        const isLast = si === segments.length - 1;
        if (typeof seg === "string") {
          const fieldT = isLast ? valT : state.freshVar();
          const expected = openRecordWithField(state, seg, fieldT);
          withPath(ctx, 1, (sub) => unifyOrError(sub, expected, cur, "set-in: missing key " + seg));
          cur = fieldT;
        } else if (typeof seg === "number") {
          const elem = isLast ? valT : state.freshVar();
          withPath(ctx, 1, (sub) =>
            unifyOrError(sub, { kind: "array", elem }, cur, "set-in: index requires array"),
          );
          cur = elem;
        } else {
          return rT;
        }
      }
      return rT;
    }

    case "merge":
    case "record-merge": {
      if (!expectArity(ctx, op, arr, 2)) return state.freshVar();
      const aT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const bT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      // Both must be records. Result is a closed record with all keys from both,
      // b winning on conflict.
      const rowA = state.freshVar();
      const rowB = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "record", row: rowA }, aT, op + ": expected record"),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, { kind: "record", row: rowB }, bT, op + ": expected record"),
      );
      // Try to compute merged row from zonked sides.
      const za = zonk(aT, subst);
      const zb = zonk(bT, subst);
      if (za.kind === "record" && zb.kind === "record") {
        const ra = resolveRow(za.row, subst);
        const rb = resolveRow(zb.row, subst);
        if (ra.kind === "row" && rb.kind === "row") {
          const merged = new Map<string, MType>(ra.fields);
          for (const [k, v] of rb.fields) merged.set(k, v);
          // If both closed, result is closed; else open with fresh tail.
          if (ra.rest === "empty" && rb.rest === "empty") {
            return recordOf(merged, "empty");
          }
          return recordOf(merged, state.freshId());
        }
      }
      // Fallback: fully open record.
      return {
        kind: "record",
        row: { kind: "row", fields: new Map(), rest: state.freshId() },
      };
    }

    case "keys":
    case "record-keys": {
      if (!expectArity(ctx, op, arr, 1)) return { kind: "array", elem: STRING };
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const row = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "record", row }, rT, op + ": expected record"),
      );
      return { kind: "array", elem: STRING };
    }

    case "vals":
    case "record-vals": {
      if (!expectArity(ctx, op, arr, 1)) return state.freshVar();
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const elem = state.freshVar();
      const row = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "record", row }, rT, op + ": expected record"),
      );
      // Walk current fields and unify each with elem (consistent unification).
      const z = zonk(rT, subst);
      if (z.kind === "record") {
        const flat = resolveRow(z.row, subst);
        if (flat.kind === "row") {
          for (const [, v] of flat.fields) {
            withPath(ctx, 1, (sub) => unifyOrError(sub, elem, v, op + ": value type"));
          }
        }
      }
      return { kind: "array", elem };
    }

    case "record-has": {
      if (!expectArity(ctx, "record-has", arr, 2)) return BOOL;
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const row = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "record", row }, rT, "record-has: expected record"),
      );
      const keyExpr = arr[2];
      if (typeof keyExpr !== "string") {
        const kT = withPath(ctx, 2, (sub) => infer(keyExpr as Expr, env, sub));
        withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, kT, "record-has: key must be string"));
      }
      return BOOL;
    }

    // -------------------- match (DU pattern matching) --------------------
    case "match": {
      return inferMatch(arr, env, ctx);
    }

    // -------------------- Phase 3+ ops (still TBD) --------------------
    case "perform":
    case "handle":
    case "call.method":
    case "?": {
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
  // Standalone typecheck still gets the std DUs (option/result) so that bare
  // expressions referencing Some/None/Ok/Err typecheck without a module wrapper.
  const { typeDefs, ctors } = makeStdTypeDefs();
  const ctx: Ctx = { errors: [], path: [], state, typeDefs, ctors };
  const t = infer(expr, env ?? EMPTY_TYPE_ENV, ctx);
  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }
  return { ok: true, type: zonk(t, state.subst) };
}

// ---------------------------------------------------------------------------
// Module typechecking
// ---------------------------------------------------------------------------

/**
 * Build the standard `option<T>` and `result<T, E>` type definitions.
 * Field types use `{kind:"named", name:"<paramName>", args:[]}` as
 * placeholders for the type parameters; these are replaced by fresh vars
 * at each constructor / pattern instantiation site.
 */
function makeStdTypeDefs(): {
  typeDefs: Map<string, TypeDefInfo>;
  ctors: Map<string, string>;
} {
  const typeDefs = new Map<string, TypeDefInfo>();
  const ctors = new Map<string, string>();

  const optionVariants = new Map<string, MType[]>();
  optionVariants.set("None", []);
  optionVariants.set("Some", [{ kind: "named", name: "T", args: [] }]);
  typeDefs.set("option", { params: ["T"], variants: optionVariants });
  ctors.set("None", "option");
  ctors.set("Some", "option");

  const resultVariants = new Map<string, MType[]>();
  resultVariants.set("Ok", [{ kind: "named", name: "T", args: [] }]);
  resultVariants.set("Err", [{ kind: "named", name: "E", args: [] }]);
  typeDefs.set("result", { params: ["T", "E"], variants: resultVariants });
  ctors.set("Ok", "result");
  ctors.set("Err", "result");

  return { typeDefs, ctors };
}

/**
 * Convert module type definitions into TypeDefInfo entries. For Phase 3 we do
 * not yet have a syntax for declaring type parameters — DUs declared in a
 * module are monomorphic. Field type strings resolve via parseTypeAnnotation;
 * unknown names become `unknown`.
 */
function registerModuleTypeDefs(
  defs: TypeDef[],
  typeDefs: Map<string, TypeDefInfo>,
  ctors: Map<string, string>,
): void {
  for (const def of defs) {
    const variants = new Map<string, MType[]>();
    for (const variant of def.variants) {
      const fields: MType[] = (variant.fields ?? []).map(([, t]) => parseTypeAnnotation(t));
      variants.set(variant.tag, fields);
      ctors.set(variant.tag, def.name);
    }
    typeDefs.set(def.name, { params: [], variants });
  }
}

export function typecheckModule(module: Module): TypecheckResult {
  const state = new State();
  const { typeDefs, ctors } = makeStdTypeDefs();
  registerModuleTypeDefs(module.types ?? [], typeDefs, ctors);
  const ctx: Ctx = { errors: [], path: [], state, typeDefs, ctors };
  const moduleEnv = EMPTY_TYPE_ENV;
  const t = infer(module.main, moduleEnv, ctx);
  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }
  return { ok: true, type: zonk(t, state.subst) };
}
