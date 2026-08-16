# Versioning and API stability

RageLayer follows semantic versioning and uses Changesets to record release intent.

## Public API

The supported public surface is everything reachable through the documented package exports. Every
entry in `exports` is covered by this policy — there are no "internal" published entry points:

| Entry | Surface |
| --- | --- |
| `ragelayer` | Engine, lifecycle helpers, built-in tools, types, and low-level primitives |
| `ragelayer/engine` | `RageLayerEngine` and public contracts, without built-in tool models |
| `ragelayer/tools` | The seven base tools |
| `ragelayer/tools/heavy` | The five heavy tools |
| `ragelayer/tools/advanced` | The four advanced tools |
| `ragelayer/lazy` | On-demand toolset loaders |
| `ragelayer/sdk` | `defineTool()`, `createTool()`, rate limiter, icon metadata |
| `ragelayer/react` | `RageLayer`, `useRageLayer` |
| `ragelayer/vue` | `RageLayer`, `useRageLayer` |
| `ragelayer/svelte` | `rageLayer`, `createRageLayer` |
| `ragelayer/element` | `<rage-layer>`, `RageLayerElement`, `defineRageLayerElement` |
| `ragelayer/toolbar` | `ToolbarModel`, `DEFAULT_STRINGS`, `resolveStrings` |
| `ragelayer/package.json` | Manifest access for tooling |

The following are **not** public and may change in any release:

- files under `src/`, and generated chunk filenames under `dist/`;
- DOM nodes, classes, and ids beginning with `rl-`;
- the `window.__rageLayer` debugging global (opt-in via `debugGlobal`);
- anything reached by importing a relative path inside `node_modules/ragelayer`.

The stable DOM contracts are the `<rage-layer>` tag and its attributes, the `data-ragelayer-*`
attributes, and the `ragelayer-close` / `ragelayerchange` events. These stay case-stable across
releases.

## Change policy

- **Patch:** compatible fixes, performance improvements, documentation, and new optional behavior.
- **Minor:** additive APIs, tools, adapter capabilities, and opt-in behavior changes.
- **Major:** removals, renamed exports, incompatible type changes, or materially different defaults.

Before removing a practical API, maintainers should deprecate it in types and documentation for at
least one minor release when feasible. Security, privacy, or platform changes may require faster
removal and will be called out prominently.

From 1.0.0 onward the entry points above are covered by semantic versioning: a breaking change to any
of them requires a major release and a documented migration. Public exports receive compatibility
tests under both TypeScript bundler and Node16 resolution modes, and `bun run check:package` asserts
that removed APIs stay removed.

## Reading releases

Every user-visible pull request carries a Changeset. The generated [changelog](https://github.com/ParthJadhav/RageLayer/blob/main/CHANGELOG.md)
and GitHub Release describe migration requirements. npm packages are published from tagged commits
with provenance, and their registry tarball is attached to the matching GitHub Release.
