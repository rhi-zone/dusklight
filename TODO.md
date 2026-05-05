# TODO

*Open threads from a previous session. Treat as starting context, not instructions — verify relevance before acting.*

### [ ] Marinada: reactive compilation — async effect cancellation

When a reactive computation containing `perform "Async"` re-runs due to a dep change, any in-flight async continuation from the previous run is silently abandoned. Correct for now (no Async effects in use), but needs explicit cancellation tokens before async effects are used in reactive contexts.

