# CLAUDE.md

Behavioral rules for Claude Code in this repository.

## Project

**Dusklight:** A universal UI client for arbitrary data sources. Not just read-only - includes a control plane for mutating, triggering, and interacting with the systems producing the data.

### Data Sources

Static, filesystem, network fetched/streamed, video, audio, binary, JSON, SSE, JSONL, protobuf, msgpack, etc.

### Control Plane

Dusklight is data-format agnostic, and so is its control plane. You can:
- View data from any source
- Trigger actions on the system producing the data
- Mutate state through the same protocol
- Monitor multiple systems in unified views

This makes Dusklight the "Project Hub" for RHI - viewing world state, triggering extractions, monitoring pipelines, all through format-agnostic adapters.

### Expression Language

**Marinada** (`packages/marinada`) is the core expression language and reactive computation model for Dusklight. It is not a utility library — it is the engine that powers all dynamic layout properties, data traversals, and optic bindings. Read `docs/marinada.md` before forming any opinion about it.

Key facts to anchor a new session:
- Expressions are JSON arrays (s-expressions as data); no custom parser
- Two backends: JS JIT (browser, owns reactive graph) and Rust/WASM (binary/heavy computation)
- Algebraic effects, linear types, discriminated unions — all **intentional spec features**, not overengineering
- `lib:std` (map, filter, reduce, option, result, etc.) is implemented as ordinary Marinada expressions, not hardcoded primitives
- `LayoutOptic` in `core/src/types.ts` is an `Expr` that evaluates to a Lens or Traversal at runtime

## Behavioral Patterns

From ecosystem-wide session analysis:

- **Question scope early:** Before implementing, ask whether it belongs in this crate/module
- **Check consistency:** Look at how similar things are done elsewhere in the codebase
- **Implement fully:** No silent arbitrary caps, incomplete pagination, or unexposed trait methods
- **Name for purpose:** Avoid names that describe one consumer

## Workflow

**Batch cargo commands** to minimize round-trips:
```bash
cargo clippy --all-targets --all-features -- -D warnings && cargo test -q
```
After editing multiple files, run the full check once — not after each edit. Formatting is handled automatically by the pre-commit hook (`cargo fmt`).

**Prefer `cargo test -q`** over `cargo test` — quiet mode only prints failures, significantly reducing output noise and context usage.

**When making the same change across multiple crates**, edit all files first, then build once.

**Minimize file churn.** When editing a file, read it once, plan all changes, and apply them in one pass. Avoid read-edit-build-fail-read-fix cycles by thinking through the complete change before starting.

**`normalize view` is available** for structural outlines of files and directories:
```bash
~/git/rhizone/normalize/target/debug/normalize view <file>    # outline with line numbers
~/git/rhizone/normalize/target/debug/normalize view <dir>     # directory structure
```

## Commit Convention

Use conventional commits: `type(scope): message`

Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`. Scope is optional but recommended for multi-crate repos.

## Hard Constraints

- No `--no-verify`. Fix the issue or fix the hook.
- No path dependencies in `Cargo.toml` — they couple repos and break independent publishing.
- No interactive git (`git add -p`, `git add -i`, `git rebase -i`) — these block on stdin and hang.
- No assuming a tool is missing without checking `nix develop`.
- No special cases — design to avoid them.
- No legacy APIs — one API, update all callers.
- No half measures — migrate ALL callers when adding abstraction.
- No premature "done" — note what remains.

<!-- BEGIN ECOSYSTEM RULES -->

## Ecosystem Design Principles

Cross-cutting principles distilled from the ecosystem's own decisions (synthesized in `docs/decisions/throughlines.md`). Apply them when building new repos and recording decisions. (Already-encoded principles — independent-tools / no-path-deps, the delegation model, CLAUDE.md-as-control-surface — live in their own sections and are not repeated here.)

- **Prefer data over code at every seam.** Serializable AST / struct / JSON over closures, embedded DSLs, or source text — so artifacts cache, replay, transport, and diff.
- **Library-first; projection-from-one-definition.** The typed library is the source of truth; CLI / HTTP / MCP / WebSocket / JSON surfaces are generated projections, never hand-rolled per surface.
- **Capability security.** Hosts grant pre-opened handles; code only attenuates what it is given; nothing forges authority; allow-list over deny-list.
- **The LLM is an oracle at the leaves, never the control loop.** Determinism is a hard invariant: seeded RNG, event-log replay, build-time-only inference. Per-query LLM in the hot loop is a defect.
- **Trust comes from verifiable evidence, not authority.** Verbatim snippets, pinned-commit permalinks, claim→node citation — never a bare reference.
- **Retire, don't deprecate; collapse asymmetries to primitives.** Remove backward-compat aliases rather than carry them; reduce N special cases to their irreducible primitives.
- **Validate against reality; tests are the spec.** Load-bearing substrates are validated against real corpora; fixtures and tests define correctness, not aspirational specs.

## Hard Constraints

- No `--no-verify`. Fix the issue or fix the hook.
- No path dependencies in `Cargo.toml` — they couple repos and break independent publishing.
- No interactive git (no `git rebase -i`, no `git add -i`, no `--no-edit` on rebase).
- No suggesting project names. LLMs are bad at this; refine the conceptual space only.
- No tracking cross-project issues in conversation — they go in TODO.md in the affected repo.
- No ecosystem changes without checking all affected repos.
- No assuming a tool is missing without checking `nix develop`.
- Commit completed work in the same turn it finishes. Uncommitted work is lost work.

## Meta

- Something unexpected is a signal. Stop and find out why. Do not accept the anomaly and proceed.
- Corrections from the user are conversation, not material for new rules. Rules are added when a failure mode is observed repeatedly.

<!-- END ECOSYSTEM RULES -->
