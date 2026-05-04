import type { Expr } from "./types.ts";
import type { TypeInfo } from "./typecheck.ts";

/**
 * A rewrite rule is a tree-automaton transition: given an expression rooted at
 * `headOp`, optionally bind metavariables via `match`, optionally guard via
 * `where`, and produce a new expression via `rewrite`.
 *
 * `reducing: true` marks rules that strictly reduce node count (or some other
 * well-founded measure) — the optimizer can re-fire them at the same position
 * without termination concerns. `reducing: false` rules are guarded against
 * firing twice on the same (node, rule) pair.
 */
export type RewriteRule = {
  name: string;
  /** The op at the rule's root — used for indexing into the rule table. */
  headOp: string;
  match(expr: Expr): Record<string, Expr> | null;
  where?(bindings: Record<string, Expr>, typeInfo?: TypeInfo): boolean;
  rewrite(bindings: Record<string, Expr>): Expr;
  reducing: boolean;
};

// --- Helpers shared by rules ---

function isLit(e: Expr): boolean {
  return Array.isArray(e) && e.length === 2 && e[0] === "__lit";
}

function lit(v: unknown): Expr {
  return ["__lit", v as Expr];
}

/** Lift any constant-shaped expression to its runtime JS value, if possible.
 * Returns { ok: true, value } or { ok: false }. Distinct from `isLit` because
 * the AST atoms `null`, booleans, and numbers are also constants. */
type Const = { ok: true; value: unknown } | { ok: false };

function asConst(e: Expr): Const {
  if (e === null) return { ok: true, value: null };
  if (typeof e === "boolean") return { ok: true, value: e };
  if (typeof e === "number") {
    if (Number.isInteger(e) && !Object.is(e, -0)) {
      return { ok: true, value: BigInt(e) };
    }
    return { ok: true, value: e };
  }
  if (Array.isArray(e) && e.length === 2 && e[0] === "__lit") {
    return { ok: true, value: e[1] };
  }
  return { ok: false };
}

/** True if both args reduce to constant values; returns the JS values. */
function bothConst(a: Expr, b: Expr): { ok: true; a: unknown; b: unknown } | { ok: false } {
  const ca = asConst(a);
  if (!ca.ok) return { ok: false };
  const cb = asConst(b);
  if (!cb.ok) return { ok: false };
  return { ok: true, a: ca.value, b: cb.value };
}

function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

/** Deep equality matching the runtime's _eq semantics. */
function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEq(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    return ak.length === bk.length && ak.every((k) => deepEq(ao[k], bo[k]));
  }
  return false;
}

// --- Free variable analysis ---

/** Names bound by a `let`/`letrec`/`fn`/`match`-style construct. */
function paramNames(params: Expr): string[] {
  if (!Array.isArray(params)) return [];
  const out: string[] = [];
  for (const p of params) {
    if (typeof p === "string") out.push(p);
    else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") out.push(p[0]);
  }
  return out;
}

/** Whether `name` appears free (i.e. as a variable reference) in `expr`. */
function freeIn(name: string, expr: Expr): boolean {
  if (typeof expr === "string") return expr === name;
  if (!Array.isArray(expr) || expr.length === 0) return false;
  const op = expr[0];
  if (typeof op !== "string") return expr.some((e) => freeIn(name, e as Expr));

  switch (op) {
    case "__lit":
      return false;
    case "fn":
    case "fn-once": {
      const ps = paramNames(expr[1] as Expr);
      if (ps.includes(name)) return false;
      return freeIn(name, expr[2] as Expr);
    }
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return false;
      // Sequentially: each binding's value sees prior bindings, body sees all.
      let shadowed = false;
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) continue;
        if (!shadowed && freeIn(name, b[1] as Expr)) return true;
        if (b[0] === name) shadowed = true;
      }
      if (shadowed) return false;
      return freeIn(name, expr[2] as Expr);
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return false;
      const names = bindings
        .map((b) => (Array.isArray(b) ? b[0] : null))
        .filter((n): n is string => typeof n === "string");
      if (names.includes(name)) return false;
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) continue;
        if (freeIn(name, b[1] as Expr)) return true;
      }
      return freeIn(name, expr[2] as Expr);
    }
    case "match": {
      // ["match", scrut, [pattern, body], ...]
      if (freeIn(name, expr[1] as Expr)) return true;
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) continue;
        const pattern = clause[0];
        const body = clause[1] as Expr;
        const bound = Array.isArray(pattern)
          ? pattern.slice(1).filter((s): s is string => typeof s === "string")
          : [];
        if (!bound.includes(name) && freeIn(name, body)) return true;
      }
      return false;
    }
    case "handle": {
      if (freeIn(name, expr[1] as Expr)) return true;
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) continue;
        const pattern = clause[0];
        const body = clause[1] as Expr;
        const bound = Array.isArray(pattern)
          ? pattern.slice(1).filter((s): s is string => typeof s === "string")
          : [];
        if (!bound.includes(name) && freeIn(name, body)) return true;
      }
      return false;
    }
    case "__loop": {
      // ["__loop", params, initArgs, body]
      const ps = paramNames(expr[1] as Expr);
      const initArgs = expr[2];
      if (Array.isArray(initArgs)) {
        for (const a of initArgs) if (freeIn(name, a as Expr)) return true;
      }
      if (ps.includes(name)) return false;
      return freeIn(name, expr[3] as Expr);
    }
    default:
      // Default: traverse all sub-expressions. Op string itself isn't a var ref.
      for (let i = 1; i < expr.length; i++) {
        if (freeIn(name, expr[i] as Expr)) return true;
      }
      return false;
  }
}

/** Conservatively decide whether evaluating `expr` can have observable effects.
 * Used to decide if a dead binding's value can be safely dropped. */
function hasEffects(expr: Expr): boolean {
  if (expr === null || typeof expr === "boolean" || typeof expr === "number") return false;
  if (typeof expr === "string") return false; // bare var ref — no effect
  if (!Array.isArray(expr) || expr.length === 0) return false;
  const op = expr[0];
  if (typeof op !== "string") return true;
  switch (op) {
    case "perform":
    case "handle":
    case "call":
    case "as": // throws on type mismatch — treat as effect
      return true;
    case "/":
    case "%":
      // Integer division/modulo by zero throws; conservatively treat as effect
      // unless we can prove the divisor is non-zero.
      if (expr.length === 3) {
        const c = asConst(expr[2] as Expr);
        if (c.ok && typeof c.value === "bigint" && c.value !== 0n) {
          return hasEffects(expr[1] as Expr);
        }
        if (c.ok && typeof c.value === "number" && c.value !== 0) {
          return hasEffects(expr[1] as Expr);
        }
      }
      return true;
    case "__lit":
      return false;
    case "fn":
    case "fn-once":
      return false; // creating a closure has no effect (body is deferred)
    default:
      for (let i = 1; i < expr.length; i++) {
        if (hasEffects(expr[i] as Expr)) return true;
      }
      return false;
  }
}

/** Substitute `name` → `value` inside `expr`. Respects shadowing. */
function substitute(expr: Expr, name: string, value: Expr): Expr {
  if (typeof expr === "string") return expr === name ? value : expr;
  if (!Array.isArray(expr) || expr.length === 0) return expr;
  const op = expr[0];
  if (typeof op !== "string") {
    return expr.map((e) => substitute(e as Expr, name, value)) as Expr;
  }

  switch (op) {
    case "__lit":
      return expr;
    case "fn":
    case "fn-once": {
      const ps = paramNames(expr[1] as Expr);
      if (ps.includes(name)) return expr;
      return [op, expr[1] as Expr, substitute(expr[2] as Expr, name, value)];
    }
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const newBindings: Expr[] = [];
      let shadowed = false;
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) {
          newBindings.push(b as Expr);
          continue;
        }
        const bName = b[0] as string;
        const bVal = b[1] as Expr;
        const newVal = shadowed ? bVal : substitute(bVal, name, value);
        newBindings.push([bName, newVal] as Expr);
        if (bName === name) shadowed = true;
      }
      const newBody = shadowed ? (expr[2] as Expr) : substitute(expr[2] as Expr, name, value);
      return ["let", newBindings as Expr, newBody];
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const names = bindings
        .map((b) => (Array.isArray(b) ? b[0] : null))
        .filter((n): n is string => typeof n === "string");
      if (names.includes(name)) return expr;
      const newBindings = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, substitute(b[1] as Expr, name, value)] as Expr;
      });
      return ["letrec", newBindings as Expr, substitute(expr[2] as Expr, name, value)];
    }
    case "match": {
      const newArr: Expr[] = [op, substitute(expr[1] as Expr, name, value)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          newArr.push(clause as Expr);
          continue;
        }
        const pattern = clause[0] as Expr;
        const body = clause[1] as Expr;
        const bound = Array.isArray(pattern)
          ? pattern.slice(1).filter((s): s is string => typeof s === "string")
          : [];
        const newBody = bound.includes(name) ? body : substitute(body, name, value);
        newArr.push([pattern, newBody] as Expr);
      }
      return newArr;
    }
    case "handle": {
      const newArr: Expr[] = [op, substitute(expr[1] as Expr, name, value)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          newArr.push(clause as Expr);
          continue;
        }
        const pattern = clause[0] as Expr;
        const body = clause[1] as Expr;
        const bound = Array.isArray(pattern)
          ? pattern.slice(1).filter((s): s is string => typeof s === "string")
          : [];
        const newBody = bound.includes(name) ? body : substitute(body, name, value);
        newArr.push([pattern, newBody] as Expr);
      }
      return newArr;
    }
    case "__loop": {
      const ps = paramNames(expr[1] as Expr);
      const initArgs = expr[2];
      const newInit = Array.isArray(initArgs)
        ? (initArgs.map((a) => substitute(a as Expr, name, value)) as Expr)
        : (initArgs as Expr);
      const body = expr[3] as Expr;
      const newBody = ps.includes(name) ? body : substitute(body, name, value);
      return [op, expr[1] as Expr, newInit, newBody];
    }
    default:
      return expr.map((e) => substitute(e as Expr, name, value)) as Expr;
  }
}

// --- Constant folding rules ---

/** Helper to build an arithmetic-fold rule for a binary numeric op. */
function arithRule(
  op: string,
  fn: (a: bigint, b: bigint) => bigint | null,
  ffn: (a: number, b: number) => number,
): RewriteRule {
  return {
    name: `fold-${op}`,
    headOp: op,
    reducing: true,
    match(e) {
      if (!Array.isArray(e) || e.length !== 3 || e[0] !== op) return null;
      return { a: e[1] as Expr, b: e[2] as Expr };
    },
    where(b) {
      const c = bothConst(b.a as Expr, b.b as Expr);
      if (!c.ok) return false;
      const va = c.a;
      const vb = c.b;
      if (typeof va === "bigint" && typeof vb === "bigint") {
        const r = fn(va, vb);
        return r !== null;
      }
      if (
        (typeof va === "bigint" || typeof va === "number") &&
        (typeof vb === "bigint" || typeof vb === "number")
      ) {
        const av = typeof va === "bigint" ? Number(va) : va;
        const bv = typeof vb === "bigint" ? Number(vb) : vb;
        const r = ffn(av, bv);
        return Number.isFinite(r);
      }
      return false;
    },
    rewrite(b) {
      const c = bothConst(b.a as Expr, b.b as Expr) as {
        ok: true;
        a: unknown;
        b: unknown;
      };
      const va = c.a;
      const vb = c.b;
      if (typeof va === "bigint" && typeof vb === "bigint") {
        const r = fn(va, vb);
        return lit(r);
      }
      const av = typeof va === "bigint" ? Number(va) : (va as number);
      const bv = typeof vb === "bigint" ? Number(vb) : (vb as number);
      return lit(ffn(av, bv));
    },
  };
}

function cmpRule(op: string, fn: (a: number, b: number) => boolean): RewriteRule {
  return {
    name: `fold-${op}`,
    headOp: op,
    reducing: true,
    match(e) {
      if (!Array.isArray(e) || e.length !== 3 || e[0] !== op) return null;
      return { a: e[1] as Expr, b: e[2] as Expr };
    },
    where(b) {
      const c = bothConst(b.a as Expr, b.b as Expr);
      if (!c.ok) return false;
      return (
        (typeof c.a === "bigint" || typeof c.a === "number") &&
        (typeof c.b === "bigint" || typeof c.b === "number")
      );
    },
    rewrite(b) {
      const c = bothConst(b.a as Expr, b.b as Expr) as {
        ok: true;
        a: unknown;
        b: unknown;
      };
      const av = typeof c.a === "bigint" ? Number(c.a) : (c.a as number);
      const bv = typeof c.b === "bigint" ? Number(c.b) : (c.b as number);
      return lit(fn(av, bv));
    },
  };
}

const FOLD_ADD = arithRule(
  "+",
  (a, b) => a + b,
  (a, b) => a + b,
);
const FOLD_SUB = arithRule(
  "-",
  (a, b) => a - b,
  (a, b) => a - b,
);
const FOLD_MUL = arithRule(
  "*",
  (a, b) => a * b,
  (a, b) => a * b,
);
const FOLD_DIV: RewriteRule = {
  name: "fold-/",
  headOp: "/",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "/") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    const c = bothConst(b.a as Expr, b.b as Expr);
    if (!c.ok) return false;
    if (typeof c.a === "bigint" && typeof c.b === "bigint") {
      return c.b !== 0n; // do not fold integer division by zero
    }
    if (
      (typeof c.a === "bigint" || typeof c.a === "number") &&
      (typeof c.b === "bigint" || typeof c.b === "number")
    ) {
      const av = typeof c.a === "bigint" ? Number(c.a) : c.a;
      const bv = typeof c.b === "bigint" ? Number(c.b) : c.b;
      return isFiniteNumber(av / bv);
    }
    return false;
  },
  rewrite(b) {
    const c = bothConst(b.a as Expr, b.b as Expr) as {
      ok: true;
      a: unknown;
      b: unknown;
    };
    if (typeof c.a === "bigint" && typeof c.b === "bigint") {
      return lit(c.a / c.b);
    }
    const av = typeof c.a === "bigint" ? Number(c.a) : (c.a as number);
    const bv = typeof c.b === "bigint" ? Number(c.b) : (c.b as number);
    return lit(av / bv);
  },
};

const FOLD_MOD: RewriteRule = {
  name: "fold-%",
  headOp: "%",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "%") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    const c = bothConst(b.a as Expr, b.b as Expr);
    if (!c.ok) return false;
    if (typeof c.a === "bigint" && typeof c.b === "bigint") {
      return c.b !== 0n;
    }
    if (
      (typeof c.a === "bigint" || typeof c.a === "number") &&
      (typeof c.b === "bigint" || typeof c.b === "number")
    ) {
      const av = typeof c.a === "bigint" ? Number(c.a) : c.a;
      const bv = typeof c.b === "bigint" ? Number(c.b) : c.b;
      return isFiniteNumber(av % bv);
    }
    return false;
  },
  rewrite(b) {
    const c = bothConst(b.a as Expr, b.b as Expr) as {
      ok: true;
      a: unknown;
      b: unknown;
    };
    if (typeof c.a === "bigint" && typeof c.b === "bigint") {
      return lit(c.a % c.b);
    }
    const av = typeof c.a === "bigint" ? Number(c.a) : (c.a as number);
    const bv = typeof c.b === "bigint" ? Number(c.b) : (c.b as number);
    return lit(av % bv);
  },
};

const FOLD_EQ: RewriteRule = {
  name: "fold-==",
  headOp: "==",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "==") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    return bothConst(b.a as Expr, b.b as Expr).ok;
  },
  rewrite(b) {
    const c = bothConst(b.a as Expr, b.b as Expr) as {
      ok: true;
      a: unknown;
      b: unknown;
    };
    return lit(deepEq(c.a, c.b));
  },
};

const FOLD_NEQ: RewriteRule = {
  name: "fold-!=",
  headOp: "!=",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "!=") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    return bothConst(b.a as Expr, b.b as Expr).ok;
  },
  rewrite(b) {
    const c = bothConst(b.a as Expr, b.b as Expr) as {
      ok: true;
      a: unknown;
      b: unknown;
    };
    return lit(!deepEq(c.a, c.b));
  },
};

const FOLD_LT = cmpRule("<", (a, b) => a < b);
const FOLD_LE = cmpRule("<=", (a, b) => a <= b);
const FOLD_GT = cmpRule(">", (a, b) => a > b);
const FOLD_GE = cmpRule(">=", (a, b) => a >= b);

const FOLD_NOT: RewriteRule = {
  name: "fold-not",
  headOp: "not",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 2 || e[0] !== "not") return null;
    return { a: e[1] as Expr };
  },
  where(b) {
    const c = asConst(b.a as Expr);
    return c.ok && typeof c.value === "boolean";
  },
  rewrite(b) {
    const c = asConst(b.a as Expr) as { ok: true; value: unknown };
    return lit(!(c.value as boolean));
  },
};

const FOLD_AND: RewriteRule = {
  name: "fold-and",
  headOp: "and",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "and") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    const c = asConst(b.a as Expr);
    return c.ok && typeof c.value === "boolean";
  },
  rewrite(b) {
    const c = asConst(b.a as Expr) as { ok: true; value: unknown };
    if (c.value === false) return lit(false);
    // c.value === true — short-circuit to right.
    return b.b as Expr;
  },
};

const FOLD_OR: RewriteRule = {
  name: "fold-or",
  headOp: "or",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "or") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    const c = asConst(b.a as Expr);
    return c.ok && typeof c.value === "boolean";
  },
  rewrite(b) {
    const c = asConst(b.a as Expr) as { ok: true; value: unknown };
    if (c.value === true) return lit(true);
    return b.b as Expr;
  },
};

const FOLD_IF: RewriteRule = {
  name: "fold-if",
  headOp: "if",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 4 || e[0] !== "if") return null;
    return { c: e[1] as Expr, t: e[2] as Expr, f: e[3] as Expr };
  },
  where(b) {
    const c = asConst(b.c as Expr);
    return c.ok && typeof c.value === "boolean";
  },
  rewrite(b) {
    const c = asConst(b.c as Expr) as { ok: true; value: unknown };
    return c.value === true ? (b.t as Expr) : (b.f as Expr);
  },
};

const FOLD_COND: RewriteRule = {
  name: "fold-cond",
  headOp: "cond",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e[0] !== "cond" || e.length < 2) return null;
    // Find the first clause whose test is a known constant true OR the "else" clause,
    // skipping any leading clauses whose test is constant false.
    for (let i = 1; i < e.length; i++) {
      const clause = e[i];
      if (!Array.isArray(clause) || clause.length !== 2) return null;
      const test = clause[0];
      if (test === "else") {
        return { body: clause[1] as Expr };
      }
      const c = asConst(test as Expr);
      if (!c.ok || typeof c.value !== "boolean") return null;
      if (c.value === true) {
        return { body: clause[1] as Expr };
      }
      // false — skip and continue
    }
    return null;
  },
  rewrite(b) {
    return b.body as Expr;
  },
};

// --- String folding ---

function strRule1(op: string, fn: (s: string) => unknown): RewriteRule {
  return {
    name: `fold-${op}`,
    headOp: op,
    reducing: true,
    match(e) {
      if (!Array.isArray(e) || e.length !== 2 || e[0] !== op) return null;
      return { a: e[1] as Expr };
    },
    where(b) {
      const c = asConst(b.a as Expr);
      return c.ok && typeof c.value === "string";
    },
    rewrite(b) {
      const c = asConst(b.a as Expr) as { ok: true; value: unknown };
      return lit(fn(c.value as string));
    },
  };
}

const FOLD_STR_LEN = strRule1("str-len", (s) => BigInt(s.length));

const FOLD_STR_CONCAT: RewriteRule = {
  name: "fold-str-concat",
  headOp: "str-concat",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "str-concat") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    const c = bothConst(b.a as Expr, b.b as Expr);
    return c.ok && typeof c.a === "string" && typeof c.b === "string";
  },
  rewrite(b) {
    const c = bothConst(b.a as Expr, b.b as Expr) as {
      ok: true;
      a: unknown;
      b: unknown;
    };
    return lit((c.a as string) + (c.b as string));
  },
};

const FOLD_STR_SLICE: RewriteRule = {
  name: "fold-str-slice",
  headOp: "str-slice",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 4 || e[0] !== "str-slice") return null;
    return { s: e[1] as Expr, a: e[2] as Expr, b: e[3] as Expr };
  },
  where(b) {
    const cs = asConst(b.s as Expr);
    const ca = asConst(b.a as Expr);
    const cb = asConst(b.b as Expr);
    return (
      cs.ok &&
      ca.ok &&
      cb.ok &&
      typeof cs.value === "string" &&
      (typeof ca.value === "bigint" || typeof ca.value === "number") &&
      (typeof cb.value === "bigint" || typeof cb.value === "number")
    );
  },
  rewrite(b) {
    const cs = asConst(b.s as Expr) as { ok: true; value: unknown };
    const ca = asConst(b.a as Expr) as { ok: true; value: unknown };
    const cb = asConst(b.b as Expr) as { ok: true; value: unknown };
    const start = typeof ca.value === "bigint" ? Number(ca.value) : (ca.value as number);
    const end = typeof cb.value === "bigint" ? Number(cb.value) : (cb.value as number);
    return lit((cs.value as string).slice(start, end));
  },
};

// --- Array / record / get ---

const FOLD_ARRAY: RewriteRule = {
  name: "fold-array",
  headOp: "array",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e[0] !== "array") return null;
    return { e: e as Expr };
  },
  where(b) {
    const e = b.e as Expr[];
    for (let i = 1; i < e.length; i++) {
      if (!asConst(e[i] as Expr).ok) return false;
    }
    return true;
  },
  rewrite(b) {
    const e = b.e as Expr[];
    const vals: unknown[] = [];
    for (let i = 1; i < e.length; i++) {
      vals.push((asConst(e[i] as Expr) as { ok: true; value: unknown }).value);
    }
    return lit(vals);
  },
};

const FOLD_GET: RewriteRule = {
  name: "fold-get",
  headOp: "get",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "get") return null;
    return { obj: e[1] as Expr, key: e[2] as Expr };
  },
  where(b) {
    const co = asConst(b.obj as Expr);
    const ck = asConst(b.key as Expr);
    if (!co.ok || !ck.ok) return false;
    // Only fold when the constant obj is a plain array or plain record literal.
    return (
      Array.isArray(co.value) ||
      (co.value !== null && typeof co.value === "object" && !Array.isArray(co.value))
    );
  },
  rewrite(b) {
    const co = asConst(b.obj as Expr) as { ok: true; value: unknown };
    const ck = asConst(b.key as Expr) as { ok: true; value: unknown };
    if (Array.isArray(co.value)) {
      const idx = typeof ck.value === "bigint" ? Number(ck.value) : (ck.value as number);
      if (idx < 0 || idx >= co.value.length) return lit(null);
      return lit((co.value[idx] as unknown) ?? null);
    }
    const k = String(ck.value);
    const obj = co.value as Record<string, unknown>;
    const v = obj[k];
    return lit(v === undefined ? null : v);
  },
};

// --- to-string ---

const FOLD_TO_STRING: RewriteRule = {
  name: "fold-to-string",
  headOp: "to-string",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 2 || e[0] !== "to-string") return null;
    return { a: e[1] as Expr };
  },
  where(b) {
    const c = asConst(b.a as Expr);
    if (!c.ok) return false;
    const v = c.value;
    return (
      v === null ||
      typeof v === "boolean" ||
      typeof v === "bigint" ||
      typeof v === "number" ||
      typeof v === "string"
    );
  },
  rewrite(b) {
    const c = asConst(b.a as Expr) as { ok: true; value: unknown };
    const v = c.value;
    if (v === null) return lit("null");
    if (typeof v === "boolean") return lit(v ? "true" : "false");
    if (typeof v === "bigint") return lit(v.toString());
    if (typeof v === "number") return lit(v.toString());
    return lit(v as string);
  },
};

// --- let dead-binding elimination + literal copy propagation ---

const FOLD_LET: RewriteRule = {
  name: "fold-let",
  headOp: "let",
  reducing: false, // dropping a binding is not strictly node-reducing under
  // single-rule retry (a re-fired rule would see no bindings); guarded by
  // termination check.
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "let") return null;
    const bindings = e[1];
    if (!Array.isArray(bindings) || bindings.length === 0) return null;
    return { e: e as Expr };
  },
  where(b) {
    const e = b.e as Expr[];
    const bindings = e[1] as Expr[];
    const body = e[2] as Expr;
    // Eligible if at least one binding can be eliminated or substituted.
    // Walk through bindings in order — once we find one to drop/substitute, fire.
    let restBody = body;
    // Walk in reverse to know "the body of the binding scope" for each binding.
    // Simpler: approximate — fire if the FIRST binding is droppable or literal-substitutable
    // when considered with its scope. We rebuild fully in rewrite.
    void restBody;
    for (let i = 0; i < bindings.length; i++) {
      const bb = bindings[i];
      if (!Array.isArray(bb) || bb.length !== 2) continue;
      const name = bb[0] as string;
      const val = bb[1] as Expr;
      // The "scope" for this binding is bindings[i+1..].vals followed by body.
      // For simplicity, if name not free in any later expr → droppable (if no effects).
      let usedLater = freeIn(name, body);
      for (let j = i + 1; !usedLater && j < bindings.length; j++) {
        const bj = bindings[j];
        if (Array.isArray(bj) && bj.length === 2) {
          if (freeIn(name, bj[1] as Expr)) usedLater = true;
        }
      }
      if (!usedLater && !hasEffects(val)) return true;
      if (isLit(val)) return true;
    }
    return false;
  },
  rewrite(b) {
    const e = b.e as Expr[];
    const bindings = (e[1] as Expr[]).slice();
    let body = e[2] as Expr;

    // Process from the END so that substituting earlier preserves shadowing semantics.
    // We'll build a list of remaining bindings in order.
    const kept: Expr[] = [];
    // Walk forward; for each binding, decide drop / substitute / keep.
    // Substituting requires propagating into later bindings' values AND body.
    for (let i = 0; i < bindings.length; i++) {
      const bb = bindings[i];
      if (!Array.isArray(bb) || bb.length !== 2) {
        kept.push(bb as Expr);
        continue;
      }
      const name = bb[0] as string;
      const val = bb[1] as Expr;

      // Compute "rest scope": later bindings (with current `kept` already fixed) + body.
      let usedLater = freeIn(name, body);
      const laterBindings = bindings.slice(i + 1);
      for (let j = 0; !usedLater && j < laterBindings.length; j++) {
        const bj = laterBindings[j];
        if (Array.isArray(bj) && bj.length === 2) {
          if (freeIn(name, bj[1] as Expr)) usedLater = true;
        }
      }

      if (!usedLater && !hasEffects(val)) {
        // Drop this binding entirely.
        continue;
      }

      if (isLit(val)) {
        // Substitute name → val in later bindings' values and in body.
        for (let j = i + 1; j < bindings.length; j++) {
          const bj = bindings[j];
          if (Array.isArray(bj) && bj.length === 2) {
            const bjName = bj[0] as string;
            // Stop substituting once a later binding shadows this name.
            if (bjName === name) break;
            bindings[j] = [bjName, substitute(bj[1] as Expr, name, val)] as Expr;
          }
        }
        body = substitute(body, name, val);
        // Drop the binding (its uses have been inlined).
        continue;
      }

      kept.push([name, val] as Expr);
    }

    if (kept.length === 0) return body;
    return ["let", kept as Expr, body];
  },
};

export const CONSTANT_FOLDING_RULES: RewriteRule[] = [
  FOLD_ADD,
  FOLD_SUB,
  FOLD_MUL,
  FOLD_DIV,
  FOLD_MOD,
  FOLD_EQ,
  FOLD_NEQ,
  FOLD_LT,
  FOLD_LE,
  FOLD_GT,
  FOLD_GE,
  FOLD_NOT,
  FOLD_AND,
  FOLD_OR,
  FOLD_IF,
  FOLD_COND,
  FOLD_STR_LEN,
  FOLD_STR_CONCAT,
  FOLD_STR_SLICE,
  FOLD_ARRAY,
  FOLD_GET,
  FOLD_TO_STRING,
  FOLD_LET,
];

// --- Tree-automaton driver ---

/** Index rules by their `headOp` for O(1) dispatch. */
function indexRules(rules: RewriteRule[]): Map<string, RewriteRule[]> {
  const m = new Map<string, RewriteRule[]>();
  for (const r of rules) {
    const arr = m.get(r.headOp);
    if (arr) arr.push(r);
    else m.set(r.headOp, [r]);
  }
  return m;
}

/** Recursively optimize children of `expr` (post-order), then return a new
 * expression with optimized children. Returns the input unchanged when no
 * structure recursion applies. */
function optimizeChildren(
  expr: Expr,
  index: Map<string, RewriteRule[]>,
  fired: WeakMap<object, Set<string>>,
  typeInfo?: TypeInfo,
): Expr {
  if (!Array.isArray(expr) || expr.length === 0) return expr;
  const op = expr[0];
  if (typeof op !== "string") {
    return expr.map((e) => optimizeNode(e as Expr, index, fired, typeInfo)) as Expr;
  }

  switch (op) {
    case "__lit":
      return expr;
    case "fn":
    case "fn-once":
      return [op, expr[1] as Expr, optimizeNode(expr[2] as Expr, index, fired, typeInfo)];
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const newBindings = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, optimizeNode(b[1] as Expr, index, fired, typeInfo)] as Expr;
      });
      return ["let", newBindings as Expr, optimizeNode(expr[2] as Expr, index, fired, typeInfo)];
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const newBindings = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, optimizeNode(b[1] as Expr, index, fired, typeInfo)] as Expr;
      });
      return ["letrec", newBindings as Expr, optimizeNode(expr[2] as Expr, index, fired, typeInfo)];
    }
    case "match": {
      const out: Expr[] = [op, optimizeNode(expr[1] as Expr, index, fired, typeInfo)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        out.push([
          clause[0] as Expr,
          optimizeNode(clause[1] as Expr, index, fired, typeInfo),
        ] as Expr);
      }
      return out;
    }
    case "handle": {
      const out: Expr[] = [op, optimizeNode(expr[1] as Expr, index, fired, typeInfo)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        out.push([
          clause[0] as Expr,
          optimizeNode(clause[1] as Expr, index, fired, typeInfo),
        ] as Expr);
      }
      return out;
    }
    case "cond": {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        const test = clause[0];
        const body = clause[1] as Expr;
        const newTest =
          test === "else" ? "else" : optimizeNode(test as Expr, index, fired, typeInfo);
        out.push([newTest as Expr, optimizeNode(body, index, fired, typeInfo)] as Expr);
      }
      return out;
    }
    case "__loop": {
      const params = expr[1] as Expr;
      const initArgs = expr[2];
      const body = expr[3] as Expr;
      const newInit = Array.isArray(initArgs)
        ? (initArgs.map((a) => optimizeNode(a as Expr, index, fired, typeInfo)) as Expr)
        : (initArgs as Expr);
      return [op, params, newInit, optimizeNode(body, index, fired, typeInfo)];
    }
    case "__continue":
      return [op, ...expr.slice(1).map((e) => optimizeNode(e as Expr, index, fired, typeInfo))];
    case "perform":
      // ["perform", tagString, payload]
      if (expr.length === 3) {
        return [op, expr[1] as Expr, optimizeNode(expr[2] as Expr, index, fired, typeInfo)];
      }
      return expr;
    default: {
      // Generic call: optimize all args; op stays as-is.
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) {
        out.push(optimizeNode(expr[i] as Expr, index, fired, typeInfo));
      }
      return out;
    }
  }
}

/** Apply rules to `expr` to fixed-point at this position, after children are
 * already optimized. Returns the rewritten expression. */
function applyRulesAtNode(
  expr: Expr,
  index: Map<string, RewriteRule[]>,
  fired: WeakMap<object, Set<string>>,
  typeInfo?: TypeInfo,
): Expr {
  let current = expr;
  // Cap iterations as a sanity backstop. A correct rule set with `reducing: true`
  // strictly reduces some metric and `reducing: false` rules are guarded; the
  // termination guard below catches the common rule-authoring bugs.
  for (let iter = 0; iter < 1000; iter++) {
    if (!Array.isArray(current) || current.length === 0) return current;
    const op = current[0];
    if (typeof op !== "string") return current;
    const candidates = index.get(op);
    if (!candidates) return current;

    let fireResult: Expr | null = null;
    let firedRule: RewriteRule | null = null;
    for (const rule of candidates) {
      const bindings = rule.match(current);
      if (bindings === null) continue;
      if (rule.where && !rule.where(bindings, typeInfo)) continue;

      if (!rule.reducing) {
        // Guard: if this rule has already fired at this node identity, error.
        const key = current as unknown as object;
        const set = fired.get(key);
        if (set && set.has(rule.name)) continue;
      }

      const next = rule.rewrite(bindings);

      if (!rule.reducing) {
        const key = current as unknown as object;
        let set = fired.get(key);
        if (!set) {
          set = new Set();
          fired.set(key, set);
        }
        set.add(rule.name);
      }

      // Termination guard for `reducing: true` rules: if rewrite produced a
      // structurally identical (===) node under the same rule, that's a bug.
      if (rule.reducing && next === current) {
        throw new Error(
          `RewriteRule '${rule.name}' fired but produced the same node — ` +
            `non-reducing rule marked as reducing`,
        );
      }

      // If the result is itself a non-trivial expression, optimize its children
      // (the rewrite may have inserted unoptimized sub-trees, e.g. `if-fold`
      // returning a branch verbatim — already optimized — so this is cheap).
      // We don't recurse children here for `if`/`and`/`or`/`let` rewrites
      // because they return already-optimized sub-trees from the input.
      fireResult = next;
      firedRule = rule;
      break;
    }

    if (fireResult === null) return current;
    void firedRule;
    current = fireResult;
    // Loop: re-check rules at the new node.
  }
  throw new Error("optimizer: rule application did not terminate within 1000 iterations");
}

function optimizeNode(
  expr: Expr,
  index: Map<string, RewriteRule[]>,
  fired: WeakMap<object, Set<string>>,
  typeInfo?: TypeInfo,
): Expr {
  // Post-order: optimize children first.
  const withChildren = optimizeChildren(expr, index, fired, typeInfo);
  return applyRulesAtNode(withChildren, index, fired, typeInfo);
}

/**
 * Optimize a Marinada expression by applying rewrite rules bottom-up
 * (post-order, fixed-point per node).
 *
 * Pure: never mutates `expr`.
 */
export function optimize(expr: Expr, rules: RewriteRule[], typeInfo?: TypeInfo): Expr {
  if (rules.length === 0) return expr;
  const index = indexRules(rules);
  const fired: WeakMap<object, Set<string>> = new WeakMap();
  return optimizeNode(expr, index, fired, typeInfo);
}

// --- Phase 6: function inlining ---
//
// Inlines `let`-bound (or `letrec`-bound) functions at single call sites when
// the body is small, pure, and non-looping. This is intentionally surgical:
// only fires when it's clearly beneficial (no code duplication, no effect
// reordering, no loop unrolling). Tiny lib:std combinators like `identity`,
// `const`, and `flip` qualify; recursive helpers (`map`, `filter`, etc.) do
// not because their bodies contain `letrec`.

const INLINE_SIZE_THRESHOLD = 10;

/** Count AST nodes in `expr` (atoms count as 1). */
function astSize(expr: Expr): number {
  if (!Array.isArray(expr)) return 1;
  let n = 1;
  for (const c of expr) n += astSize(c as Expr);
  return n;
}

/** True if `body` qualifies as a "small, non-looping, pure" function body
 * suitable for inlining. */
function isInlineableBody(body: Expr): boolean {
  if (hasEffects(body)) return false;
  if (containsBlocked(body)) return false;
  if (astSize(body) > INLINE_SIZE_THRESHOLD) return false;
  return true;
}

/** True if `expr` contains any construct that disqualifies inlining:
 * `letrec` (loops), nested `call` to another function (one-level limit),
 * `perform`, `handle`, `__loop`, `__continue`. */
function containsBlocked(expr: Expr): boolean {
  if (!Array.isArray(expr) || expr.length === 0) return false;
  const op = expr[0];
  if (typeof op === "string") {
    if (
      op === "letrec" ||
      op === "perform" ||
      op === "handle" ||
      op === "__loop" ||
      op === "__continue" ||
      op === "call"
    ) {
      return true;
    }
  }
  for (let i = 1; i < expr.length; i++) {
    if (containsBlocked(expr[i] as Expr)) return true;
  }
  return false;
}

/** Count call sites of the form `["call", name, ...]` referencing `name` as a
 * bare variable. Also counts other free uses of `name` (in non-call position),
 * since those would prevent inlining (the function escapes). Returns
 * { calls, otherUses } so callers can require otherUses === 0 and calls === 1. */
function countUses(name: string, expr: Expr): { calls: number; otherUses: number } {
  let calls = 0;
  let otherUses = 0;
  function visit(e: Expr, asCallee: boolean): void {
    if (typeof e === "string") {
      if (e === name && !asCallee) otherUses++;
      return;
    }
    if (!Array.isArray(e) || e.length === 0) return;
    const op = e[0];
    if (typeof op !== "string") {
      for (const c of e) visit(c as Expr, false);
      return;
    }
    switch (op) {
      case "__lit":
        return;
      case "fn":
      case "fn-once": {
        const ps = paramNames(e[1] as Expr);
        if (ps.includes(name)) return;
        visit(e[2] as Expr, false);
        return;
      }
      case "let": {
        const bindings = e[1];
        if (!Array.isArray(bindings)) return;
        let shadowed = false;
        for (const b of bindings) {
          if (!Array.isArray(b) || b.length !== 2) continue;
          if (!shadowed) visit(b[1] as Expr, false);
          if (b[0] === name) shadowed = true;
        }
        if (!shadowed) visit(e[2] as Expr, false);
        return;
      }
      case "letrec": {
        const bindings = e[1];
        if (!Array.isArray(bindings)) return;
        const names = bindings
          .map((b) => (Array.isArray(b) ? b[0] : null))
          .filter((n): n is string => typeof n === "string");
        if (names.includes(name)) return;
        for (const b of bindings) {
          if (!Array.isArray(b) || b.length !== 2) continue;
          visit(b[1] as Expr, false);
        }
        visit(e[2] as Expr, false);
        return;
      }
      case "match":
      case "handle": {
        visit(e[1] as Expr, false);
        for (let i = 2; i < e.length; i++) {
          const clause = e[i];
          if (!Array.isArray(clause) || clause.length !== 2) continue;
          const pattern = clause[0];
          const body = clause[1] as Expr;
          const bound = Array.isArray(pattern)
            ? pattern.slice(1).filter((s): s is string => typeof s === "string")
            : [];
          if (!bound.includes(name)) visit(body, false);
        }
        return;
      }
      case "__loop": {
        const ps = paramNames(e[1] as Expr);
        const initArgs = e[2];
        if (Array.isArray(initArgs)) {
          for (const a of initArgs) visit(a as Expr, false);
        }
        if (!ps.includes(name)) visit(e[3] as Expr, false);
        return;
      }
      case "call": {
        // First arg is the callee.
        if (e.length >= 2) {
          const callee = e[1];
          if (typeof callee === "string" && callee === name) {
            calls++;
          } else {
            visit(callee as Expr, false);
          }
          for (let i = 2; i < e.length; i++) visit(e[i] as Expr, false);
        }
        return;
      }
      default:
        for (let i = 1; i < e.length; i++) visit(e[i] as Expr, false);
        return;
    }
  }
  visit(expr, false);
  return { calls, otherUses };
}

/** Generate a fresh name based on `base` not in `taken`. Mutates `taken` to
 * include the result. */
function freshName(base: string, taken: Set<string>): string {
  let i = 0;
  let candidate = `${base}__inl${i}`;
  while (taken.has(candidate)) {
    i++;
    candidate = `${base}__inl${i}`;
  }
  taken.add(candidate);
  return candidate;
}

/** Collect every name that appears (free or bound) in `expr` — used to seed
 * the `taken` set for fresh-name generation during alpha-renaming. */
function collectAllNames(expr: Expr, out: Set<string>): void {
  if (typeof expr === "string") {
    out.add(expr);
    return;
  }
  if (!Array.isArray(expr) || expr.length === 0) return;
  const op = expr[0];
  if (typeof op === "string") {
    switch (op) {
      case "__lit":
        return;
      case "fn":
      case "fn-once": {
        for (const n of paramNames(expr[1] as Expr)) out.add(n);
        collectAllNames(expr[2] as Expr, out);
        return;
      }
      case "let":
      case "letrec": {
        const bindings = expr[1];
        if (Array.isArray(bindings)) {
          for (const b of bindings) {
            if (Array.isArray(b) && b.length === 2) {
              if (typeof b[0] === "string") out.add(b[0]);
              collectAllNames(b[1] as Expr, out);
            }
          }
        }
        collectAllNames(expr[2] as Expr, out);
        return;
      }
    }
  }
  for (let i = 1; i < expr.length; i++) collectAllNames(expr[i] as Expr, out);
}

/** Alpha-rename all bound variables in `expr` to fresh names not in `taken`.
 * Free variables are left alone. Used before substitution to prevent capture. */
function alphaRename(expr: Expr, taken: Set<string>, env: Map<string, string>): Expr {
  if (typeof expr === "string") {
    const r = env.get(expr);
    return r === undefined ? expr : r;
  }
  if (!Array.isArray(expr) || expr.length === 0) return expr;
  const op = expr[0];
  if (typeof op !== "string") {
    return expr.map((e) => alphaRename(e as Expr, taken, env)) as Expr;
  }

  switch (op) {
    case "__lit":
      return expr;
    case "fn":
    case "fn-once": {
      const params = expr[1];
      const newEnv = new Map(env);
      let newParams: Expr;
      if (Array.isArray(params)) {
        newParams = params.map((p) => {
          if (typeof p === "string") {
            const fresh = freshName(p, taken);
            newEnv.set(p, fresh);
            return fresh;
          }
          if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") {
            const fresh = freshName(p[0], taken);
            newEnv.set(p[0], fresh);
            return [fresh, ...p.slice(1)] as Expr;
          }
          return p as Expr;
        }) as Expr;
      } else {
        newParams = params as Expr;
      }
      return [op, newParams, alphaRename(expr[2] as Expr, taken, newEnv)];
    }
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const currentEnv = new Map(env);
      const newBindings: Expr[] = [];
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) {
          newBindings.push(b as Expr);
          continue;
        }
        const bName = b[0] as string;
        const newVal = alphaRename(b[1] as Expr, taken, currentEnv);
        const fresh = freshName(bName, taken);
        currentEnv.set(bName, fresh);
        newBindings.push([fresh, newVal] as Expr);
      }
      return ["let", newBindings as Expr, alphaRename(expr[2] as Expr, taken, currentEnv)];
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const newEnv = new Map(env);
      const renamed: string[] = [];
      for (const b of bindings) {
        if (Array.isArray(b) && b.length === 2 && typeof b[0] === "string") {
          const fresh = freshName(b[0], taken);
          newEnv.set(b[0], fresh);
          renamed.push(fresh);
        } else {
          renamed.push("");
        }
      }
      const newBindings: Expr[] = bindings.map((b, i) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [renamed[i] as string, alphaRename(b[1] as Expr, taken, newEnv)] as Expr;
      });
      return ["letrec", newBindings as Expr, alphaRename(expr[2] as Expr, taken, newEnv)];
    }
    case "match":
    case "handle": {
      const out: Expr[] = [op, alphaRename(expr[1] as Expr, taken, env)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        const pattern = clause[0] as Expr;
        const body = clause[1] as Expr;
        const newEnv = new Map(env);
        let newPattern: Expr = pattern;
        if (Array.isArray(pattern)) {
          newPattern = [
            pattern[0],
            ...pattern.slice(1).map((p) => {
              if (typeof p === "string") {
                const fresh = freshName(p, taken);
                newEnv.set(p, fresh);
                return fresh;
              }
              return p as Expr;
            }),
          ] as Expr;
        }
        out.push([newPattern, alphaRename(body, taken, newEnv)] as Expr);
      }
      return out;
    }
    case "__loop": {
      const params = expr[1];
      const initArgs = expr[2];
      const newInit = Array.isArray(initArgs)
        ? (initArgs.map((a) => alphaRename(a as Expr, taken, env)) as Expr)
        : (initArgs as Expr);
      const newEnv = new Map(env);
      let newParams: Expr;
      if (Array.isArray(params)) {
        newParams = params.map((p) => {
          if (typeof p === "string") {
            const fresh = freshName(p, taken);
            newEnv.set(p, fresh);
            return fresh;
          }
          return p as Expr;
        }) as Expr;
      } else {
        newParams = params as Expr;
      }
      return [op, newParams, newInit, alphaRename(expr[3] as Expr, taken, newEnv)];
    }
    default:
      return expr.map((e) => alphaRename(e as Expr, taken, env)) as Expr;
  }
}

/** Inline `["call", name, arg1, ...]` where `fn = ["fn", params, body]`,
 * by substituting params with args in an alpha-renamed body. Returns null if
 * arity doesn't match. */
function inlineCall(fn: Expr, args: Expr[], outerTaken: Set<string>): Expr | null {
  if (!Array.isArray(fn) || fn[0] !== "fn") return null;
  const params = fn[1];
  const body = fn[2] as Expr;
  if (!Array.isArray(params)) return null;
  const paramNs: string[] = [];
  for (const p of params) {
    if (typeof p === "string") paramNs.push(p);
    else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") paramNs.push(p[0]);
    else return null;
  }
  if (paramNs.length !== args.length) return null;

  // Build the taken set: outerTaken ∪ all names in body ∪ all names in args.
  const taken = new Set(outerTaken);
  collectAllNames(body, taken);
  for (const a of args) collectAllNames(a, taken);
  for (const p of paramNs) taken.add(p);

  // Alpha-rename the body so its bound names don't collide with anything.
  // We start with a fresh env: params keep their original names so we can
  // substitute them, but the rest of the body's bound vars get fresh names.
  // To do this cleanly: alpha-rename, but seed env with identity for params.
  // Simpler: alpha-rename the whole body; params get renamed too; track their
  // new names; then substitute new-param-name → arg.
  const env = new Map<string, string>();
  const renamedBody = alphaRename(body, taken, env);
  // After alphaRename, params have been renamed. But we built `env` empty —
  // alphaRename traverses from the top; since `body` is the raw fn body, its
  // free uses of params won't be in `env` yet. We need to rename the params
  // explicitly first.
  // Simpler approach: do it manually here.
  const env2 = new Map<string, string>();
  const newParamNames: string[] = [];
  for (const p of paramNs) {
    const fresh = freshName(p, taken);
    env2.set(p, fresh);
    newParamNames.push(fresh);
  }
  const renamed = alphaRename(body, taken, env2);
  void renamedBody;

  // Substitute fresh param name → arg in `renamed`.
  let result = renamed;
  for (let i = 0; i < newParamNames.length; i++) {
    result = substitute(result, newParamNames[i] as string, args[i] as Expr);
  }
  return result;
}

/** Walk `expr` and inline single-use small functions bound by `let`/`letrec`. */
export function inlineSmallFunctions(expr: Expr): Expr {
  if (!Array.isArray(expr) || expr.length === 0) return expr;
  const op = expr[0];
  if (typeof op !== "string") {
    return expr.map((e) => inlineSmallFunctions(e as Expr)) as Expr;
  }

  // First, recurse into children.
  const recurseChildren = (e: Expr): Expr => inlineSmallFunctions(e);

  switch (op) {
    case "__lit":
      return expr;
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      // Optimize children first.
      const newBindings: Expr[] = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, recurseChildren(b[1] as Expr)] as Expr;
      });
      let body = recurseChildren(expr[2] as Expr);

      // Now scan bindings (in scope order) for inlineable small functions.
      // Build the "scope after binding i" — for simplicity, only handle
      // bindings whose scope is exactly `body` (i.e. last binding, or none of
      // the later bindings reference the candidate). Conservative but covers
      // the common case.
      const kept: Expr[] = [];
      for (let i = 0; i < newBindings.length; i++) {
        const b = newBindings[i];
        if (!Array.isArray(b) || b.length !== 2) {
          kept.push(b as Expr);
          continue;
        }
        const name = b[0] as string;
        const val = b[1] as Expr;

        // Candidate iff val is ["fn", params, fnBody] with small/pure/no-loop body.
        if (
          !Array.isArray(val) ||
          val[0] !== "fn" ||
          !Array.isArray(val[1]) ||
          !isInlineableBody(val[2] as Expr)
        ) {
          kept.push(b as Expr);
          continue;
        }

        // Determine scope: later bindings' values + body. To keep things
        // simple and safe, only inline if the candidate is unused in the
        // remaining bindings (i.e. only used in `body`).
        let usedInLater = false;
        for (let j = i + 1; j < newBindings.length; j++) {
          const bj = newBindings[j];
          if (Array.isArray(bj) && bj.length === 2 && freeIn(name, bj[1] as Expr)) {
            usedInLater = true;
            break;
          }
        }
        if (usedInLater) {
          kept.push(b as Expr);
          continue;
        }

        const { calls, otherUses } = countUses(name, body);
        if (otherUses !== 0 || calls !== 1) {
          kept.push(b as Expr);
          continue;
        }

        // Inline: replace the single ["call", name, ...args] call site in body.
        const inlined = replaceCall(body, name, val);
        if (inlined === null) {
          kept.push(b as Expr);
          continue;
        }
        body = inlined;
        // Drop the binding (its single use has been inlined).
      }

      if (kept.length === 0) return body;
      return ["let", kept as Expr, body];
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const newBindings: Expr[] = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, recurseChildren(b[1] as Expr)] as Expr;
      });
      const body = recurseChildren(expr[2] as Expr);
      // letrec bindings can be self/mutually recursive, which usually means a
      // letrec body — disqualifying for inlining. Be conservative: don't
      // inline letrec bindings here.
      return ["letrec", newBindings as Expr, body];
    }
    case "fn":
    case "fn-once":
      return [op, expr[1] as Expr, recurseChildren(expr[2] as Expr)];
    case "match":
    case "handle": {
      const out: Expr[] = [op, recurseChildren(expr[1] as Expr)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        out.push([clause[0] as Expr, recurseChildren(clause[1] as Expr)] as Expr);
      }
      return out;
    }
    case "__loop": {
      const initArgs = expr[2];
      const newInit = Array.isArray(initArgs)
        ? (initArgs.map((a) => recurseChildren(a as Expr)) as Expr)
        : (initArgs as Expr);
      return [op, expr[1] as Expr, newInit, recurseChildren(expr[3] as Expr)];
    }
    default: {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) out.push(recurseChildren(expr[i] as Expr));
      return out;
    }
  }
}

/** Find the (single) `["call", name, ...args]` site in `expr` and replace it
 * with the inlined body. Returns null if not found or shadowing prevents
 * substitution. */
function replaceCall(expr: Expr, name: string, fn: Expr): Expr | null {
  // Build the outer "taken" set once (names visible at the inline site
  // matters for fresh-name generation). We approximate by collecting all names
  // in `expr` plus the function body itself.
  const taken = new Set<string>();
  collectAllNames(expr, taken);
  collectAllNames(fn, taken);

  let replaced = false;
  function go(e: Expr): Expr {
    if (replaced) return e;
    if (typeof e === "string") return e;
    if (!Array.isArray(e) || e.length === 0) return e;
    const op = e[0];
    if (typeof op !== "string") return e.map(go) as Expr;
    // Stop at scopes that shadow `name`.
    switch (op) {
      case "__lit":
        return e;
      case "fn":
      case "fn-once": {
        const ps = paramNames(e[1] as Expr);
        if (ps.includes(name)) return e;
        return [op, e[1] as Expr, go(e[2] as Expr)];
      }
      case "let": {
        const bindings = e[1];
        if (!Array.isArray(bindings)) return e;
        const newBindings: Expr[] = [];
        let shadowed = false;
        for (const b of bindings) {
          if (!Array.isArray(b) || b.length !== 2) {
            newBindings.push(b as Expr);
            continue;
          }
          const bName = b[0] as string;
          const newVal = shadowed ? (b[1] as Expr) : go(b[1] as Expr);
          newBindings.push([bName, newVal] as Expr);
          if (bName === name) shadowed = true;
        }
        const newBody = shadowed ? (e[2] as Expr) : go(e[2] as Expr);
        return ["let", newBindings as Expr, newBody];
      }
      case "letrec": {
        const bindings = e[1];
        if (!Array.isArray(bindings)) return e;
        const ns = bindings
          .map((b) => (Array.isArray(b) ? b[0] : null))
          .filter((n): n is string => typeof n === "string");
        if (ns.includes(name)) return e;
        const newBindings = bindings.map((b) => {
          if (!Array.isArray(b) || b.length !== 2) return b as Expr;
          return [b[0] as string, go(b[1] as Expr)] as Expr;
        });
        return ["letrec", newBindings as Expr, go(e[2] as Expr)];
      }
      case "call": {
        if (e.length >= 2 && e[1] === name) {
          const args = e.slice(2) as Expr[];
          // Recurse into args first (they may contain unrelated work).
          const argsGo = args.map(go);
          const inlined = inlineCall(fn, argsGo, taken);
          if (inlined !== null) {
            replaced = true;
            return inlined;
          }
          return [op, e[1] as Expr, ...argsGo] as Expr;
        }
        return e.map(go) as Expr;
      }
      default:
        return e.map(go) as Expr;
    }
  }
  const result = go(expr);
  return replaced ? result : null;
}

// Re-export helpers for tests.
export const __test__ = {
  freeIn,
  hasEffects,
  substitute,
  asConst,
  inlineSmallFunctions,
  countUses,
  isInlineableBody,
};
