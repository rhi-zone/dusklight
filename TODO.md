# TODO

### [ ] Marinada: consider `$` prefix for pattern bindings (from defocus)

Lowercase-string-as-binding in `match` has a latent bug: `["match", x, ["friendly", body]]` binds `"friendly"` as a variable instead of matching the literal string. This hasn't surfaced in Dusklight because variant tags are uppercase, but defocus hit it immediately when matching plain string payloads.

defocus adopted `$`-prefixed bindings (`"$x"`) to resolve the ambiguity. Consider aligning Marinada — `_` for wildcard, `$name` for bindings, everything else is literal. Breaking change: audit existing `match` expressions in Dusklight for lowercase bindings that would need `$` prefix.

### [x] Update CLAUDE.md — corrections as documentation lag (2026-03-29)

Add to the corrections section:
> **Corrections are documentation lag, not model failure.** When the same mistake recurs, the fix is writing the invariant down — not repeating the correction. Every correction that doesn't produce a CLAUDE.md edit will happen again. Exception: during active design, corrections are the work itself — don't prematurely document a design that hasn't settled yet.

Add to the Session Handoff section:
> **Initiate a handoff after a significant mid-session correction.** When a correction happens after substantial wrong-path work, the wrong reasoning is still in context and keeps pulling. Writing down the invariant and starting fresh beats continuing with poisoned context — the next session loads the invariant from turn 1 before any wrong reasoning exists.

Conventional commit: `docs: add corrections-as-documentation-lag + context-poisoning handoff rule`
