# Contributing

Thanks for helping improve RageLayer. For usage questions, start in
[GitHub Discussions](https://github.com/ParthJadhav/RageLayer/discussions); use an issue for
a reproducible defect or a scoped feature proposal. Participation is covered by the
[code of conduct](./CODE_OF_CONDUCT.md).

## Setup

```sh
bun install
bun run build      # tsdown → dist/
bun run check      # typecheck + lint + tests + build + package checks — CI runs the same
bun run docs:dev   # documentation site at a local URL
bun run audit      # dependency advisory check
```

Use the Node version in `.nvmrc` (22): tsdown, which produces `dist/`, requires Node 22 or newer.
That is a contributor requirement only — the published package supports Node 20+, which is what
`engines` in `package.json` declares and what CI verifies on 20, 22, and 24.

Toolchain: [Bun](https://bun.sh) (runtime + tests), [tsdown](https://tsdown.dev) (Rolldown
build), [Biome](https://biomejs.dev) (lint + format), publint + arethetypeswrong (package
correctness), [VitePress](https://vitepress.dev) (documentation), and
[Changesets](https://github.com/changesets/changesets) (versioning).

## Project layout

| Path | Purpose |
| --- | --- |
| `src/` | Framework-neutral engine and rendering primitives |
| `src/react`, `src/vue`, `src/svelte` | Thin framework bindings; keep engine behavior in core |
| `tests/` | Fast unit tests run by Bun |
| `demo/` | Vanilla integration and live GitHub Pages demo |
| `docs/` | VitePress guides and reference |
| `harness*.html` | Focused browser/visual diagnostics |
| `benchmarks/` and `scripts/` | Chrome performance, memory, screenshot, and docs tooling |

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
harnesses) is driven through headless Chrome via CDP — set `RAGELAYER_CHROME_PATH` if Chrome isn't in
the default location.

## Before you push

```sh
bun run check              # everything CI checks
bun run test:browser       # if behavior depends on capture, WebGL, or real layout
bun run test:tools:visual  # if a tool's gesture, effect, or art changed
bun run benchmark          # if you touched the runtime hot paths
bun run profile:effects:low-end # if you touched rendering or particle emission
bun run memory:check       # if you touched lifecycle/dispose paths
bun run screenshots        # if you changed anything visual — docs screenshots regenerate
```

For performance comparisons, fix the quality tier, DPR, CPU throttle, duration, viewport, and
Chrome build. Run each side at least three times; do not keep an optimization whose result is within
run-to-run noise. See the [performance guide](./docs/performance.md#isolate-one-effect) for profiler
flags and artifact locations.

Please keep framework adapters thin. A behavior that can live in `src/mount.ts` or the engine should
not be reimplemented independently in React, Vue, and Svelte. New public APIs need types, docs, and
a Changeset. Package checks compile consumer fixtures under bundler and Node16 module resolution and
enforce per-entry gzip budgets; raise a budget only with a written justification.

## Releasing

Every user-facing change lands with a changeset:

```sh
bun run changeset          # pick patch/minor/major, describe the change
```

On push to `main`, the release workflow opens or updates a **chore: version packages** PR. Merging
it publishes to npm, tags `vX.Y.Z`, creates a GitHub Release, and attaches an installable tarball.
Maintainer setup and recovery steps are in the [release guide](./docs/releasing.md).
