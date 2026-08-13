---
"ragelayer": major
---

Remove tool loadouts and show the complete toolset everywhere. The `ragelayer/loadouts` entry point,
`BUILT_IN_LOADOUTS`, `createToolLoadout()`, `resolveToolLoadout()`, the `loadout` option on
`mountRageLayer()` / `createRageLayer()`, the `loadout` prop on the React and Vue components, and the
`loadout` attribute on `<rage-layer>` are all gone. Every toolbar now registers and shows all sixteen
built-in tools; pass a `tools` array to narrow the set. `mountRageLayer()` selects `"hammer"` when
`initialTool` is omitted, as it already did without a loadout.

Redesign the toolbar. Action buttons are single-path SVG icons drawn in `currentColor` instead of
emoji, so their idle, hover and disabled states are driven by one colour token — disabled controls
dim their ink rather than washing out the whole button, which had left undo and redo nearly
invisible. The bar, hint pill and status chip share one set of surface tokens, the selected tool
carries a tinted fill plus a dock-style accent marker, and buttons are 40px on desktop and a full
44px once the row scrolls on narrow screens. `ToolbarButton.glyph` and `ToolbarButton.fontSize` are
replaced by `ToolbarButton.iconPath`; the new `TOOLBAR_ICONS`, `toolbarIconSvg()` and
`toolbarIconElement()` exports let a host-built toolbar render the same icons.
