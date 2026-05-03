import type { Expr } from "./types.ts";
import type { TypeInfo } from "./typecheck.ts";

export type RewriteRule = {
  name: string;
  /** The op at the rule's root — used for indexing into the rule table. */
  headOp: string;
  // More fields TBD in Phase 1 (match pattern, rewrite function, etc.)
};

/**
 * Optimize a Marinada expression by applying rewrite rules.
 * Phase 0: identity — no optimization logic yet. Infrastructure only.
 */
export function optimize(expr: Expr, _rules: RewriteRule[], _typeInfo?: TypeInfo): Expr {
  return expr;
}
