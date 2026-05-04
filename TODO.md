# TODO

### [x] Marinada: implement linearity enforcement

Type representation (`{ kind: "linear"; inner: MType }`) exists in typecheck.ts:17 but has zero enforcement. No use-once validation, no affine/linear distinction, no destructor mechanism. Spec: docs/marinada.md lines 507-551.

### [x] Marinada: add perform/handle cases to typechecker

`perform` and `handle` are fully implemented in the evaluator (evaluate.ts:1357-1432) including multi-shot continuations, but typecheck.ts has no cases for them — they fall through to UNKNOWN_OP. Any effectful code fails typecheck unless wrapped in `["untyped", ...]`.

### [x] Marinada: JIT optimizer — see through lib:std for collection functions

map/filter/reduce were removed from the primitive set and are now proper lib:std letrec expressions, but the JIT no longer emits native JS Array.prototype.map/filter/reduce for them. The spec says the compiler should pattern-match on the lib:std AST and emit optimized code (constant folding, loop fusion). Without this, collection-heavy expressions are slower than before.

### [ ] Marinada: implement local: and https: module import schemes

module.ts:25 skips all non-lib:std imports. `local:` and `https:` schemes parse without error but names stay unbound. typecheck.ts:1373 types all such imports as UNKNOWN. Only `lib:std` is functional.

### [x] Marinada: add `cond` to evaluator

`cond` is handled in typecheck.ts but has no case in evaluate.ts — inverse of the perform/handle gap.

### [x] Marinada: enforce linearity on closure capture via fn-once annotation

Regular `fn` now errors (`LINEAR_CAPTURED_BY_FN`) if it captures an outer explicit-linear value. A new `fn-once` op declares the closure is called exactly once; the linearity pass counts each outer linear capture as 1 use at the `fn-once` expression site. `fn-once` typechecks and evaluates identically to `fn`.

### [x] Marinada: enforce linearity in `letrec` mutual recursion

The linearity pass now errors (`LINEAR_IN_LETREC`) if any outer explicit-linear value is referenced in a `letrec` RHS. Linear values may only appear in `let` (non-recursive) bindings.

### [x] Marinada: error on unhandled effects at module scope

`perform` without an enclosing `handle` currently typechecks — the effect row floats up with no top-level constraint. Module-level main expressions should be constrained to a pure (empty) effect row, so unhandled effects are caught at the boundary rather than silently accepted.

### [ ] Marinada: match only works on variants — no literal pattern matching

`match` in the evaluator only handles variant destructuring (evaluate.ts:1317 checks `scrutVal.kind !== "variant"`). There is no literal string/int/bool pattern matching. The pattern structure is always `[tag, binding1, binding2, ...]` — the tag is always matched as a variant tag, the rest always bound as variables. No ambiguity exists.

If literal pattern matching is needed (e.g. matching on a plain string payload), `match` needs to be extended — or use `cond` with `==` comparisons instead. The `$` prefix idea from defocus is not applicable here since Marinada's `match` is variant-only.

### [x] Update CLAUDE.md — corrections as documentation lag (2026-03-29)

Add to the corrections section:
> **Corrections are documentation lag, not model failure.** When the same mistake recurs, the fix is writing the invariant down — not repeating the correction. Every correction that doesn't produce a CLAUDE.md edit will happen again. Exception: during active design, corrections are the work itself — don't prematurely document a design that hasn't settled yet.

Add to the Session Handoff section:
> **Initiate a handoff after a significant mid-session correction.** When a correction happens after substantial wrong-path work, the wrong reasoning is still in context and keeps pulling. Writing down the invariant and starting fresh beats continuing with poisoned context — the next session loads the invariant from turn 1 before any wrong reasoning exists.

Conventional commit: `docs: add corrections-as-documentation-lag + context-poisoning handoff rule`
