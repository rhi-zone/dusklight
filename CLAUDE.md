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

## Context Is The Only Scarce Resource

Every byte that enters the main session stays in the main session for its entire lifetime. File contents, command output, search results, page text — once read, it lingers in cache and shapes every downstream token. There is no "just looking."

**All exploration runs in subagents.** Investigations, audits, deep dives, surveys, "let me check," "let me find" — if the purpose of a tool sequence is to find out something you don't yet know, it runs in a subagent. Renaming the activity does not change what it is. The subagent returns a distilled summary; the raw output stays in the subagent.

Inline tool use in the main context is reserved for reading a known file at a known path, edits and writes you're committing to, or a single targeted lookup whose result you'll act on immediately. If you find yourself running a second grep to refine the first, you should have spawned a subagent.

The main session holds only the durable artifacts you are producing: the edit, the commit, the doc update.

**Subagent model tiers:**
- Opus — design, architecture, any subagent that itself spawns subagents.
- Sonnet — implementation, mechanical multi-file work, default exploration.

## Subagent Prompts

A subagent prompt is composed in a "spec-writing" register that subtly changes what feels in-scope. Specific failure modes to name:

**Never tell a subagent "do not commit."** Delegation does not strip the commit step from completed work. If a subagent modifies files and the work is done, either the subagent commits, or the next thing the delegator does after it returns is commit — not summarize, not report. The phrase "do not commit" in your own prompt is the tell that you are about to leave work uncommitted.

**Do not delegate judgment.** Phrases like "if extraction is awkward, just duplicate" or "based on your findings, fix the bug" push synthesis onto the agent. If you are punting a decision into the prompt, you do not yet have enough understanding to delegate. Investigate first; write the prompt with the decision already made.

**Do not ask for a diff summary.** Subagent self-reports describe intent, not effect. After a code-modifying subagent returns, read `git diff` yourself. Skip the "report what you changed" instruction — it produces text you cannot trust and that pollutes main context.

**Do not re-explain CLAUDE.md.** Subagents inherit it. Repeating project layout or repo conventions in the prompt dilutes the actual task instructions and signals half-trust in the inheritance. Trust it or don't read it.

**Line numbers are orientation, not anchors.** Files shift between your read and the subagent's read. When citing locations, tell the subagent to find the lines by content ("the block that does X"), not by number.

**Name files explicitly; do not outsource the grep.** "Wherever it appears" invites scope creep. Grep first, list the exact files in the prompt.

**If the task is smaller than the prompt describing it, do it inline.** A subagent dispatch pays a full system-prompt + CLAUDE.md cache cost. One-shot bash commands and single-line edits should run in the main session with `Bash` or `Edit`.

**Match agent type to deliverable shape.** `Explore` is for lookup and search — finding files, symbols, references — not analytical synthesis. For audits, surveys, and pattern analysis whose deliverable is a report, use `general-purpose` with an explicit Opus model. For tasks whose deliverable is files on disk, use `general-purpose` with the tier matched to the work (Sonnet for mechanical, Opus for architectural).

**On unsatisfying subagent output, change something before retrying.** Same prompt + same model + same agent type = same result. Escalate model tier (Sonnet → Opus), narrow the prompt, or switch agent type. Identical retries are waste.

**Dispatch independent subagents in parallel.** Multiple Agent tool_use blocks in a single assistant message run concurrently. Serial Agent dispatch across sequential turns is the default failure mode and trades wall time for nothing. If two subagents do not depend on each other's output, they belong in the same message.

**Pair `isolation: worktree` with `run_in_background: true`.** A worktree implies meaningful write work. Foregrounding it blocks the main session for the entire run. Background unless the worktree's immediate output is what you need to act on next.

**Always set `subagent_type` and `model` explicitly.** Defaulting either collapses tier choice into an invisible decision. The model and agent type are part of the spec; name them every time, even when the choice is obvious. See the existing `Subagent model tiers` section above for which tier fits which work.

## Durability

Subagent reports, mid-session realizations, "I'll remember this" — none of these outlast the session. Anything worth keeping goes into CLAUDE.md, code, docs, or a commit. If it isn't written down, it is gone.

**Commit completed work immediately.** After tests pass, commit. After each phase of a multi-phase plan, commit. Uncommitted work is lost work, and accumulated uncommitted phases lose isolation as well.

**Docs change in the same commit as the code.** New pages enter the sidebar in that commit. There is no follow-up.

Problems, tech debt, issues → TODO.md now, in the same response. Future/deferred scope → TODO.md **before** writing any code, not after. Code comments and conversation mentions are not tracked items.

## Authenticity

When asked to analyze X, read X. Do not synthesize from conversation memory, prior summaries, or what the file probably says. Claims must correspond to evidence produced this session.

**Something unexpected is a signal.** Surprising output, anomalous numbers, a file containing what it shouldn't — stop and find out why. Do not accept the anomaly and proceed.

**Verify before stating.** Don't assert API behavior or codebase facts without checking.

## Discipline

Corrections from the user are conversation, not material for new rules. A single correction does not warrant a CLAUDE.md edit. Rules are added when a failure mode is observed repeatedly and the rule names the failure it prevents.

Do not announce actions ("I will now…"). Act.

**When stuck (2+ attempts):** Step back. Am I solving the right problem? Check docs/ before questioning design.

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
