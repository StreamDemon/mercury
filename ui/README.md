# @mercuryai/ui

Published static assets for the Mercury board UI.

## What gets published

The npm package contains the production build under `dist/`. It does not ship the UI source tree or workspace-only dependencies.

## Storybook

Storybook config, stories, and fixtures live under `ui/storybook/`.

```sh
pnpm --filter @mercuryai/ui storybook
pnpm --filter @mercuryai/ui build-storybook
```

## Typical use

Install the package, then serve or copy the built files from `node_modules/@mercuryai/ui/dist`.
