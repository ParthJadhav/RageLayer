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
`bun run check` is the minimum merge gate; `bun run docs:build` must also pass when documentation or
examples change.

Framework-specific behavior belongs in an adapter only when its lifecycle or rendering model requires
it. Otherwise implement it once in the core controller or engine.

## Dependency and security maintenance

Dependabot groups monthly development updates. Review lockfile changes, run `bun audit`, and avoid
adding runtime dependencies for behavior that can stay procedural. Follow [SECURITY.md](./SECURITY.md)
for private reports and coordinate advisories before public disclosure.

## Releases

Follow [docs/releasing.md](./docs/releasing.md). Review the generated version PR, ensure the semver bump
matches [the stability policy](./docs/versioning.md), and verify npm provenance plus the attached
registry tarball after publication.
