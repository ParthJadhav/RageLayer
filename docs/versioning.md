# Versioning and API stability

RageLayer follows semantic versioning and uses Changesets to record release intent.

## Public API

The supported public surface is everything reachable through the documented package exports:

- `ragelayer`
- `ragelayer/react`
- `ragelayer/vue`
- `ragelayer/svelte`
- `ragelayer/package.json`

Files under `src/`, generated chunk filenames under `dist/`, DOM nodes/classes beginning with `rl-`,
and debugging globals are implementation details unless explicitly documented. Do not import generated
files by relative path from `node_modules`.

## Change policy

- **Patch:** compatible fixes, performance improvements, documentation, and new optional behavior.
- **Minor:** additive APIs, tools, adapter capabilities, and opt-in behavior changes.
- **Major:** removals, renamed exports, incompatible type changes, or materially different defaults.

Before removing a practical API, maintainers should deprecate it in types and documentation for at
least one minor release when feasible. Security, privacy, or platform changes may require faster
removal and will be called out prominently.

The engine is still pre-1.0, so minor releases may contain carefully documented behavior changes.
Public exports nevertheless receive compatibility tests under both TypeScript bundler and Node16
resolution modes.

## Reading releases

Every user-visible pull request carries a Changeset. The generated [changelog](https://github.com/ParthJadhav/ragelayer/blob/main/CHANGELOG.md)
and GitHub Release describe migration requirements. npm packages are published from tagged commits
with provenance, and their registry tarball is attached to the matching GitHub Release.
