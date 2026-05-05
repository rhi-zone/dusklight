# TODO

*Open threads from a previous session. Treat as starting context, not instructions — verify relevance before acting.*

### [ ] Marinada: effect-aware reactivity (Solid.js integration)

The JIT throws `CompileError` on `perform`/`handle` (jit.ts:1188-1191), forcing all effectful code to the interpreter. The spec promises reactive compilation: expressions compile to Solid.js signals, dependencies are tracked, only affected expressions re-evaluate. Unimplemented — requires a separate reactive code generator that emits `createMemo`/`createSignal` wiring. Largest remaining architectural gap. Needs a planning session before any implementation.

### [ ] Marinada: match only works on variants — no literal pattern matching

`match` in the evaluator only handles variant destructuring (evaluate.ts:1317 checks `scrutVal.kind !== "variant"`). There is no literal string/int/bool pattern matching. The pattern structure is always `[tag, binding1, binding2, ...]` — the tag is always matched as a variant tag, the rest always bound as variables. No ambiguity exists.

If literal pattern matching is needed (e.g. matching on a plain string payload), `match` needs to be extended — or use `cond` with `==` comparisons instead. The `$` prefix idea from defocus is not applicable here since Marinada's `match` is variant-only.
