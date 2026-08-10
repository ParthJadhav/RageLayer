---
"desktop-destroyer": minor
---

Add a ready-made toolbar for every stack, keyboard-operable tools, translatable strings, and a
channel for reporting degradation.

- `desktop-destroyer/element` registers `<desktop-destroyer>`, a complete toolbar in a shadow root
  that works unchanged in Svelte, Angular, Solid, Qwik, Astro and plain HTML. `/vue` now exports a
  `DesktopDestroyer` component alongside the composable. Both, and the React component, render one
  shared `ToolbarModel`, published as `desktop-destroyer/toolbar` for hosts building their own UI.
- Keyboard aiming makes the tools reachable without a pointer: `A` places a cursor on the page,
  arrows steer it, `Enter` uses the tool, and moves and strikes are announced. The underlying
  `engine.strike(x, y, { holdMs })` and `engine.setAim()` are public, and a keyboard blow is
  undoable like any other. Custom tools need no changes to be reachable this way.
- Every user-visible string, including tool names and hints, can be replaced through `strings`, so
  the toy can be translated or reworded. `DEFAULT_STRINGS` and `resolveStrings()` are exported.
- `onError` (option, `engine.onError()`, `engine.error` and an `"error"` event) reports the
  failures that were previously only a `console.warn`: capture failure, live-capture fallback,
  element-harvest failure, a missing text mask, and page-height truncation. Registering a handler
  silences the matching warning so nothing is logged twice.
- `engine.historyEnabled` distinguishes "undo is on" from "there is something to undo", so a
  toolbar can show its undo controls from the start instead of having them appear mid-session.
