---
"ragelayer": major
---

Remove keyboard aiming and the whole-page collapse

Two toolbar actions are gone, along with everything behind them.

**The collapse action.** The `X` shortcut, the toolbar button, `engine.collapse()`, the
element-by-element fall queue, and the `collapseMs` field of `PerformanceFrameBreakdown`.
`harvestElements` still measures the page — `engine.demolish(x, y)` continues to knock individual
elements loose, and `elementsInBand()` is still exported if you want to drive a wave yourself.

**Keyboard aiming.** The `A` shortcut, the crosshair button, the arrow/`Enter`/`Esc` handling, the
on-canvas reticle, `engine.setAim()`, `engine.aim`, `ToolbarModel.startAiming()`/`stopAiming()`/
`moveAim()`/`strikeAtAim()`, the `aimStep` and `strikeHoldMs` model options, `ToolbarState.aim`,
`ToolbarState.announcement` and its live region, and the `keyboardCursor`, `keyboardCursorHint`,
`keyboardMoved` and `keyboardStruck` strings.

### Accessibility impact — please read

Aiming mode was how a visitor without a pointing device actually *used* a tool. The toolbar remains
fully keyboard-operable, but the canvas is a pointer surface and now has no built-in keyboard route:
a keyboard-only visitor can select the hammer and not swing it.

`engine.strike(x, y, { holdMs })` is unchanged and still public. It runs the same `onDown`/`onUp`
pair a click produces and takes a history checkpoint, so a host that needs keyboard operation can
rebuild it — supplying the cursor, the key handling, and the live region itself. Treat RageLayer as
strictly optional decoration and keep real content and controls out from behind it.

### Migration

- `engine.collapse()` — no replacement. Call `engine.demolish(x, y)` per element, or
  `engine.fracture(x, y, r, { power })` across the viewport.
- `engine.setAim()` / `engine.aim` — track the cursor in your own state and draw it yourself.
- `model.strikeAtAim()` — call `engine.strike(x, y, { holdMs: 260 })` with your own coordinates.
- `state.aim` / `state.announcement` — removed from `ToolbarState`; own them in the host.
- Custom `strings` objects: the four `keyboard*` keys and `collapse` are no longer read.
  `Partial<RageLayerStrings>` will now reject them as unknown properties.
- `TOOLBAR_ICONS` no longer has `aim` or `collapse` entries, and `ToolbarIconName` no longer
  includes those names.
- `PerformanceFrameBreakdown.collapseMs` — removed; the time it measured no longer exists.

`formatString` is still exported, though no built-in string carries a placeholder now.
