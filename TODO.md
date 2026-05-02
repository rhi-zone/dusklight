# TODO

### [ ] Marinada: implement linearity enforcement

Type representation (`{ kind: "linear"; inner: MType }`) exists in typecheck.ts:17 but has zero enforcement. No use-once validation, no affine/linear distinction, no destructor mechanism. Spec: docs/marinada.md lines 507-551.

### [x] Marinada: add perform/handle cases to typechecker

`perform` and `handle` are fully implemented in the evaluator (evaluate.ts:1357-1432) including multi-shot continuations, but typecheck.ts has no cases for them — they fall through to UNKNOWN_OP. Any effectful code fails typecheck unless wrapped in `["untyped", ...]`.

### [ ] Marinada: implement local: and https: module import schemes

module.ts:25 skips all non-lib:std imports. `local:` and `https:` schemes parse without error but names stay unbound. typecheck.ts:1373 types all such imports as UNKNOWN. Only `lib:std` is functional.

### [x] Marinada: add `cond` to evaluator

`cond` is handled in typecheck.ts but has no case in evaluate.ts — inverse of the perform/handle gap.

### [ ] Marinada: consider `$` prefix for pattern bindings (from defocus)

Lowercase-string-as-binding in `match` has a latent bug: `["match", x, ["friendly", body]]` binds `"friendly"` as a variable instead of matching the literal string. This hasn't surfaced in Dusklight because variant tags are uppercase, but defocus hit it immediately when matching plain string payloads.

defocus adopted `$`-prefixed bindings (`"$x"`) to resolve the ambiguity. Consider aligning Marinada — `_` for wildcard, `$name` for bindings, everything else is literal. Breaking change: audit existing `match` expressions in Dusklight for lowercase bindings that would need `$` prefix.

### [x] Update CLAUDE.md — corrections as documentation lag (2026-03-29)

Add to the corrections section:
> **Corrections are documentation lag, not model failure.** When the same mistake recurs, the fix is writing the invariant down — not repeating the correction. Every correction that doesn't produce a CLAUDE.md edit will happen again. Exception: during active design, corrections are the work itself — don't prematurely document a design that hasn't settled yet.

Add to the Session Handoff section:
> **Initiate a handoff after a significant mid-session correction.** When a correction happens after substantial wrong-path work, the wrong reasoning is still in context and keeps pulling. Writing down the invariant and starting fresh beats continuing with poisoned context — the next session loads the invariant from turn 1 before any wrong reasoning exists.

Conventional commit: `docs: add corrections-as-documentation-lag + context-poisoning handoff rule`
