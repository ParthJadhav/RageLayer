# Contributing

## Setup

```sh
bun install
bun run build      # tsdown → dist/
bun run check      # typecheck + lint + tests + build + package checks — CI runs the same
```

Toolchain: [Bun](https://bun.sh) (runtime + tests), [tsdown](https://tsdown.dev) (Rolldown
build), [Biome](https://biomejs.dev) (lint + format), publint + arethetypeswrong (package
correctness), [Changesets](https://github.com/changesets/changesets) (versioning).

## Working on the engine

```sh
bun run dev                 # rebuild on change
python3 -m http.server 8917 # serve the repo root…
# …then open http://localhost:8917/demo/  (the destructible demo page)
```

Manual harnesses (also served from the repo root, build first):

- `/harness.html` — surface-shader invariants (bit-identical undamaged raster, exact silhouette)
- `/harness-debris.html` — fracture + physics
- `/harness-toolart.html` — drawn tool art

Browser rules: primary target is Chrome. Runtime verification (benchmarks, screenshots,
harnesses) is driven through headless Chrome via CDP — set `DD_CHROME_PATH` if Chrome isn't in
the default location.

## Before you push

```sh
bun run check              # everything CI checks
bun run benchmark          # if you touched the runtime hot paths
bun run memory:check       # if you touched lifecycle/dispose paths
bun run screenshots        # if you changed anything visual — docs screenshots regenerate
```

## Releasing

Every user-facing change lands with a changeset:

```sh
bun run changeset          # pick patch/minor/major, describe the change
```

On push to `main`, the release workflow opens/updates a **Version Packages** PR. Merging it
tags `vX.Y.Z`, creates a GitHub Release with the changelog and an installable tarball, and
publishes to npm when the `NPM_TOKEN` secret is configured.
