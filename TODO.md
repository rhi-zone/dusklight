# TODO

*Open threads from a previous session. Treat as starting context, not instructions — verify relevance before acting.*

### [ ] Marinada: reactive compilation — async effect cancellation

When a reactive computation containing `perform "Async"` re-runs due to a dep change, any in-flight async continuation from the previous run is silently abandoned. Correct for now (no Async effects in use), but needs explicit cancellation tokens before async effects are used in reactive contexts.

### [ ] Marinada: match only works on variants — no literal pattern matching

`match` in the evaluator only handles variant destructuring (evaluate.ts:1317 checks `scrutVal.kind !== "variant"`). There is no literal string/int/bool pattern matching. The pattern structure is always `[tag, binding1, binding2, ...]` — the tag is always matched as a variant tag, the rest always bound as variables. No ambiguity exists.

If literal pattern matching is needed (e.g. matching on a plain string payload), `match` needs to be extended — or use `cond` with `==` comparisons instead. The `$` prefix idea from defocus is not applicable here since Marinada's `match` is variant-only.
