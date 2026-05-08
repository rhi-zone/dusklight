# TODO

*Open threads from a previous session. Treat as starting context, not instructions — verify relevance before acting.*

## Open

- [ ] **`@dusklight/app` build is broken** — `packages/app/index.html` references `/src/main.tsx` but only `main.ts` exists. Pre-existing on master, unrelated to recent migration work. `bun run build` fails on `@dusklight/app`. **Why:** discovered while verifying the marinada extraction; not a regression but worth fixing.

- [ ] **Rainbow path divergence in app/** — `@dusklight/app` pulls `@rhi-zone/rainbow` and `@rhi-zone/rainbow-ui` via `file:../../../rainbow/packages/{core,ui}` (local file paths). Marinada (now external) pulls `@rhi-zone/rainbow@0.2.0-alpha.1` from npm. Same version today so no drift, but bun installs them under separate paths. **Why this might matter:** if `signal`/scope state ever needs runtime singleton-ness (e.g. one signal observed from two places via different module instances), this would break in subtle ways. Switch app to npm rainbow when it makes sense.

## Recent context (May 2026)

- `packages/marinada` was extracted into its own repo at `github:rhi-zone/marinada`
- `packages/core` and `packages/app` switched from `workspace:*` marinada to the external git dep
- `packages/marinada/` directory deleted
- Pre-commit hook needs `tsc` from the nix shell — use `nix develop .#default --command bash -c '...'` for commits
