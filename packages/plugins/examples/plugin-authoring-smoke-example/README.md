# Plugin Authoring Smoke Example

A Mercury plugin

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

## Install Into Mercury

```bash
pnpm mercuryai plugin install ./
```

## Build Options

- `pnpm build` uses esbuild presets from `@mercuryai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
