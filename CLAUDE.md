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

## Core Rules

**Note things down immediately — no deferral:**
- Problems, tech debt, issues → TODO.md now, in the same response
- Design decisions, key insights → docs/ or CLAUDE.md
- Future/deferred scope → TODO.md **before** writing any code, not after
- **Every observed problem → TODO.md. No exceptions.** Code comments and conversation mentions are not tracked items. If you write a TODO comment in source, the next action is to open TODO.md and write the entry.

**Conversation is not memory.** Anything said in chat evaporates at session end. If it implies future behavior change, write it to CLAUDE.md immediately — or it will not happen.

**Warning — these phrases mean something needs to be written down right now:**
- "I won't do X again" / "I'll remember to..." / "I've learned that..."
- "Next time I'll..." / "From now on I'll..."
- Any acknowledgement of a recurring error without a corresponding CLAUDE.md edit

**Triggers:** User corrects you, 2+ failed attempts, "aha" moment, framework quirk discovered → document before proceeding.

**When the user corrects you:** Ask what rule would have prevented this, and write it before proceeding. **"The rule exists, I just didn't follow it" is never the diagnosis** — a rule that doesn't prevent the failure it describes is incomplete; fix the rule, not your behavior.

**Corrections are documentation lag, not model failure.** When the same mistake recurs, the fix is writing the invariant down — not repeating the correction. Every correction that doesn't produce a CLAUDE.md edit will happen again. Exception: during active design, corrections are the work itself — don't prematurely document a design that hasn't settled yet.

**Something unexpected is a signal, not noise.** Surprising output, anomalous numbers, files containing what they shouldn't — stop and ask why before continuing. Don't accept anomalies and move on.

**Don't say these (edit first):** "Fair point", "Should have", "That should go in X" → edit the file BEFORE responding.

**Do the work properly.** When asked to analyze X, actually read X - don't synthesize from conversation. The cost of doing it right < redoing it.

**If citing CLAUDE.md after failing:** The file failed its purpose. Adjust it to actually prevent the failure.

## Behavioral Patterns

From ecosystem-wide session analysis:

- **Question scope early:** Before implementing, ask whether it belongs in this crate/module
- **Check consistency:** Look at how similar things are done elsewhere in the codebase
- **Implement fully:** No silent arbitrary caps, incomplete pagination, or unexposed trait methods
- **Name for purpose:** Avoid names that describe one consumer
- **Verify before stating:** Don't assert API behavior or codebase facts without checking

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

**Always commit completed work.** After tests pass, commit immediately — don't wait to be asked. When a plan has multiple phases, commit after each phase passes. Do not accumulate changes across phases. Uncommitted work is lost work.

## Context Management

**Use subagents to protect the main context window.** For broad exploration or mechanical multi-file work, delegate to an Explore or general-purpose subagent rather than running searches inline. The subagent returns a distilled summary; raw tool output stays out of the main context.

Rules of thumb:
- Research tasks (investigating a question, surveying patterns) → subagent; don't pollute main context with exploratory noise
- Searching >5 files or running >3 rounds of grep/read → use a subagent
- Codebase-wide analysis (architecture, patterns, cross-file survey) → always subagent
- Mechanical work across many files (applying the same change everywhere) → parallel subagents
- Single targeted lookup (one file, one symbol) → inline is fine
- **Implementation with >2 files or likely type/lint errors → subagent.** Read-edit-typecheck-fix cycles generate enormous inline noise. Delegate; get back a summary and commit hash, not raw tool output.

## Commit Convention

Use conventional commits: `type(scope): message`

Types:
- `feat` - New feature
- `fix` - Bug fix
- `refactor` - Code change that neither fixes a bug nor adds a feature
- `docs` - Documentation only
- `chore` - Maintenance (deps, CI, etc.)
- `test` - Adding or updating tests

Scope is optional but recommended for multi-crate repos.

## Negative Constraints

Do not:
- Use Claude Code's auto-memory system (`~/.claude/projects/.*./memory/`) — it is unversioned, invisible to the user, and can't be diffed or backed up. Write behavioral changes directly to CLAUDE.md instead
- Announce actions ("I will now...") - just do them
- Leave work uncommitted
- Use interactive git commands (`git add -p`, `git add -i`, `git rebase -i`) — these block on stdin and hang in non-interactive shells; stage files by name instead
- Create special cases - design to avoid them
- Create legacy APIs - one API, update all callers
- Do half measures - migrate ALL callers when adding abstraction
- Ask permission when philosophy is clear - just do it
- Replace content when editing lists - extend, don't replace
- Cut corners with fallbacks - implement properly for each case
- Mark as done prematurely - note what remains
- Fear "over-modularization" - 100 lines is fine for a module
- Consider time constraints - we're NOT short on time; optimize for correctness
- Use path dependencies in Cargo.toml - causes clippy to stash changes across repos
- Use `--no-verify` - fix the issue or fix the hook
- Assume tools are missing - check if `nix develop` is available for the right environment

## Design Principles

**Unify, don't multiply.** One interface for multiple cases > separate interfaces. Plugin systems > hardcoded switches. When user says "WTF is X" - ask: naming issue or design issue?

**Simplicity over cleverness.** Standard patterns over custom abstractions. Functions over classes until you need the class. Use ecosystem tooling over hand-rolling.

**Explicit over implicit.** Log when skipping. Show what's at stake before refusing.

**Separate niche from shared.** Don't bloat config with feature-specific data. Use separate files for specialized data.

**When stuck (2+ attempts):** Step back. Am I solving the right problem? Check docs/ before questioning design.
