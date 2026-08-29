# Maintainer guide

## Principles

- Keep the engine framework-neutral and adapters thin.
- Preserve complete cleanup: closing must restore host visibility, listeners, canvases, audio, and
  shared caches.
- Prefer graceful capability fallback over browser-specific failure.
- Treat bundle size, capture memory, frame time, accessibility, and public types as product behavior.
- Keep one active whole-page engine per document.

## Pull request review

Confirm that public behavior has documentation and a Changeset, visual changes have demo/harness
evidence, hot-path changes include benchmark context, and lifecycle changes pass the memory gate.
When a tool's gesture, effect or art changes, run `bun run demo:tools` and review the local
recorded reel — no automated check judges whether a tool still looks right.
`bun run check` is the minimum merge gate; `bun run docs:build` must also pass when documentation or
examples change.

Framework-specific behavior belongs in an adapter only when its lifecycle or rendering model requires
it. Otherwise implement it once in the core controller or engine.

## Dependency and security maintenance

Dependabot groups monthly development updates. Review lockfile changes, run `bun audit`, and avoid
adding runtime dependencies for behavior that can stay procedural. Follow [SECURITY.md](./SECURITY.md)
for private reports and coordinate advisories before public disclosure.

`vite` is pinned exactly, and force-resolved through `overrides`, because VitePress still declares
`vite@^5` while the documentation build needs a newer one; without the override the two disagree and
`bun run docs:build` fails. Dependabot will keep proposing bumps — accept one only after
`bun run docs:build` passes with it, and move the pin and the override together.

## Releases

Follow [docs/releasing.md](./docs/releasing.md). Review the generated version PR, ensure the semver bump
matches [the stability policy](./docs/versioning.md), and verify npm provenance plus the attached
registry tarball after publication.

Two traps in that pin. VitePress 1.x cannot build on vite 8: the render step calls
`transformWithEsbuild`, which vite 8 removed from its default install, and the docs build dies at
"rendering pages". And a local `bun run docs:build` can pass anyway when a stale `node_modules`
still carries `esbuild` from an earlier install — verify the bump on a clean install, or let CI do
it, because that is the environment that decides.
