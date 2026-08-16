---
"ragelayer": major
---

Rename the last `Destroyer*` public names to match the package. `DestroyerEngine` is now
`RageLayerEngine`, `DestroyerEngineApi` is `RageLayerEngineApi`, `DestroyerOptions` is
`RageLayerEngineOptions`, `DestroyerStrings` is `RageLayerStrings`, `DestroyerToolStrings` is
`RageLayerToolStrings`, and the `<rage-layer>` element property `destroyerEngine` is
`rageLayerEngine`. There are no deprecated aliases — the old names are gone, and
`bun run check:package` asserts they stay gone.

Migration is a rename in place; no behaviour, option, or DOM contract changed. Entry points
(`ragelayer/react`, …), attributes (`data-ragelayer-*`) and events (`ragelayer-close`,
`ragelayerchange`) were already correct and are untouched.

The demo toolbar also showed a stale `Destroyer` brand label; it now reads `RageLayer`, matching
every other piece of display text.
