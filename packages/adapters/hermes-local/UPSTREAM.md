# Upstream attribution

Vendored from [HenkDz/hermes-paperclip-adapter](https://github.com/HenkDz/hermes-paperclip-adapter) (npm: `@henkey/hermes-paperclip-adapter@0.4.3`) on 2026-05-06.

The original code was authored by Nous Research as `hermes-paperclip-adapter` (see `LICENSE`); HenkDz maintains the active fork that we now track. Mercury uses the upstream codebase with a paperclip→mercury rename pass and a swap from the upstream `@paperclipai/adapter-utils` (npm) to our workspace `@mercuryai/adapter-utils`.

## Re-sync procedure
1. Clone upstream: `git clone https://github.com/HenkDz/hermes-paperclip-adapter /tmp/upstream-hermes`
2. Diff its `src/` against `packages/adapters/hermes-local/src/`.
3. Apply changes preserving:
   - The `@mercuryai/adapter-hermes` package name (in `package.json`).
   - The `paperclip → mercury` rename pass — see "Rename pass" below.
   - The dep swap: upstream `@paperclipai/adapter-utils` → workspace `@mercuryai/adapter-utils`.
   - The Mercury-specific patches in `src/server/execute.ts` (search for `processGroupId` — Mercury's `RunningProcess` and `onSpawn` callbacks require that field, the upstream interface doesn't pass it).
4. Bump the `version` in `package.json` to match upstream.
5. Update this file with the new sync date.

## Rename pass

Apply across `src/` (sed-style):

```sh
find packages/adapters/hermes-local/src -type f -exec sed -i \
  -e 's/@paperclipai\/adapter-utils/@mercuryai\/adapter-utils/g' \
  -e 's/paperclipApiUrl/mercuryApiUrl/g' \
  -e 's/PAPERCLIP_API_KEY/MERCURY_API_KEY/g' \
  -e 's/PAPERCLIP_API_URL/MERCURY_API_URL/g' \
  -e 's/PAPERCLIP_RUN_ID/MERCURY_RUN_ID/g' \
  -e 's/X-Paperclip-Run-Id/X-Mercury-Run-Id/g' \
  -e 's/buildPaperclipEnv/buildMercuryEnv/g' \
  -e 's/paperclip_required/mercury_required/g' \
  -e 's/\[paperclip\]/[mercury]/g' \
  -e 's/pclip_/mercury_/g' \
  -e 's/Paperclip/Mercury/g' \
  -e 's/paperclip/mercury/g' \
  -e 's/PAPERCLIP/MERCURY/g' \
  {} +
```

Verify with `grep -rni "paperclip\|pclip" packages/adapters/hermes-local/src` — should be empty after the pass. Any remaining hits indicate a missed substitution and likely a runtime wire-protocol bug (Mercury sends `mercuryApiUrl` over the API; the adapter must read the same field name).

## Why src/ is committed (not just dist/)

This package now follows Mercury's standard workspace adapter pattern: `exports` in `package.json` point to `./src/*.ts`, transpiled on the fly by tsx (server/cli) and Vite (UI). `dist/` is build output for the `publishConfig` exports map (npm publish path) and is gitignored at the repo root. Earlier vendors of this package (Nous 0.2.0) were dist-only because the upstream npm tarball did not ship source; HenkDz's fork ships source, so Mercury can use it the same way as the other adapters.
