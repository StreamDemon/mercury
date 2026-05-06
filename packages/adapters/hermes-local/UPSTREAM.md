# Upstream attribution

Vendored from https://github.com/NousResearch/hermes-paperclip-adapter (npm: hermes-paperclip-adapter@0.2.0) on 2026-05-04 during the Paperclip → Mercury rebrand.

## Re-sync procedure
1. Clone upstream: `git clone https://github.com/NousResearch/hermes-paperclip-adapter /tmp/upstream-hermes`
2. Diff its source against this directory.
3. Apply changes preserving the `@mercuryai/adapter-hermes` package name and the paperclip→mercury identifier rename pass.
4. Strip sourcemap noise from the vendored output:
   - `find packages/adapters/hermes-local/dist -name "*.map" -delete`
   - Strip the `//# sourceMappingURL=...` trailing line from every `.js` and `.d.ts`:
     `find packages/adapters/hermes-local/dist -type f \( -name "*.js" -o -name "*.d.ts" \) -exec sed -i '/^\/\/# sourceMappingURL=/d' {} +`
   - Without this, Vite warns at dev time about sourcemaps that point at a `src/` directory we don't ship.
5. Bump version here to match upstream.
6. Update this file with the new sync date.

## Why dist is committed
This package is a vendored copy of an `npm pack` tarball — there is no `src/` to build from. The repo-root `.gitignore` has a global `dist/` rule that would normally hide all build output; an explicit negation (`!packages/adapters/hermes-local/dist/`) keeps this one tracked. If you ever fall back to building from source upstream, remove the negation and add a `src/` instead.
